'use strict';

const vscode = require('vscode');
const { WebSocketServer } = require('ws');

const SCHEME = 'powerfx';
const SEND_DEBOUNCE_MS = 150;
// While the user types in VS Code, ignore formula updates coming back from Studio for this long.
const LOCAL_EDIT_GRACE_MS = 1500;

/**
 * In-memory file system: one file per control/property, e.g. powerfx:/Button1/Button1.OnSelect.fx
 * mtime is never bumped on remote updates so VS Code never shows "file is newer" save conflicts.
 */
class FormulaFS {
  constructor() {
    this.files = new Map(); // path -> { data, ctime, mtime }
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this._emitter.event;
  }

  setText(uri, text) {
    const prev = this.files.get(uri.path);
    const now = Date.now();
    this.files.set(uri.path, {
      data: Buffer.from(text, 'utf8'),
      ctime: prev ? prev.ctime : now,
      mtime: prev ? prev.mtime : now,
    });
  }

  watch() {
    return new vscode.Disposable(() => {});
  }

  stat(uri) {
    const f = this.files.get(uri.path);
    if (f) return { type: vscode.FileType.File, ctime: f.ctime, mtime: f.mtime, size: f.data.length };
    const prefix = uri.path.endsWith('/') ? uri.path : uri.path + '/';
    if (uri.path === '/' || [...this.files.keys()].some((k) => k.startsWith(prefix))) {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  readDirectory(uri) {
    const prefix = uri.path.endsWith('/') ? uri.path : uri.path + '/';
    const out = new Map();
    for (const k of this.files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const [head, ...tail] = k.slice(prefix.length).split('/');
      out.set(head, tail.length ? vscode.FileType.Directory : vscode.FileType.File);
    }
    return [...out];
  }

  createDirectory() {}

  readFile(uri) {
    const f = this.files.get(uri.path);
    if (!f) throw vscode.FileSystemError.FileNotFound(uri);
    return f.data;
  }

  writeFile(uri, content) {
    const prev = this.files.get(uri.path);
    const now = Date.now();
    this.files.set(uri.path, { data: Buffer.from(content), ctime: prev ? prev.ctime : now, mtime: now });
  }

  delete(uri) {
    this.files.delete(uri.path);
  }

  rename() {
    throw vscode.FileSystemError.NoPermissions('Rename is not supported');
  }
}

const fsProvider = new FormulaFS();
const meta = new Map(); // uri string -> { control, property }
const remoteText = new Map(); // uri string -> text both sides last agreed on
const lastLocalEdit = new Map(); // uri string -> timestamp
const pendingSends = new Map(); // uri string -> timeout handle

let server = null;
const clients = new Set();
let activeClient = null;
let current = null; // { control, property, uri }
let statusItem;
let output;

function log(message) {
  output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function config() {
  return vscode.workspace.getConfiguration('powerappsBridge');
}

function sanitize(s) {
  return String(s || 'Unknown').replace(/[\/\\:*?"<>|]/g, '_').trim() || 'Unknown';
}

function formulaUri(control, property) {
  const c = sanitize(control);
  const p = sanitize(property);
  return vscode.Uri.from({ scheme: SCHEME, path: `/${c}/${c}.${p}.fx` });
}

function openClients() {
  return [...clients].filter((c) => c.readyState === 1);
}

function updateStatus() {
  if (!statusItem) return;
  const connected = openClients().length > 0;
  if (!server) {
    statusItem.text = '$(circle-slash) Power Apps';
    statusItem.tooltip = 'Power Apps Bridge: server stopped';
  } else if (!connected) {
    statusItem.text = '$(debug-disconnect) Power Apps';
    statusItem.tooltip = 'Power Apps Bridge: waiting for the browser extension';
  } else {
    statusItem.text = current ? `$(plug) ${current.control}.${current.property}` : '$(plug) Power Apps';
    statusItem.tooltip = 'Power Apps Bridge: connected';
  }
  if (!config().get('followSelection', true)) statusItem.text += ' $(eye-closed)';
}

function isAllowedOrigin(origin) {
  // Only browser extensions may connect: web pages cannot forge the Origin header.
  return typeof origin === 'string' && /^(chrome-extension|moz-extension):\/\//.test(origin);
}

function startServer() {
  stopServer();
  const port = config().get('port', 8765);
  server = new WebSocketServer({
    host: '127.0.0.1',
    port,
    verifyClient: (info) => {
      const ok = isAllowedOrigin(info.origin);
      if (!ok) log(`Rejected connection from origin "${info.origin}"`);
      return ok;
    },
  });
  server.on('listening', () => {
    log(`Listening on ws://127.0.0.1:${port}`);
    updateStatus();
  });
  server.on('error', (err) => {
    log(`Server error: ${err.message}`);
    vscode.window.showErrorMessage(`Power Apps Bridge: cannot listen on port ${port} (${err.message})`);
  });
  server.on('connection', (ws) => {
    clients.add(ws);
    log('Browser extension connected');
    updateStatus();
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      handleMessage(ws, msg).catch((e) => log(`Error handling ${msg.type}: ${e.stack || e}`));
    });
    ws.on('close', () => {
      clients.delete(ws);
      if (activeClient === ws) activeClient = null;
      log('Browser extension disconnected');
      updateStatus();
    });
  });
}

function stopServer() {
  if (!server) return;
  for (const c of clients) c.terminate();
  clients.clear();
  activeClient = null;
  server.close();
  server = null;
  updateStatus();
}

async function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'hello':
      log(`Hello from browser extension v${msg.version || '?'}`);
      break;
    case 'selection':
      activeClient = ws;
      await onSelection(msg);
      break;
    case 'formula':
      activeClient = ws;
      await onRemoteFormula(msg);
      break;
    case 'result':
      if (!msg.ok) {
        log(`Studio refused the edit: ${msg.error}`);
        vscode.window.setStatusBarMessage(`$(warning) Power Apps: ${msg.error}`, 6000);
      }
      break;
    case 'log':
      log(`[browser] ${msg.message}`);
      break;
    default:
      break;
  }
}

function remember(msg) {
  const uri = formulaUri(msg.control, msg.property);
  meta.set(uri.toString(), { control: msg.control, property: msg.property });
  return uri;
}

async function onSelection(msg) {
  const uri = remember(msg);
  current = { control: msg.control, property: msg.property, uri };
  updateStatus();
  log(`Selected ${msg.control}.${msg.property} (${msg.mode || '?'})`);
  const text = msg.formula ?? '';
  await applyRemote(uri, text);
  if (config().get('followSelection', true)) {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    await applyRemote(uri, text); // the document may have been cached with stale text
  }
}

async function onRemoteFormula(msg) {
  const uri = remember(msg);
  await applyRemote(uri, msg.formula ?? '');
}

/** Push text coming from Studio into the in-memory FS and into the open document, if any. */
async function applyRemote(uri, text) {
  const key = uri.toString();
  remoteText.set(key, text);
  fsProvider.setText(uri, text);
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  if (!doc || doc.getText() === text) return;
  if (pendingSends.has(key) || Date.now() - (lastLocalEdit.get(key) || 0) < LOCAL_EDIT_GRACE_MS) return;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0)), text);
  await vscode.workspace.applyEdit(edit);
  if (doc.isDirty) await doc.save();
}

function onLocalChange(e) {
  const doc = e.document;
  if (doc.uri.scheme !== SCHEME || e.contentChanges.length === 0) return;
  const key = doc.uri.toString();
  if (doc.getText() === remoteText.get(key)) return; // echo of a remote update
  lastLocalEdit.set(key, Date.now());
  clearTimeout(pendingSends.get(key));
  pendingSends.set(
    key,
    setTimeout(() => {
      pendingSends.delete(key);
      sendLocal(doc);
    }, SEND_DEBOUNCE_MS)
  );
}

function sendLocal(doc) {
  const key = doc.uri.toString();
  const m = meta.get(key);
  if (!m) return;
  const text = doc.getText();
  remoteText.set(key, text);
  fsProvider.setText(doc.uri, text);
  const target = activeClient && activeClient.readyState === 1 ? activeClient : openClients()[0];
  if (!target) {
    vscode.window.setStatusBarMessage('$(warning) Power Apps: browser not connected, edit not sent', 4000);
    return;
  }
  target.send(JSON.stringify({ type: 'setFormula', control: m.control, property: m.property, formula: text }));
  if (doc.isDirty) doc.save().then(undefined, () => {});
}

function activate(context) {
  output = vscode.window.createOutputChannel('Power Apps Bridge');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'powerappsBridge.showLog';
  statusItem.show();

  context.subscriptions.push(
    output,
    statusItem,
    vscode.workspace.registerFileSystemProvider(SCHEME, fsProvider, { isCaseSensitive: true }),
    vscode.workspace.onDidChangeTextDocument(onLocalChange),
    vscode.commands.registerCommand('powerappsBridge.restart', startServer),
    vscode.commands.registerCommand('powerappsBridge.showLog', () => output.show(true)),
    vscode.commands.registerCommand('powerappsBridge.toggleFollow', async () => {
      const next = !config().get('followSelection', true);
      await config().update('followSelection', next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`Power Apps: follow selection ${next ? 'on' : 'off'}`, 3000);
      updateStatus();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('powerappsBridge.port')) startServer();
      if (e.affectsConfiguration('powerappsBridge.followSelection')) updateStatus();
    }),
    { dispose: stopServer }
  );

  startServer();
}

function deactivate() {
  stopServer();
}

module.exports = { activate, deactivate };
