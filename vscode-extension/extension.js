'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { ScreenPreview } = require('./preview');
const FX = require('./powerfx-lang');
const { parsePaYaml } = require('./pa-yaml');

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
    this.version = 0; // bumped on every change (formula index cache key)
    this.onChanged = null;
  }

  changed() {
    this.version++;
    if (this.onChanged) this.onChanged();
  }

  setText(uri, text) {
    const prev = this.files.get(uri.path);
    if (!prev || prev.data.toString('utf8') !== text) this.changed();
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
    this.changed();
    const prev = this.files.get(uri.path);
    const now = Date.now();
    this.files.set(uri.path, { data: Buffer.from(content), ctime: prev ? prev.ctime : now, mtime: now });
  }

  delete(uri) {
    this.files.delete(uri.path);
    this.changed();
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
const awaitingResult = new Map(); // uri string -> time a setFormula was sent and not yet confirmed by Studio
const propertiesByControl = new Map(); // control -> [property]
let treeControls = []; // controls last listed from Studio's tree view
const pendingRequests = new Map(); // id -> { resolve, reject }
let requestSeq = 0;
let diagnostics;

let server = null;
const clients = new Set();
let activeClient = null;
let current = null; // { control, property, uri }
let statusItem;
let propertyItem;
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

let wasConnected = false;

function updateStatus() {
  scheduleMirrorState();
  if (!statusItem) return;
  const connected = openClients().length > 0;
  vscode.commands.executeCommand('setContext', 'powerappsBridge.connected', connected);
  vscode.commands.executeCommand('setContext', 'powerappsBridge.hasSelection', !!current && connected);
  if (connected !== wasConnected) {
    wasConnected = connected;
    vscode.window.setStatusBarMessage(
      connected ? '$(pass) Power Apps Studio connecté' : '$(debug-disconnect) Power Apps Studio déconnecté',
      4000
    );
    screenPreview.schedule(300);
  }
  const tip = new vscode.MarkdownString(undefined, true);
  tip.isTrusted = true;
  if (!server) {
    statusItem.text = '$(circle-slash) Power Apps';
    tip.appendMarkdown('**Power Apps X VS Code** : serveur arrêté.\n\n[Redémarrer](command:powerappsBridge.restart)');
  } else if (!connected) {
    statusItem.text = '$(debug-disconnect) Power Apps';
    tip.appendMarkdown(
      '**Power Apps X VS Code** : en attente de Power Apps Studio.\n\n' +
        'Ouvre ton app dans Studio avec l’extension navigateur active.\n\n' +
        '[Guide de démarrage](command:powerappsBridge.openWalkthrough) · [Journal](command:powerappsBridge.showLog)'
    );
  } else {
    statusItem.text = current ? `$(symbol-class) ${current.control}` : '$(plug) Power Apps';
    tip.appendMarkdown(
      '**Power Apps X VS Code** : connecté.\n\n' +
        (current ? `Sélection : \`${current.control}.${current.property}\`\n\n` : '') +
        '[Aperçu de l’écran](command:powerappsBridge.showPreview) · [Aller à une formule](command:powerappsBridge.goToFormula) (Ctrl+Alt+G)'
    );
  }
  if (!config().get('followSelection', true)) {
    statusItem.text += ' $(eye-closed)';
    tip.appendMarkdown('\n\n$(eye-closed) Suivi de la sélection désactivé · [Réactiver](command:powerappsBridge.toggleFollow)');
  }
  statusItem.tooltip = tip;
  statusItem.command = current && connected ? 'powerappsBridge.goToControl' : 'powerappsBridge.help';
  if (current && connected && server) {
    propertyItem.text = `$(symbol-property) ${current.property} $(chevron-down)`;
    propertyItem.tooltip = 'Switch property (Ctrl+Alt+P)';
    propertyItem.show();
  } else {
    propertyItem.hide();
  }
}

/**
 * Workspace on disk (setting powerappsBridge.mirrorFolder, default ".powerapps"): real files that any tool,
 * an AI assistant included, can read and edit. With powerappsBridge.syncFromDisk, saving a .fx file there
 * sends the formula to Studio.
 *   <folder>/<Control>/<Control>.<Property>.fx   formula text (as last seen in Studio, or as edited)
 *   <folder>/_app.json                          every control: type, screen, parent path, properties, formula files
 *   <folder>/_state.json                        connection, current selection, Studio errors, results of disk edits
 *   <folder>/CLAUDE.md                          how to work in this folder (for AI assistants)
 */
const mirrorDiagnostics = new Map(); // "Control.Property" -> { summary, items }
const diskResults = new Map(); // "Control.Property" -> { ok, error, at } for formulas sent from disk
let mirrorStateTimer = null;
let diskWatcher = null;

function mirrorRoot() {
  const setting = (config().get('mirrorFolder', '') || '').trim();
  if (!setting) return null;
  if (path.isAbsolute(setting)) return setting;
  const ws = vscode.workspace.workspaceFolders?.[0];
  return ws && ws.uri.scheme === 'file' ? path.join(ws.uri.fsPath, setting) : null;
}

async function mirrorWrite(file, text) {
  try {
    const prev = await fs.promises.readFile(file, 'utf8').catch(() => null);
    if (prev === text) return;
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, text, 'utf8');
  } catch (e) {
    log(`Mirror: cannot write ${file} (${e.message})`);
  }
}

function mirrorFormula(uri, text) {
  const root = mirrorRoot();
  if (!root) return;
  mirrorWrite(path.join(root, ...uri.path.split('/').filter(Boolean)), text);
  scheduleMirrorState();
}

function scheduleMirrorState() {
  if (!mirrorRoot()) return;
  clearTimeout(mirrorStateTimer);
  mirrorStateTimer = setTimeout(writeMirrorState, 200);
}

function writeMirrorState() {
  const root = mirrorRoot();
  if (!root) return;
  const state = {
    updated: new Date().toISOString(),
    serverRunning: !!server,
    browserConnected: openClients().length > 0,
    current: current
      ? { control: current.control, property: current.property, file: current.uri.path.replace(/^\//, '') }
      : null,
    diagnostics: Object.fromEntries(mirrorDiagnostics),
    diskEdits: Object.fromEntries(diskResults),
    exported: lastExport,
    appErrors: appErrorList,
  };
  mirrorWrite(path.join(root, '_state.json'), JSON.stringify(state, null, 2) + '\n');
  mirrorWrite(path.join(root, '_app.json'), JSON.stringify(appSnapshot(), null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Whole-app export: Studio's document serializes each screen as pa.yaml (like "Copy code"), so every
// formula of the app lands on disk without navigating. App-wide errors come from the same document.
// ---------------------------------------------------------------------------
let lastExport = null; // { at, documents, formulas }
let exporting = null;
let appErrorList = [];
const appErrorUris = new Set();

function exportApp({ quiet = false, timeoutMs = 180000 } = {}) {
  if (exporting) return exporting;
  exporting = (async () => {
    // Studio commits a confirmed edit about a second later: don't read the app before it has.
    const wait = lastConfirmedAt + 2000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const res = await request('exportApp', {}, timeoutMs);
    const root = mirrorRoot();
    const seen = new Set();
    let formulas = 0;
    for (const d of res.documents || []) {
      if (d.error) {
        log(`Export: ${d.name} failed (${d.error})`);
        continue;
      }
      if (root) await mirrorWrite(path.join(root, 'src', `${sanitize(d.name)}.pa.yaml`), d.yaml);
      for (const c of parsePaYaml(d.yaml)) {
        if (c.control) controlTemplates.set(c.name, c.control);
        for (const [property, text] of Object.entries(c.properties)) {
          const uri = formulaUri(c.name, property);
          meta.set(uri.toString(), { control: c.name, property });
          seen.add(uri.path);
          await applyRemote(uri, text, { fromStudio: true });
          formulas++;
        }
      }
    }
    // The export is the whole truth: formula files it no longer contains (reset to default, control deleted) go.
    if (root && !(res.documents || []).some((d) => d.error)) {
      for (const [p] of fsProvider.files) {
        if (seen.has(p) || (current && current.uri.path === p)) continue;
        await fs.promises.unlink(path.join(root, ...p.split('/').filter(Boolean))).catch(() => {});
        const uri = vscode.Uri.from({ scheme: SCHEME, path: p });
        if (!vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString())) {
          fsProvider.files.delete(p);
          fsProvider.changed();
          meta.delete(uri.toString());
        }
      }
    }
    lastExport = { at: new Date().toISOString(), documents: (res.documents || []).length, formulas };
    log(`App exported: ${lastExport.documents} documents, ${formulas} formulas`);
    scheduleMirrorState();
    await refreshAppErrors({ quiet: true });
    return lastExport;
  })()
    .catch((e) => {
      log(`Export failed: ${e.message}`);
      if (!quiet) vscode.window.showWarningMessage(`Power Apps : export impossible (${e.message})`);
      throw e;
    })
    .finally(() => {
      exporting = null;
    });
  return exporting;
}

/** All formula errors of the app → _state.json and the Problems view. */
async function refreshAppErrors({ quiet = false } = {}) {
  try {
    appErrorList = (await request('appErrors', {}, 60000)) || [];
/** Export at connection time: Studio may still be loading, so retry a few times before giving up. */
let exportRetryTimer = null;
function exportWhenReady(attempt = 0) {
  clearTimeout(exportRetryTimer);
  exportRetryTimer = setTimeout(() => {
    if (lastExport || !openClients().length) return;
    // No frame answers until Studio has rendered its tree view: a short timeout, then try again.
    exportApp({ quiet: true, timeoutMs: 15000 }).catch(() => {
      if (attempt < 8) exportWhenReady(attempt + 1); // ~2 min in all
    });
  }, attempt ? 3000 : 1500);
}

  } catch (e) {
    if (!quiet) vscode.window.showWarningMessage(`Power Apps : ${e.message}`);
    return appErrorList;
  }
  const byUri = new Map();
  for (const e of appErrorList) {
    if (!e.control || !e.property) continue;
    const uri = formulaUri(e.control, e.property);
    const text = knownFormula(e.control, e.property) || '';
    const span = e.span || {};
    const start = Number.isInteger(span.min) ? span.min : Number.isInteger(span.start) ? span.start : 0;
    const end = Number.isInteger(span.lim) ? span.lim : Number.isInteger(span.end) ? span.end : start + 1;
    const pos = (off) => {
      const before = text.slice(0, Math.max(0, Math.min(off, text.length)));
      const lines = before.split('\n');
      return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
    };
    const sev = /warn/i.test(String(e.severity)) || e.severity === 1 ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
    const d = new vscode.Diagnostic(new vscode.Range(pos(start), pos(Math.max(end, start + 1))), e.message || 'Power Fx error', sev);
    d.source = 'Power Apps';
    if (!byUri.has(uri.toString())) byUri.set(uri.toString(), { uri, list: [] });
    byUri.get(uri.toString()).list.push(d);
  }
  for (const key of appErrorUris) if (!byUri.has(key)) diagnostics.delete(vscode.Uri.parse(key));
  appErrorUris.clear();
  for (const [key, { uri, list }] of byUri) {
    diagnostics.set(uri, list);
    appErrorUris.add(key);
  }
  scheduleMirrorState();
  appTree.refreshView();
  return appErrorList;
}

const controlTemplates = new Map(); // control -> "Text@0.0.51" (from the pa.yaml export)

/** Every control of the app, for tools that read files: type, where it sits, properties, formula files. */
function appSnapshot() {
  const formulas = new Map(); // control -> { property: file }
  for (const m of meta.values()) {
    if (!fsProvider.files.has(formulaUri(m.control, m.property).path)) continue;
    if (!formulas.has(m.control)) formulas.set(m.control, {});
    formulas.get(m.control)[m.property] = formulaUri(m.control, m.property).path.replace(/^\//, '');
  }
  const controls = [];
  const seen = new Set();
  const add = (name, node) => {
    if (seen.has(name)) return;
    seen.add(name);
    const p = node ? nodePath(node) : [];
    const type = node ? controlType(node) : null;
    controls.push({
      name,
      type: (node && node.type) || (type && type.key) || undefined,
      kind: type ? type.label : undefined,
      template: controlTemplates.get(name),
      screen: node ? (p[0] || (node.level === 1 ? name : undefined)) : undefined,
      parent: p.length ? p[p.length - 1] : undefined,
      children: node ? node.children.filter((c) => c.kind === 'control').map((c) => c.name) : undefined,
      properties: propertiesByControl.get(name) || propertiesForType(type && type.key) || undefined,
      formulas: formulas.get(name) || {},
    });
  };
  for (const [name, node] of appTree.byName) if (node.kind === 'control') add(name, node);
  for (const name of formulas.keys()) add(name, null);
  return {
    updated: new Date().toISOString(),
    complete: treeComplete,
    exported: lastExport,
    note: 'formulas = the .fx files of each control (every non-default property after an export). They follow Studio live for the formula selected there; run {"action":"exportApp"} in _request.json to re-read everything.',
    screens: controls.filter((c) => c.screen === c.name && c.name !== 'App').map((c) => c.name),
    controls,
  };
}

function mirrorAll() {
  for (const [p, f] of fsProvider.files) mirrorFormula(vscode.Uri.from({ scheme: SCHEME, path: p }), f.data.toString('utf8'));
  scheduleMirrorState();
  writeWorkspaceGuide();
  watchDisk();
}

/** CLAUDE.md + .gitignore at the root of the workspace folder (CLAUDE.md is left alone once edited by hand). */
async function writeWorkspaceGuide() {
  const root = mirrorRoot();
  if (!root) return;
  const guide = path.join(root, 'CLAUDE.md');
  const prev = await fs.promises.readFile(guide, 'utf8').catch(() => null);
  if (prev === null || prev.startsWith(GUIDE_MARKER)) await mirrorWrite(guide, WORKSPACE_GUIDE);
  const ignore = path.join(root, '.gitignore');
  if (!(await fs.promises.readFile(ignore, 'utf8').catch(() => null))) await mirrorWrite(ignore, '# Power Apps X VS Code workspace (app code mirrored from Studio)\n*\n');
}

const GUIDE_MARKER = '<!-- generated by Power Apps X VS Code: delete this line to keep your own edits -->';
const WORKSPACE_GUIDE = `${GUIDE_MARKER}
# Power Apps workspace (live link to Power Apps Studio)

This folder is kept in sync with the canvas app open in Power Apps Studio by the "Power Apps X VS Code"
extension. Files here are real: read and edit them with your normal file tools.

## Files
- \`_app.json\`: every control of the app. For each: \`type\` (Studio template, e.g. label, button, gallery),
  \`template\` (e.g. Text@0.0.51), \`screen\`, \`parent\`, \`children\`, \`properties\` (property names) and
  \`formulas\` (property -> .fx file: every property that is not at its default value).
- \`<Control>/<Control>.<Property>.fx\`: the Power Fx formula of one property, raw text, no "=" prefix.
- \`src/<Screen>.pa.yaml\`: each screen (and App) as Studio's "Copy code" YAML: the whole structure with
  every formula. Read-only reference: edits to these files are NOT sent to Studio, edit the .fx files.
- \`_state.json\`: browser connection, the control/property selected in Studio, \`appErrors\` (every formula
  error of the app: control, property, message), \`diagnostics\` (errors of the formula selected in Studio)
  and the result of each edit sent from disk (\`diskEdits\`).
- The whole app is exported when Studio connects (\`exported\` in _app.json says when).

## Editing a formula
1. Write the whole formula into \`<Control>/<Control>.<Property>.fx\` and save. On save, the extension
   selects that control/property in Studio and replaces the formula there (the user sees it happen).
2. Check \`_state.json\` a few seconds later: \`diskEdits["Control.Property"].ok\` says whether Studio took
   it, and \`appErrors\` (refreshed ~2 s after each edit) lists the Power Fx errors of the whole app.
3. Only edit controls listed in \`_app.json\`. A file for a property that does not exist is refused by Studio.

## Rules
- Studio is the source of truth. The .fx files follow Studio live for the formula selected there; a change
  made elsewhere in Studio (paste, undo, another author) only shows after a new export:
  write \`{"action": "exportApp"}\` to \`_request.json\` before a series of edits.
- A property missing from \`formulas\` is at its default value: you can still write its .fx file.
- Each saved file is sent to Studio and changes the app immediately: save only finished formulas, one
  file at a time when they depend on each other.
- Creating, deleting or renaming files does not create, delete or rename controls.

## Reading a formula that is not here yet
Write \`_request.json\`; the extension deletes it and writes the answer to \`_response.json\` (same \`id\`).
Studio selects each control/property while it reads (the user sees it), and the .fx files appear.
- \`{"id": "1", "action": "readFormula", "control": "Button1", "property": "OnSelect"}\`
- \`{"id": "2", "action": "readFormulas", "items": [{"control": "Button1", "property": "OnSelect"}]}\`
- \`{"id": "3", "action": "exportApp"}\` (re-reads every formula of the app, no navigation; fast)
- \`{"id": "4", "action": "errors"}\` (refreshes \`appErrors\`)
- \`{"id": "5", "action": "refreshTree"}\` (reloads the control list of \`_app.json\`)
- \`{"id": "6", "action": "rename", "items": [{"control": "Label3", "newName": "lblTitle_HomeScreen"}]}\`
  (Studio's rename: every formula that refers to the control is updated; the app is re-exported after)
- This folder is git-ignored (see .gitignore here): search tools that honor .gitignore may skip it, so open
  files by path (from \`_app.json\`).
- Power Fx: formulas only, no statements outside behavior properties (OnSelect, OnVisible, OnStart…),
  where actions are chained with \`;\`. Control names with spaces are quoted: \`'Home Screen'\`.

## Clean-up and naming
\`_lint.json\`: \`findings\` (variables / collections / named formulas never read, hidden controls never
referenced) and \`naming\` (controls with Studio default names such as Label3, with a suggested name that
follows the app's own prefix and screen-suffix convention). Ask the user before renaming or deleting.
`;

/** Watches the workspace folder: a .fx file saved there (by the user or a tool) is sent to Studio. */
function watchDisk() {
  if (diskWatcher) diskWatcher.dispose();
  diskWatcher = null;
  const root = mirrorRoot();
  if (!root || !config().get('syncFromDisk', true)) return;
  const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**/*.fx'));
  w.onDidChange(onDiskFormula);
  w.onDidCreate(onDiskFormula);
  const r = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '_request.json'));
  r.onDidChange(onDiskRequest);
  r.onDidCreate(onDiskRequest);
  diskWatcher = vscode.Disposable.from(w, r);
}

/**
 * Requests written by a tool to <folder>/_request.json; the answer goes to <folder>/_response.json.
 *   {"id": "1", "action": "readFormula", "control": "Button1", "property": "OnSelect"}
 *   {"id": "2", "action": "readFormulas", "items": [{"control": "…", "property": "…"}, …]}
 *   {"id": "3", "action": "refreshTree"}
 *   {"id": "4", "action": "probeDocument", "options": {…}} / {"action": "evalPath", "path": "AppMagic.X"} (diagnostics)
 */
let diskRequestBusy = false;
async function onDiskRequest(file) {
  if (diskRequestBusy) return;
  let req;
  try {
    req = JSON.parse(normalizeEol(await fs.promises.readFile(file.fsPath, 'utf8')));
  } catch {
    return; // partially written: the next change event will retry
  }
  diskRequestBusy = true;
  const root = mirrorRoot();
  const answer = async (ok, data, error) => {
    await mirrorWrite(path.join(root, '_response.json'), JSON.stringify({ id: req.id, action: req.action, ok, error, data, at: new Date().toISOString() }, null, 2) + '\n');
  };
  try {
    await fs.promises.unlink(file.fsPath).catch(() => {});
    log(`Disk request: ${req.action}`);
    const read = async ({ control, property }) => {
      await request('navigate', { control, property, path: pathOf(control) }, 60000);
      const key = formulaUri(control, property).path;
      for (let i = 0; i < 30 && !fsProvider.files.has(key); i++) await new Promise((r) => setTimeout(r, 100));
      const f = fsProvider.files.get(key);
      return { control, property, file: key.replace(/^\//, ''), formula: f ? f.data.toString('utf8') : null };
    };
    switch (req.action) {
      case 'readFormula':
        await answer(true, await read(req));
        break;
      case 'readFormulas': {
        const out = [];
        for (const it of req.items || []) {
          try {
            out.push(await read(it));
          } catch (e) {
            out.push({ ...it, error: e.message });
          }
        }
        await answer(true, out);
        break;
      }
      case 'refreshTree':
        await loadFullTree({ quiet: true });
        await answer(true, { controls: treeControls.length, complete: treeComplete });
        break;
      case 'exportApp':
        await answer(true, await exportApp({ quiet: true }));
        break;
      case 'errors':
        await answer(true, await refreshAppErrors({ quiet: true }));
        break;
      case 'rename': {
        // [{control, newName}] or {control, newName}: Studio's rename, which updates every reference.
        const items = Array.isArray(req.items) ? req.items : [{ control: req.control, newName: req.newName }];
        const results = [];
        for (const it of items) {
          try {
            await renameControlInStudio(it.control, String(it.newName).trim(), { refresh: false });
            results.push({ ...it, ok: true });
          } catch (e) {
            results.push({ ...it, ok: false, error: e.message });
          }
        }
        await afterRenames();
        await answer(results.every((r) => r.ok), results);
        break;
      }
      case 'probeDocument':
        await answer(true, await request('probeDocument', { options: req.options || {} }, 60000));
        break;
      case 'evalPath':
        await answer(true, await request('evalPath', { path: String(req.path || '') }, 20000));
        break;
      case 'fnSource':
        await answer(true, await request('fnSource', { path: String(req.path || '') }, 20000));
        break;
      case 'call':
        await answer(true, await request('call', { target: req.target, method: req.method, args: req.args, store: req.store, full: req.full }, 60000));
        break;
      default:
        await answer(false, null, `Unknown action "${req.action}"`);
    }
  } catch (e) {
    await answer(false, null, e.message);
  } finally {
    diskRequestBusy = false;
  }
}

const normalizeEol = (s) => s.replace(/^﻿/, '').replace(/\r\n/g, '\n');

async function onDiskFormula(file) {
  const root = mirrorRoot();
  if (!root) return;
  const rel = path.relative(root, file.fsPath).split(path.sep);
  if (rel.length !== 2 || !rel[1].endsWith('.fx')) return;
  const base = rel[1].slice(0, -3);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || base.slice(0, dot) !== rel[0]) return; // not <Control>/<Control>.<Property>.fx
  let text;
  try {
    text = normalizeEol(await fs.promises.readFile(file.fsPath, 'utf8'));
  } catch {
    return;
  }
  const uri = formulaUri(rel[0], base.slice(dot + 1));
  const key = uri.toString();
  if (text === normalizeEol(remoteText.get(key) ?? '\u0000')) return; // our own write, or no change
  // Real names (the file name is sanitized): from a formula seen in Studio, else from the tree.
  const m = meta.get(key) || (knownControls().includes(rel[0]) ? { control: rel[0], property: base.slice(dot + 1) } : null);
  const mkey = `${rel[0]}.${base.slice(dot + 1)}`;
  if (!m) {
    diskResults.set(mkey, { ok: false, error: `Unknown control "${rel[0]}" (not in _app.json)`, at: new Date().toISOString() });
    scheduleMirrorState();
    return;
  }
  meta.set(key, m);
  log(`Disk edit → Studio: ${m.control}.${m.property}`);
  diskResults.set(`${m.control}.${m.property}`, { ok: null, pending: true, at: new Date().toISOString() });
  await applyRemote(uri, text); // open editor + in-memory copy follow the file
  pushFormula(uri, m, text);
}

let extContext = null; // set in activate()
const TRUSTED_KEY = 'trustedOrigins';
const trustedOrigins = () => new Set((extContext && extContext.globalState.get(TRUSTED_KEY)) || []);
const asking = new Map(); // origin -> Promise<boolean> (one prompt per origin, even if it reconnects)
const refusedOrigins = new Set(); // this session only: the browser keeps reconnecting, don't ask again

/**
 * Any installed browser extension can open a WebSocket to 127.0.0.1, so the Origin check alone would let
 * another extension read and change formulas. The first connection of each extension is held until the user
 * approves it; the answer is remembered.
 */
function approveOrigin(origin) {
  if (trustedOrigins().has(origin)) return Promise.resolve(true);
  if (refusedOrigins.has(origin)) return Promise.resolve(false);
  if (asking.has(origin)) return asking.get(origin);
  const p = (async () => {
    const id = origin.replace(/^[a-z-]+:\/\//, '').replace(/\/$/, '');
    const pick = await vscode.window.showWarningMessage(
      `Power Apps X VS Code : une extension navigateur demande à se connecter (${id}). ` +
        'Elle pourra lire et modifier les formules de l’app ouverte dans Studio. Autoriser seulement si c’est l’extension « Power Apps X VS Code ».',
      { modal: false },
      'Autoriser',
      'Refuser'
    );
    const ok = pick === 'Autoriser';
    if (ok) await extContext.globalState.update(TRUSTED_KEY, [...trustedOrigins(), origin]);
    else refusedOrigins.add(origin);
    log(`${ok ? 'Approved' : 'Refused'} browser extension ${origin}`);
    return ok;
  })().finally(() => asking.delete(origin));
  asking.set(origin, p);
  return p;
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
    maxPayload: 64 * 1024 * 1024, // a screen mirror with inlined images fits; anything bigger is refused
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
  // Heartbeat: keeps the browser extension's service worker awake (Chrome suspends it when idle).
  const heartbeat = setInterval(() => {
    for (const c of openClients()) c.send('{"type":"heartbeat"}');
  }, 10000);
  server.on('close', () => clearInterval(heartbeat));
  server.on('error', async (err) => {
    log(`Server error: ${err.message}`);
    server = null;
    updateStatus();
    const inUse = err.code === 'EADDRINUSE';
    const pick = await vscode.window.showErrorMessage(
      inUse
        ? `Power Apps X VS Code : le port ${port} est déjà utilisé, probablement par une autre fenêtre VS Code. Studio reste relié à cette autre fenêtre.`
        : `Power Apps X VS Code : impossible d’écouter sur le port ${port} (${err.message}).`,
      'Réessayer',
      'Changer de port',
      'Journal'
    );
    if (pick === 'Réessayer') startServer();
    else if (pick === 'Changer de port') vscode.commands.executeCommand('workbench.action.openSettings', 'powerappsBridge.port');
    else if (pick === 'Journal') output.show(true);
  });
  server.on('connection', async (ws, req) => {
    const origin = req.headers.origin;
    const known = trustedOrigins().has(origin);
    if (!(await approveOrigin(origin))) {
      ws.close(1008, 'Not approved in VS Code');
      return;
    }
    // Messages sent while the user was deciding (hello, selection) were not listened to: the browser
    // extension reconnects within a second and starts over, now trusted.
    if (!known) {
      ws.close(1012, 'Approved, reconnect');
      return;
    }
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
      // Requests sent to this page will never be answered (page reloaded/closed).
      for (const [id, p] of pendingRequests) {
        if (p.ws === ws) {
          pendingRequests.delete(id);
          p.reject(new Error('Studio page closed or reloaded'));
        }
      }
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

const warnedVersions = new Set();
let errorsRefreshTimer = null;
const unsentEdits = new Map(); // uri string -> { uri, m, text }: edits made while the browser was away

function flushUnsentEdits() {
  // Edits sent but never confirmed (the connection dropped before Studio's answer): send them again.
  // Sending the same text twice is harmless if Studio had already applied it.
  for (const [key, f] of inFlight) {
    if (!f.confirmed && Date.now() <= f.until && !unsentEdits.has(key)) unsentEdits.set(key, { uri: f.uri, m: f.m, text: f.text });
  }
  if (!unsentEdits.size || !pickClient()) return;
  log(`Sending ${unsentEdits.size} edit(s) made while disconnected`);
  for (const { uri, m, text } of [...unsentEdits.values()]) pushFormula(uri, m, text);
}

async function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'hello':
      log(`Hello from browser extension v${msg.version || '?'}`);
      {
        const own = require('./package.json').version;
        if (msg.version && msg.version !== own && !warnedVersions.has(msg.version)) {
          warnedVersions.add(msg.version);
          vscode.window.showWarningMessage(
            `Power Apps : l'extension navigateur est en v${msg.version}, VS Code en v${own}. ` +
              'Recharge l’extension navigateur (page Extensions du navigateur) puis la page Studio.'
          );
        }
      }
      setTimeout(flushUnsentEdits, 1500);
      if (config().get('loadFullTree', true)) setTimeout(() => openClients().length && loadFullTree({ quiet: true }), 2500);
      break;
    case 'selection':
      activeClient = ws;
      await onSelection(msg);
      break;
    case 'formula':
      activeClient = ws;
      await onRemoteFormula(msg);
      break;
    case 'result': {
      const rkey = formulaUri(msg.control, msg.property).toString();
      awaitingResult.delete(rkey);
      const f = inFlight.get(rkey);
      if (f && msg.ok) {
        // Studio commits about a second later: keep ignoring its old text for a little while.
        f.confirmed = true;
        f.until = Date.now() + SETTLE_MS;
        lastConfirmedAt = Date.now();
        await applyRemote(f.uri, f.text); // undo any stale echo that slipped through
      } else if (f) {
        inFlight.delete(rkey); // refused: Studio still has its own text, which is the truth
      }
    }
      if (diskResults.has(`${msg.control}.${msg.property}`)) {
        diskResults.set(`${msg.control}.${msg.property}`, {
          ok: !!msg.ok,
          error: msg.ok ? undefined : msg.error,
          at: new Date().toISOString(),
        });
        scheduleMirrorState();
        clearTimeout(errorsRefreshTimer); // let Studio re-check the app, then refresh the app-wide errors
        errorsRefreshTimer = setTimeout(() => refreshAppErrors({ quiet: true }), 2000);
      }
      if (!msg.ok) {
        log(`Studio refused the edit: ${msg.error}`);
        vscode.window.setStatusBarMessage(`$(warning) Power Apps: ${msg.error}`, 6000);
      }
      break;
    case 'diagnostics':
      onDiagnostics(msg);
      break;
    case 'response': {
      const p = pendingRequests.get(msg.id);
      if (p) {
        pendingRequests.delete(msg.id);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error || 'Studio request failed'));
      }
      break;
    }
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
      // The export reads Studio's document, not the tree view: start it now rather than after the tree load.
      if (!lastExport && config().get('exportOnConnect', true)) exportWhenReady();
  const controlChanged = !current || current.control !== msg.control;
  current = { control: msg.control, property: msg.property, uri };
  updateStatus();
  scheduleTreeRefresh();
  if (screenPreview.visible) {
    screenPreview.post(); // highlight right away; new snapshot once Studio has settled (the screen may have changed)
    if (controlChanged) screenPreview.schedule(600);
  }
  log(`Selected ${msg.control}.${msg.property} (${msg.mode || '?'})`);
  const text = msg.formula ?? '';
  await applyRemote(uri, text, { fromStudio: true });
  if (config().get('followSelection', true)) {
    const active = vscode.window.activeTextEditor;
    if (!active || active.document.uri.toString() !== uri.toString()) {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
      await applyRemote(uri, text, { fromStudio: true }); // the document may have been cached with stale text
    }
    await closeOtherFormulaTabs(uri);
  }
}

/** One formula tab at a time (pinned tabs are kept, so pin a formula to keep it around). */
async function closeOtherFormulaTabs(keep) {
  if (!config().get('singleTab', true)) return;
  const key = keep.toString();
  const tabs = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter(
      (t) =>
        t.input instanceof vscode.TabInputText &&
        t.input.uri.scheme === SCHEME &&
        t.input.uri.toString() !== key &&
        !t.isPinned &&
        !t.isDirty
    );
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
}

async function onRemoteFormula(msg) {
  const uri = remember(msg);
  await applyRemote(uri, msg.formula ?? '', { fromStudio: true });
  propsView.refreshView(); // formula preview
  if (screenPreview.visible) screenPreview.schedule(1500); // the screen may look different now
}

/**
 * Formulas sent to Studio and not yet settled: uri string -> { text, m, until, confirmed }.
 * While Studio switches to a formula it first reports the OLD text, and it commits an edit about a second
 * after confirming it: during that window, a different text coming from Studio must not overwrite ours.
 */
const inFlight = new Map();
const IN_FLIGHT_MS = 60000; // waiting for Studio's answer (navigation can be slow)
const SETTLE_MS = 4000; // after Studio confirmed: its echoes/exports may still show the old text
let lastConfirmedAt = 0;

function isStaleEcho(key, text) {
  const f = inFlight.get(key);
  if (!f) return false;
  if (Date.now() > f.until) {
    inFlight.delete(key);
    return false;
  }
  return text !== f.text;
}

/** Push text coming from Studio into the in-memory FS and into the open document, if any. */
async function applyRemote(uri, text, { fromStudio = false } = {}) {
  const key = uri.toString();
  if (fromStudio && isStaleEcho(key, text)) return; // old text reported before our edit is committed
  remoteText.set(key, text);
  fsProvider.setText(uri, text);
  mirrorFormula(uri, text);
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  if (!doc || doc.getText() === text) return;
  if (pendingSends.has(key) || Date.now() - (lastLocalEdit.get(key) || 0) < LOCAL_EDIT_GRACE_MS) return;
  if (Date.now() - (awaitingResult.get(key) || 0) < 5000) return; // Studio is still switching to this formula
  // Replace only the part that differs, so the cursor and selections elsewhere stay where they are.
  const old = doc.getText();
  let start = 0;
  while (start < old.length && start < text.length && old[start] === text[start]) start++;
  let end = 0;
  while (end < old.length - start && end < text.length - start && old[old.length - 1 - end] === text[text.length - 1 - end]) end++;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(doc.positionAt(start), doc.positionAt(old.length - end)),
    text.slice(start, text.length - end)
  );
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
  mirrorFormula(doc.uri, text);
  pushFormula(doc.uri, m, text);
  if (doc.isDirty) doc.save().then(undefined, () => {});
}

/** Sends a formula to Studio (which switches to that control/property first when navigateOnEdit is on). */
function pushFormula(uri, m, text) {
  const target = pickClient();
  const mkey = `${m.control}.${m.property}`;
  if (!target) {
    // Kept and sent as soon as Studio reconnects (the latest text per formula wins).
    unsentEdits.set(uri.toString(), { uri, m, text });
    vscode.window.setStatusBarMessage('$(clock) Power Apps : navigateur déconnecté, modification envoyée à la reconnexion', 5000);
    if (diskResults.has(mkey)) {
      diskResults.set(mkey, { ok: null, pending: true, queued: true, at: new Date().toISOString() });
      scheduleMirrorState();
    }
    return;
  }
  unsentEdits.delete(uri.toString());
  inFlight.set(uri.toString(), { uri, m, text, until: Date.now() + IN_FLIGHT_MS, confirmed: false });
  awaitingResult.set(uri.toString(), Date.now());
  if (screenPreview.visible) screenPreview.schedule(1500);
  target.send(
    JSON.stringify({
      type: 'setFormula',
      control: m.control,
      property: m.property,
      formula: text,
      navigate: config().get('navigateOnEdit', true),
    })
  );
}

function pickClient() {
  return activeClient && activeClient.readyState === 1 ? activeClient : openClients()[0];
}

/** Ask the Studio frame for something; resolves with its answer. */
function request(type, payload = {}, timeoutMs = 10000) {
  const target = pickClient();
  if (!target) return Promise.reject(new Error('browser extension not connected'));
  const id = ++requestSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Studio did not answer'));
    }, timeoutMs);
    pendingRequests.set(id, {
      ws: target,
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    target.send(JSON.stringify({ type, id, ...payload }));
  });
}

const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

function onDiagnostics(msg) {
  const uri = formulaUri(msg.control, msg.property);
  const summary = (msg.summary || '').trim();
  const list = (msg.items || []).map((d) => {
    const [sl, sc, el, ec] = d.range;
    const diag = new vscode.Diagnostic(
      new vscode.Range(sl - 1, sc - 1, el - 1, ec - 1),
      d.message || summary || 'Power Fx error',
      SEVERITY[d.severity] ?? vscode.DiagnosticSeverity.Error
    );
    diag.source = 'Power Apps';
    return diag;
  });
  // Studio reports errors but we could not locate them: flag the start of the formula.
  if (!list.length && summary && !/^no formula errors|^aucune erreur/i.test(summary)) {
    const diag = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), summary, vscode.DiagnosticSeverity.Error);
    diag.source = 'Power Apps';
    list.push(diag);
  }
  const before = (diagnostics.get(uri) || []).length;
  diagnostics.set(uri, list);
  const mkey = `${msg.control}.${msg.property}`;
  if (list.length) {
    mirrorDiagnostics.set(mkey, {
      summary,
      items: list.map((d) => ({
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        endLine: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
        severity: ['error', 'warning', 'info', 'hint'][d.severity],
        message: d.message,
      })),
    });
  } else {
    mirrorDiagnostics.delete(mkey);
  }
  scheduleMirrorState();
  if (before !== list.length) {
    appTree.refreshView(); // error icons in the Power Apps views
    propsView.refreshView();
    screenPreview.post();
  }
}

async function openFormula(control, property) {
  const doc = await vscode.workspace.openTextDocument(formulaUri(control, property));
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function goTo(control, property) {
  try {
    const r = await request('navigate', { control, property, path: pathOf(control) }, 60000);
    if (!config().get('followSelection', true) && r) await openFormula(r.control, r.property);
  } catch (e) {
    vscode.window.showWarningMessage(`Power Apps : ${e.message}`);
    if (/not found/i.test(e.message) && treeComplete) loadFullTree({ quiet: true }); // renamed/deleted in Studio
  }
}

async function cmdGoToProperty() {
  if (!current) return vscode.window.showWarningMessage('Power Apps: no control selected in Studio yet');
  const control = current.control;
  let props;
  try {
    props = await request('listProperties');
    propertiesByControl.set(control, props);
    propsView.refreshView();
  } catch (e) {
    props = propertiesByControl.get(control);
    if (!props) return vscode.window.showWarningMessage(`Power Apps: ${e.message}`);
  }
  const pick = await vscode.window.showQuickPick(
    props.map((p) => ({ label: p, description: p === current.property ? 'current' : undefined })),
    { placeHolder: `Property of ${control}` }
  );
  if (pick) await goTo(control, pick.label);
}

const treeNames = () => treeControls.map((c) => (typeof c === 'string' ? c : c.name));

function knownControls() {
  const set = new Set(treeNames());
  for (const m of meta.values()) set.add(m.control);
  set.delete('Unknown');
  return [...set];
}

// ---------------------------------------------------------------------------
// "Power Apps" side bar: app tree (screens > controls) + properties of the selected control.
// ---------------------------------------------------------------------------

/**
 * Control types: matched first on the hint Studio puts on the tree row (icon name, label), then on the
 * control's name prefix (lbl, btn, gal… conventions).
 */
const CONTROL_TYPES = [
  { key: 'app', label: 'Application', icon: 'rocket', hint: /\bapp\b|appicon/i, name: /^app$/i },
  { key: 'screen', label: 'Écran', icon: 'window', hint: /screen|écran/i, name: /screen$|^scr/i },
  { key: 'component', label: 'Composant', icon: 'extensions', hint: /component|composant/i, name: /^(cmp|comp)/i },
  { key: 'gallery', label: 'Galerie', icon: 'list-unordered', hint: /gallery|galerie/i, name: /^(gal|gallery)/i },
  { key: 'form', label: 'Formulaire', icon: 'checklist', hint: /form|formulaire/i, name: /^(frm|form|edit|disp)/i },
  { key: 'datacard', label: 'Carte de données', icon: 'symbol-field', hint: /datacard|carte/i, name: /datacard(?!value)|^dc/i },
  { key: 'container', label: 'Conteneur', icon: 'layout', hint: /container|conteneur|group|groupe/i, name: /^(con|cnt|container|grp|group|hc|vc|hzc|vtc|lyt)/i },
  { key: 'button', label: 'Bouton', icon: 'debug-start', hint: /button|bouton/i, name: /^(btn|button|but)/i },
  { key: 'label', label: 'Étiquette', icon: 'symbol-text', hint: /label|étiquette|text ?label/i, name: /^(lbl|label|txtlbl)/i },
  { key: 'input', label: 'Saisie de texte', icon: 'symbol-string', hint: /text ?input|textbox|saisie/i, name: /^(txt|textinput|inp|input|tb)|datacardvalue/i },
  { key: 'dropdown', label: 'Liste déroulante', icon: 'chevron-down', hint: /dropdown|combo|liste/i, name: /^(cmb|combo|dd|drp|dropdown|lst|list|cb)/i },
  { key: 'check', label: 'Choix', icon: 'pass', hint: /checkbox|toggle|radio|case|bascule/i, name: /^(chk|check|tgl|toggle|rad|radio)/i },
  { key: 'date', label: 'Date', icon: 'calendar', hint: /date/i, name: /^(dte|date|dp|dtp)/i },
  { key: 'icon', label: 'Icône', icon: 'star-empty', hint: /\bicon\b|icône/i, name: /^(ico|icon)/i },
  { key: 'image', label: 'Image', icon: 'file-media', hint: /image|picture/i, name: /^(img|image|pic)/i },
  { key: 'shape', label: 'Forme', icon: 'primitive-square', hint: /rectangle|shape|forme|separator/i, name: /^(rect|shp|shape|sep)/i },
  { key: 'html', label: 'Texte HTML', icon: 'code', hint: /html/i, name: /^(htm|html)/i },
  { key: 'timer', label: 'Minuteur', icon: 'clock', hint: /timer|minuteur/i, name: /^(tmr|timer)/i },
  { key: 'chart', label: 'Graphique', icon: 'graph', hint: /chart|graphique/i, name: /^(chr|chart|grph)/i },
  { key: 'media', label: 'Média', icon: 'play-circle', hint: /video|audio|camera|media/i, name: /^(vid|aud|cam|med)/i },
  { key: 'pen', label: 'Stylet', icon: 'edit', hint: /pen|stylet/i, name: /^(pen)/i },
  { key: 'slider', label: 'Curseur', icon: 'settings', hint: /slider|curseur|rating/i, name: /^(sld|slider|rtg|rating)/i },
];

/** Studio template names (from its tree data) -> CONTROL_TYPES key. Classic, modern and "Canvas" (Fluent) controls. */
const TEMPLATE_TYPES = [
  [/^(appinfo|hostcontrol)$/i, 'app'],
  [/^screen$/i, 'screen'],
  [/datacard/i, 'datacard'],
  [/_datafield$/i, 'datacard'],
  [/^(label|moderntext|htmltext)$|TextCanvas$|_Text$/i, 'label'],
  [/^htmlviewer$/i, 'html'],
  [/^(button|modernbutton)$|ButtonCanvas$|InfoButtonCanvas$/i, 'button'],
  [/^(text|textinput|moderntextinput)$|TextInputCanvas$|NumberInput/i, 'input'],
  [/^(dropdown|combobox|moderncombobox|moderndropdown|listbox)$|DropdownCanvas$|ComboboxCanvas$/i, 'dropdown'],
  [/^(checkbox|toggle|radio|moderntoggle|moderncheckbox|modernradio)$|CheckboxCanvas$|RadioGroupCanvas$|SwitchCanvas$/i, 'check'],
  [/^(datepicker|moderndatepicker)$|DatePickerCanvas$/i, 'date'],
  [/^(icon|modernicon)$|_Icon$/i, 'icon'],
  [/^(image|modernimage)$/i, 'image'],
  [/^(rectangle|circle|triangle|separator)$/i, 'shape'],
  [/^timer$/i, 'timer'],
  [/^(gallery|PowerAppsOneGrid)$/i, 'gallery'],
  [/^form$|formviewer$/i, 'form'],
  [/container/i, 'container'],
  [/chart$/i, 'chart'],
  [/^(slider|rating)$/i, 'slider'],
  [/^(pentool|penInput)$/i, 'pen'],
  [/^(video|audio|camera|microphone)$/i, 'media'],
];

function controlType(node) {
  if (node.level === 1 && !/^app$/i.test(node.name) && !CONTROL_TYPES[2].name.test(node.name)) return CONTROL_TYPES[1];
  if (node.type) {
    // Studio's template name is reliable: never fall back to guessing from the control's name.
    const hit = TEMPLATE_TYPES.find(([re]) => re.test(node.type));
    if (hit) return CONTROL_TYPES.find((t) => t.key === hit[1]);
    for (const t of CONTROL_TYPES) if (t.hint.test(node.type)) return t;
    return node.children && node.children.length
      ? { key: 'group', label: 'Groupe', icon: 'layout' }
      : { key: 'other', label: node.type, icon: 'symbol-misc' };
  }
  if (node.hint) for (const t of CONTROL_TYPES) if (t.hint.test(node.hint)) return t;
  for (const t of CONTROL_TYPES) if (t.name.test(node.name)) return t;
  return node.children && node.children.length
    ? { key: 'group', label: 'Groupe', icon: 'layout' }
    : { key: 'other', label: 'Contrôle', icon: 'symbol-misc' };
}

/** [screen, …, parent] names of a tree node. */
function nodePath(node) {
  const out = [];
  for (let p = node && node.parent; p && p.kind === 'control'; p = p.parent) out.unshift(p.name);
  return out;
}

function pathOf(name) {
  const node = appTree.byName.get(name);
  return node ? nodePath(node) : [];
}

function countDescendants(node) {
  return node.children.reduce((n, c) => n + 1 + countDescendants(c), 0);
}

function knownFormula(control, property) {
  const f = fsProvider.files.get(formulaUri(control, property).path);
  return f ? f.data.toString('utf8') : undefined;
}

function preview(text) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length > 70 ? one.slice(0, 69) + '…' : one;
}

const controlErrors = (name) =>
  [...meta.values()].filter((m) => m.control === name && (diagnostics.get(formulaUri(m.control, m.property)) || []).length);

class AppTreeProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.rootNodes = [];
    this.byName = new Map();
  }

  /** Rebuilds { name, parent, children } nodes from the flat, level-annotated list sent by Studio. */
  rebuild() {
    const roots = [];
    const stack = [];
    this.byName = new Map();
    for (const c of treeControls) {
      const item = typeof c === 'string' ? { name: c, level: 1 } : c;
      while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].node : null;
      const node = { kind: 'control', name: item.name, level: item.level, hint: item.hint, type: item.type, parent, children: [] };
      (parent ? parent.children : roots).push(node);
      stack.push({ level: item.level, node });
      if (!this.byName.has(item.name)) this.byName.set(item.name, node);
    }
    // Controls seen this session that are not in the tree (e.g. tree view closed in Studio).
    const others = knownControls()
      .filter((n) => !this.byName.has(n))
      .sort((a, b) => a.localeCompare(b));
    if (others.length) {
      const group = { kind: 'group', name: 'Autres contrôles ouverts', parent: null, children: [] };
      for (const n of others) {
        const node = { kind: 'control', name: n, level: 2, parent: group, children: [] };
        group.children.push(node);
        this.byName.set(n, node);
      }
      roots.push(group);
    }
    this.rootNodes = roots;
  }

  refreshView() {
    this.rebuild();
    this._emitter.fire();
    scheduleMirrorState(); // _app.json
  }

  getChildren(node) {
    return node ? node.children : this.rootNodes;
  }

  getParent(node) {
    return node.parent || undefined;
  }

  getTreeItem(node) {
    if (node.kind === 'group') {
      const it = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
      it.id = 'group:other';
      it.iconPath = new vscode.ThemeIcon('eye-closed');
      it.tooltip = 'Contrôles ouverts pendant la session mais absents de l’arborescence chargée. Rafraîchis l’arborescence pour les ranger.';
      return it;
    }
    const type = controlType(node);
    const isCurrent = current && current.control === node.name;
    const inCurrent = !isCurrent && current && nodePath(appTree.byName.get(current.control) || {}).includes(node.name);
    const screenOfCurrent = inCurrent && node.level === 1;
    const it = new vscode.TreeItem(
      node.name,
      node.children.length
        ? screenOfCurrent
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    it.id = `control:${node.name}`;
    const errors = controlErrors(node.name);
    it.iconPath = errors.length
      ? new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'))
      : new vscode.ThemeIcon(type.icon, isCurrent || inCurrent ? new vscode.ThemeColor('charts.blue') : undefined);
    const parts = [];
    if (isCurrent) parts.push('● sélectionné');
    parts.push(type.label);
    if (node.children.length) parts.push(`${countDescendants(node)} contrôle${countDescendants(node) > 1 ? 's' : ''}`);
    if (errors.length) parts.push(`${errors.length} erreur${errors.length > 1 ? 's' : ''}`);
    if (fxTools && node.level > 1 && fxTools.isDefaultName(node.name)) parts.push('nom par défaut');
    it.description = parts.join(' · ');
    const path = nodePath(node);
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    const arg = (v) => encodeURIComponent(JSON.stringify(v));
    md.appendMarkdown(`$(${type.icon}) **${node.name}** — ${type.label}\n\n`);
    if (path.length) md.appendMarkdown(`${path.join(' › ')} › **${node.name}**\n\n`);
    const loaded = [...meta.values()].filter((m) => m.control === node.name).map((m) => m.property);
    if (loaded.length) md.appendMarkdown(`Formules ouvertes : ${loaded.sort().join(', ')}\n\n`);
    if (errors.length) md.appendMarkdown(`⚠ Erreurs dans : ${errors.map((e) => e.property).join(', ')}\n\n`);
    md.appendMarkdown(
      `[Sélectionner](command:powerappsBridge.selectControl?${arg([node.name])}) · ` +
        `[Propriété…](command:powerappsBridge.pickProperty?${arg([node.name])}) · ` +
        `[Aperçu](command:powerappsBridge.revealInPreview?${arg([{ name: node.name }])}) · ` +
        `[Renommer](command:powerappsBridge.renameControl?${arg([{ name: node.name }])}) · ` +
        `[Références](command:powerappsBridge.findUsages?${arg([node.name])})`
    );
    if (fxTools) {
      const refs = fxTools.references(node.name);
      if (refs) md.appendMarkdown(`\n\nRéférencé dans ${refs} formule${refs > 1 ? 's' : ''}`);
      const sug = fxTools.isDefaultName(node.name) && fxTools.suggestName(node.name);
      if (sug) md.appendMarkdown(`\n\nNom suggéré : \`${sug}\``);
    }
    it.tooltip = md;
    it.contextValue = 'control';
    it.command = { command: 'powerappsBridge.selectControl', title: 'Sélectionner', arguments: [node.name] };
    return it;
  }
}

/**
 * Property categories, checked in order (first match wins). Studio does not expose categories,
 * so they come from Power Apps' property naming conventions.
 */
const PROPERTY_GROUPS = [
  {
    key: 'behavior',
    label: 'Comportement',
    icon: 'zap',
    expanded: true,
    test: (p) => /^On[A-Z]/.test(p) && !/^On(Text)$/.test(p),
  },
  {
    key: 'data',
    label: 'Données et contenu',
    icon: 'database',
    expanded: true,
    test: (p) =>
      /^(Items|Item|DataSource|Default\w*|Text|Value|HintText|Placeholder|Format|MaxLength|Mode|Required|Update|Valid|Fields|DisplayFields|SearchFields|IsSearchable|SelectMultiple|AllowEmptySelection|Min|Max|Step|Start\w*|End\w*|Media|Image|Reset|Clear|DelayOutput|EnableSpellCheck|OnText|OffText|ShowValue|Label|Title|Subtitle|Html\w*|Content\w*|Selected\w*|Visible\w*Fields)$/.test(p),
  },
  {
    key: 'layout',
    label: 'Position et taille',
    icon: 'move',
    test: (p) =>
      /^(X|Y|Width|Height|AutoHeight|ZIndex|FillPortions|AlignInContainer|Gap|TemplateSize|TemplatePadding|WrapCount)$|^(Layout|Flexible|Minimum|Maximum)/.test(p),
  },
  {
    key: 'state',
    label: 'Visibilité et accessibilité',
    icon: 'eye',
    test: (p) => /^(Visible|DisplayMode|Tooltip|AccessibleLabel|TabIndex|Live|Role|ContentLanguage|Accessible\w*)$/.test(p),
  },
  {
    key: 'appearance',
    label: 'Apparence',
    icon: 'symbol-color',
    test: (p) =>
      /Color|Fill|Border|Font|Size|Weight|Italic|Underline|Strikethrough|Align|Padding|Radius|Shadow|Image|Icon|Transparency|Template|Theme|Style|LineHeight|Wrap|Hover|Pressed|Disabled|Focused|Rotation|Spacing|Appearance|Variant|Shape|Overflow|Scrollbar|Transition|Spinner/.test(p),
  },
  { key: 'other', label: 'Autres', icon: 'ellipsis', test: () => true },
];

function propertyGroup(name) {
  return PROPERTY_GROUPS.find((g) => g.test(name));
}

const hasErrors = (control, property) => (diagnostics.get(formulaUri(control, property)) || []).length > 0;

class PropsProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.nodesById = new Map();
  }

  refreshView() {
    this._emitter.fire();
  }

  /** Small or not yet loaded lists stay flat; full lists from Studio are grouped by category. */
  getChildren(node) {
    if (node) return node.children || [];
    this.nodesById = new Map();
    if (!current || current.control === 'Unknown') return [];
    const control = current.control;
    const listed = propertiesByControl.get(control);
    const known = [...meta.values()].filter((m) => m.control === control).map((m) => m.property);
    const names = listed ? [...listed, ...known.filter((p) => !listed.includes(p))] : known.sort();
    const prop = (name, parent) => {
      const n = { kind: 'property', control, name, parent };
      this.nodesById.set(`prop:${control}.${name}`, n);
      return n;
    };
    if (!listed || names.length <= 8) {
      const items = names.map((p) => prop(p, null));
      if (!listed) items.push({ kind: 'load', control });
      return items;
    }
    const groups = PROPERTY_GROUPS.map((g) => ({ kind: 'group', group: g, control, children: [] }));
    for (const p of names) {
      const g = groups[PROPERTY_GROUPS.indexOf(propertyGroup(p))];
      g.children.push(prop(p, g));
    }
    return groups.filter((g) => g.children.length);
  }

  getParent(node) {
    return node.parent || undefined;
  }

  /** The node of the current property, for reveal(). */
  currentNode() {
    return current ? this.nodesById.get(`prop:${current.control}.${current.property}`) : undefined;
  }

  getTreeItem(node) {
    if (node.kind === 'load') {
      const it = new vscode.TreeItem('Charger toutes les propriétés depuis Studio…', vscode.TreeItemCollapsibleState.None);
      it.iconPath = new vscode.ThemeIcon('cloud-download');
      it.command = { command: 'powerappsBridge.loadProperties', title: 'Charger' };
      return it;
    }
    if (node.kind === 'group') {
      const g = node.group;
      const it = new vscode.TreeItem(
        g.label,
        g.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
      );
      it.id = `group:${g.key}`; // stable across controls: VS Code keeps the expanded/collapsed choice
      const errors = node.children.filter((c) => hasErrors(c.control, c.name)).length;
      const hasCurrent = node.children.some((c) => current && c.name === current.property);
      it.iconPath = errors
        ? new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'))
        : new vscode.ThemeIcon(g.icon, hasCurrent ? new vscode.ThemeColor('charts.blue') : undefined);
      it.description = `${node.children.length}` + (errors ? ` · ${errors} en erreur` : '') + (hasCurrent ? ' · ●' : '');
      return it;
    }
    const it = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    it.id = `prop:${node.control}.${node.name}`;
    const isCurrent = current && current.control === node.control && current.property === node.name;
    const formula = knownFormula(node.control, node.name);
    const errors = diagnostics.get(formulaUri(node.control, node.name)) || [];
    it.iconPath = errors.length
      ? new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'))
      : new vscode.ThemeIcon(
          /^On[A-Z]/.test(node.name) ? 'zap' : 'symbol-property',
          isCurrent ? new vscode.ThemeColor('charts.blue') : undefined
        );
    if (formula !== undefined) it.description = (isCurrent ? '● ' : '') + preview(formula);
    else if (isCurrent) it.description = '●';
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${node.control}.${node.name}**\n\n`);
    if (formula !== undefined) md.appendCodeblock(formula, 'powerfx');
    else md.appendMarkdown('_Formule pas encore chargée : clique pour l’ouvrir._');
    if (errors.length) md.appendMarkdown('\n\n' + errors.map((d) => `⚠ ${d.message}`).join('\n\n'));
    it.tooltip = md;
    it.command = { command: 'powerappsBridge.openFormula', title: 'Ouvrir', arguments: [node.control, node.name] };
    return it;
  }
}

const appTree = new AppTreeProvider();
const propsView = new PropsProvider();
const screenPreview = new ScreenPreview({
  request,
  select: (name) => goTo(name, undefined),
  current: () => current,
  errorControls: () => errorControls(),
  screens: () => screenNames(),
  connected: () => openClients().length > 0,
  config,
});
let treeView;
let propsTreeView;
let fxTools = null; // fx-tools.js (references, rename, lint, naming…), set in activate()
let treeRefreshTimer = null;
let lastPropsControl = null;

let treeComplete = false; // treeControls holds the whole app (crawled), not only the rows Studio shows
let crawling = null;
let lastCrawlAttempt = 0;
let lastTreeSummary = '';
let emptyLoadRetries = 0;

/**
 * Merges what Studio's tree view shows now (partial: collapsed nodes and rows out of view are missing)
 * into the full inventory: new controls are inserted after the row that precedes them.
 */
function mergeVisible(full, visible) {
  const out = full.map((c) => ({ ...c }));
  const index = () => new Map(out.map((c, i) => [c.name, i]));
  let at = index();
  let prev = -1;
  for (const v of visible) {
    if (at.has(v.name)) {
      const i = at.get(v.name);
      Object.assign(out[i], { level: v.level, hint: v.hint || out[i].hint });
      prev = i;
      continue;
    }
    let i = prev + 1;
    while (i < out.length && out[i].level > v.level) i++; // skip the previous sibling's subtree
    out.splice(i, 0, { ...v });
    at = index();
    prev = i;
  }
  return out;
}

/** Loads every control of the app (Studio's tree is expanded/scrolled, then restored). */
async function loadFullTree({ quiet = false } = {}) {
  if (crawling) return crawling;
  crawling = vscode.window
    .withProgress(
      { location: { viewId: 'powerappsBridge.tree' }, title: 'Chargement de toute l’arborescence…' },
      async () => {
        lastCrawlAttempt = Date.now();
        // Studio's own data gives the whole tree at once, but only once Studio has rendered its tree view:
        // wait for it (up to ~15 s) before falling back to the slow crawl of the tree view.
        let all = null;
        for (let i = 0; i < 10 && openClients().length; i++) {
          const visible = await request('listControls', {}, 10000).catch(() => []);
          if (visible.length && visible[0].source === 'model') {
            all = visible;
            break;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (!all) all = await request('crawlTree', {}, 60000);
        if (all && all.length) {
          treeControls = all;
          treeComplete = true;
          emptyLoadRetries = 0;
          const screens = all.filter((c) => c.level === 1).length;
          const how = all[0].source === 'model' ? 'read from Studio data' : 'tree view crawled';
          log(`Full tree loaded (${how}): ${all.length} entries (${screens} screens, ${all.length - screens} controls)`);
          if (!lastExport && config().get('exportOnConnect', true)) exportApp({ quiet: true }).catch(() => {});
        } else {
          log('Full tree load returned nothing (Studio tree view not open or not rendered yet)');
          if (quiet && emptyLoadRetries++ < 5) setTimeout(() => !treeComplete && openClients().length && loadFullTree({ quiet: true }), 3000);
          if (!quiet) vscode.window.showWarningMessage('Power Apps : arborescence vide. Ouvre le panneau Arborescence dans Studio.');
        }
      }
    )
    .catch((e) => {
      log(`Full tree load failed: ${e.message}`);
      if (!quiet) vscode.window.showWarningMessage(`Power Apps : ${e.message}`);
    })
    .finally(() => {
      crawling = null;
      appTree.refreshView();
      revealCurrent();
      screenPreview.post();
    });
  return crawling;
}

async function refreshTree({ full = false, expand = false, quiet = false } = {}) {
  if (full) return loadFullTree({ quiet });
  if (crawling) return; // the crawl drives the tree view: its partial states are meaningless
  try {
    const visible = await request(expand ? 'expandTree' : 'listControls', {}, expand ? 180000 : 10000);
    const fromModel = visible.length > 0 && visible[0].source === 'model'; // whole app, read from Studio's data
    treeControls = treeComplete && !expand && !fromModel ? mergeVisible(treeControls, visible) : visible;
    if (expand || fromModel) treeComplete = true;
    if (fromModel && !lastExport && !exporting && config().get('exportOnConnect', true)) exportApp({ quiet: true }).catch(() => {});
    const summary = `${fromModel ? 'Studio data' : 'visible rows'}: ${visible.length} entries`;
    if (summary !== lastTreeSummary) log(`Tree refreshed (${(lastTreeSummary = summary)})`);
    // The automatic crawl at connection time can run before Studio has rendered its tree view: retry
    // once the tree shows rows (rate-limited so a crawl that keeps failing does not loop).
    if (
      !treeComplete &&
      visible.length &&
      config().get('loadFullTree', true) &&
      Date.now() - lastCrawlAttempt > 30000
    ) {
      setTimeout(() => loadFullTree({ quiet: true }), 0);
    }
  } catch (e) {
    if (!quiet) vscode.window.showWarningMessage(`Power Apps : ${e.message}`);
  }
  appTree.refreshView();
  revealCurrent();
  screenPreview.post(); // screen list
}

function revealCurrent() {
  if (!treeView || !treeView.visible || !current) return;
  const node = appTree.byName.get(current.control);
  if (node) treeView.reveal(node, { select: true, focus: false, expand: false }).then(undefined, () => {});
}

async function loadProperties({ quiet = false } = {}) {
  if (!current) return;
  try {
    propertiesByControl.set(current.control, await request('listProperties'));
  } catch (e) {
    if (!quiet) vscode.window.showWarningMessage(`Power Apps: ${e.message}`);
  }
  propsView.refreshView();
  revealCurrentProperty();
}

/** Show the current property in the Properties view, expanding its category if needed. */
function revealCurrentProperty() {
  setTimeout(() => {
    if (!propsTreeView || !propsTreeView.visible) return;
    const node = propsView.currentNode();
    if (node) propsTreeView.reveal(node, { select: true, focus: false, expand: false }).then(undefined, () => {});
  }, 150); // after the view has asked for its new children
}

function updateViews() {
  if (propsTreeView) propsTreeView.description = current ? current.control : undefined;
  propsView.refreshView();
  revealCurrentProperty();
  // Fetching the property list opens Studio's property dropdown: only do it automatically
  // when the user is working in VS Code and looking at the Properties view.
  if (
    current &&
    current.control !== lastPropsControl &&
    !propertiesByControl.has(current.control) &&
    propsTreeView &&
    propsTreeView.visible &&
    vscode.window.state.focused
  ) {
    lastPropsControl = current.control;
    loadProperties({ quiet: true });
  }
}

function scheduleTreeRefresh() {
  appTree.refreshView();
  updateViews();
  clearTimeout(treeRefreshTimer);
  treeRefreshTimer = setTimeout(() => refreshTree({ quiet: true }), 600);
}

async function cmdOpenFormula(control, property) {
  if (current && current.control === control && current.property === property) return openFormula(control, property);
  await goTo(control, property);
  await openFormula(control, property);
}

/** Searchable list of every control of the app, with its type and where it sits. */
async function cmdGoToControl() {
  if (!treeComplete && openClients().length) await loadFullTree({ quiet: true });
  const names = [...new Set([...appTree.byName.keys(), ...knownControls()])];
  if (!names.length) return vscode.window.showWarningMessage('Power Apps : aucun contrôle connu. Ouvre une app dans Studio.');
  const items = names.map((name) => {
    const node = appTree.byName.get(name) || { name, children: [] };
    const type = controlType(node);
    const errors = controlErrors(name).length;
    return {
      label: `$(${errors ? 'error' : type.icon}) ${name}`,
      name,
      description: [name === current?.control ? '● sélectionné' : '', type.label, errors ? `${errors} erreur(s)` : '']
        .filter(Boolean)
        .join(' · '),
      detail: nodePath(node).join(' › ') || undefined,
    };
  });
  const order = new Map(names.map((n, i) => [n, treeNames().indexOf(n) >= 0 ? treeNames().indexOf(n) : 1e6 + i]));
  items.sort((a, b) => order.get(a.name) - order.get(b.name));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Contrôle à sélectionner dans Studio (nom, type ou écran)',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (pick) await goTo(pick.name, undefined);
}

/** Pick a property of a control (loads the list from Studio), then open its formula. */
async function cmdPickProperty(control) {
  control = (control && control.name) || control || current?.control;
  if (!control) return;
  if (!current || current.control !== control) await goTo(control, undefined);
  if (!propertiesByControl.has(control)) await loadProperties({ quiet: true });
  const props = propertiesByControl.get(control) || [...meta.values()].filter((m) => m.control === control).map((m) => m.property);
  const items = props.map((p) => {
    const f = knownFormula(control, p);
    const g = propertyGroup(p);
    return { label: `$(${g.icon}) ${p}`, property: p, description: g.label, detail: f !== undefined ? preview(f) : undefined };
  });
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `Propriété de ${control}`, matchOnDescription: true });
  if (pick) await cmdOpenFormula(control, pick.property);
}

async function cmdRenameControl(node) {
  const name = (node && node.name) || node || current?.control;
  if (!name) return;
  const taken = new Set([...appTree.byName.keys()].map((n) => n.toLowerCase()));
  const suggestion = fxTools && fxTools.suggestName(name);
  const newName = await vscode.window.showInputBox({
    title: `Renommer ${name}`,
    value: suggestion || name,
    valueSelection: [0, (suggestion || name).length],
    prompt: `Studio met à jour les formules qui y font référence.${suggestion ? ' (nom suggéré selon la convention de l’app)' : ''}`,
    validateInput: (v) => {
      v = v.trim();
      if (!v) return 'Nom requis';
      if (/[.'"!\[\]]/.test(v)) return 'Caractères interdits : . \' " ! [ ]';
      if (v.toLowerCase() !== name.toLowerCase() && taken.has(v.toLowerCase())) return 'Ce nom est déjà utilisé';
      return null;
    },
  });
  if (!newName || newName.trim() === name) return;
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Renommage de ${name}…` }, () =>
      renameControlInStudio(name, newName.trim())
    );
    vscode.window.setStatusBarMessage(`$(check) ${name} → ${newName.trim()}`, 4000);
  } catch (e) {
    vscode.window.showWarningMessage(`Power Apps : ${e.message}`);
  }
}

/** Renames through Studio (which updates every reference), then refreshes the tree and, by default, the formulas. */
async function renameControlInStudio(name, newName, { refresh = true } = {}) {
  const all = await request('renameControl', { control: name, newName, path: pathOf(name) }, 120000);
  if (all && all.length) {
    treeControls = all;
    treeComplete = true;
  }
  appTree.refreshView();
  if (refresh) await afterRenames();
}

/** Formulas that referred to renamed controls changed in Studio: re-read the app. */
async function afterRenames() {
  if (lastExport || config().get('exportOnConnect', true)) await exportApp({ quiet: true }).catch(() => {});
}

async function cmdGoToFormula() {
  // Formulas seen this session, plus a free-form "Control.Property" entry.
  const items = [...meta.values()]
    .filter((m) => m.control !== 'Unknown')
    .map((m) => ({ label: `${m.control}.${m.property}`, control: m.control, property: m.property }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const qp = vscode.window.createQuickPick();
  qp.placeholder = 'Control.Property (e.g. Button1.OnSelect)';
  qp.items = items;
  qp.onDidChangeValue((v) => {
    const extra = v.includes('.') && !items.some((i) => i.label === v) ? [{ label: v, description: 'go to', free: true }] : [];
    qp.items = [...extra, ...items];
  });
  const choice = await new Promise((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0]));
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (!choice) return;
  let { control, property } = choice;
  if (choice.free) {
    const i = choice.label.lastIndexOf('.');
    control = choice.label.slice(0, i).trim().replace(/^'|'$/g, '');
    property = choice.label.slice(i + 1).trim();
  }
  await goTo(control, property);
}

/** Controls that have at least one formula with errors. */
function errorControls() {
  const out = new Set();
  for (const m of meta.values()) if ((diagnostics.get(formulaUri(m.control, m.property)) || []).length) out.add(m.control);
  return [...out];
}

/** Screens = top-level entries of Studio's tree view (minus the App node). */
function screenNames() {
  return treeControls
    .map((c) => (typeof c === 'string' ? { name: c, level: 1 } : c))
    .filter((c) => c.level === 1 && !/^app$/i.test(c.name))
    .map((c) => c.name);
}

async function cmdHelp() {
  const connected = openClients().length > 0;
  const items = [
    { label: '$(book) Guide de démarrage', run: () => openWalkthrough() },
    connected && { label: '$(device-desktop) Aperçu de l’écran', run: () => screenPreview.show() },
    connected && { label: '$(go-to-file) Aller à une formule…', description: 'Ctrl+Alt+G', run: cmdGoToFormula },
    !connected && {
      label: '$(link-external) Ouvrir Power Apps',
      description: 'make.powerapps.com',
      run: () => vscode.env.openExternal(vscode.Uri.parse('https://make.powerapps.com/')),
    },
    {
      label: config().get('followSelection', true)
        ? '$(eye-closed) Ne plus suivre la sélection de Studio'
        : '$(eye) Suivre la sélection de Studio',
      run: () => vscode.commands.executeCommand('powerappsBridge.toggleFollow'),
    },
    { label: '$(debug-restart) Redémarrer le serveur', description: `port ${config().get('port', 8765)}`, run: startServer },
    { label: '$(output) Afficher le journal', run: () => output.show(true) },
    { label: '$(gear) Paramètres', run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'powerappsBridge') },
  ].filter(Boolean);
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: connected ? 'Power Apps : connecté à Studio' : 'Power Apps : en attente de Studio (extension navigateur)',
  });
  if (pick) await pick.run();
}

let extensionId = '';
function openWalkthrough() {
  return vscode.commands.executeCommand('workbench.action.openWalkthrough', `${extensionId}#powerappsBridge.start`, false);
}

/**
 * Ctrl+click in a formula: a control name selects it in Studio, Control.Property opens that formula
 * (only when the property is known, so output properties like Gallery1.Selected just select the control).
 */
const documentLinkProvider = {
  provideDocumentLinks(doc) {
    const controls = new Set(knownControls());
    if (!controls.size) return [];
    const text = doc.getText();
    const links = [];
    const re = /"(?:[^"]|"")*"|\/\/[^\n]*|\/\*[\s\S]*?\*\/|'([^'\n]+)'|([A-Za-z_]\w*)/g;
    let m;
    while ((m = re.exec(text))) {
      const name = m[1] ?? m[2];
      if (!name || !controls.has(name)) continue;
      const after = /^\s*\.\s*([A-Za-z_]\w*)/.exec(text.slice(re.lastIndex, re.lastIndex + 80));
      const props = propertiesByControl.get(name);
      const command = (id, args) => vscode.Uri.parse(`command:${id}?${encodeURIComponent(JSON.stringify(args))}`);
      let link;
      if (after && props && props.includes(after[1])) {
        const end = re.lastIndex + after[0].length;
        link = new vscode.DocumentLink(
          new vscode.Range(doc.positionAt(m.index), doc.positionAt(end)),
          command('powerappsBridge.openFormula', [name, after[1]])
        );
        link.tooltip = `Ouvrir ${name}.${after[1]}`;
      } else {
        link = new vscode.DocumentLink(
          new vscode.Range(doc.positionAt(m.index), doc.positionAt(re.lastIndex)),
          command('powerappsBridge.selectControl', [name])
        );
        link.tooltip = `Sélectionner ${name} dans Studio`;
      }
      links.push(link);
    }
    return links;
  },
};

const POWERFX_FUNCTIONS = `Abs Acos Acot AddColumns And Asin Assert AsType Atan Atan2 Average Back Blank Boolean Char Choices Clear ClearCollect ClearData Coalesce Collect Color ColorFade ColorValue Concat Concatenate Confirm Count CountA CountIf CountRows DataSourceInfo Date DateAdd DateDiff DateTimeValue DateValue Day Dec2Hex Degrees Disable Distinct Download DropColumns EDate EditForm Enable EncodeHTML EncodeUrl EndsWith EOMonth Error Errors Exit Exp Filter Find First FirstN ForAll GroupBy GUID Hex2Dec Hour If IfError Index Int IsBlank IsBlankOrError IsEmpty IsError IsMatch IsNumeric ISOWeekNum IsToday IsType JSON Language Last LastN Launch Left Len Ln LoadData Log LookUp Lower Match MatchAll Max Mid Min Minute Mod Month Navigate NewForm Not Notify Now Or Param ParseJSON Patch PDF Pi PlainText Power Proper Radians Rand RandBetween RecordInfo Refresh Relate Remove RemoveIf RenameColumns Replace RequestHide Reset ResetForm Revert RGBA Right Round RoundDown RoundUp SaveData Search Second Select Sequence Set SetFocus SetProperty ShowColumns Shuffle Sort SortByColumns Split Sqrt StartsWith StdevP Substitute SubmitForm Sum Switch Table Text Time TimeValue TimeZoneOffset Today Trace Trim TrimEnds Trunc UniChar Unrelate Update UpdateContext UpdateIf Upper UTCNow UTCToday Value VarP Weekday WeekNum With Year`.split(/\s+/);
const ALL_FUNCTIONS = [...new Set([...POWERFX_FUNCTIONS, ...Object.keys(FX.FUNCTIONS)])].sort();

/** Properties of a control type: Studio's lists for other controls of that type, else the usual ones. */
function propertiesForType(typeKey) {
  if (!typeKey) return null;
  const set = new Set();
  for (const [name, props] of propertiesByControl) {
    const node = appTree.byName.get(name);
    if (node && controlType(node).key === typeKey) props.forEach((p) => set.add(p));
  }
  for (const p of FX.TYPE_PROPERTIES[typeKey] || []) set.add(p);
  return set.size ? [...set] : null;
}

function propertiesOf(name) {
  if (propertiesByControl.has(name)) return propertiesByControl.get(name);
  const node = appTree.byName.get(name);
  if (node) return propertiesForType(controlType(node).key) || [];
  return FX.GLOBALS[name] || [];
}

const quoteName = (n) => (/^[A-Za-z_]\w*$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`);
const fxSignature = (f) => (FX.FUNCTIONS[f] ? `${f}(${FX.FUNCTIONS[f][0]})` : `${f}(…)`);

/** Variables and collections defined in the formulas known so far (Set, UpdateContext, Collect…). */
function knownVariables() {
  const vars = new Map(); // name -> kind
  for (const f of fsProvider.files.values()) {
    const t = f.data.toString('utf8');
    for (const m of t.matchAll(/\bSet\s*\(\s*([A-Za-z_]\w*)/g)) vars.set(m[1], 'Variable globale');
    for (const m of t.matchAll(/\b(?:ClearCollect|Collect)\s*\(\s*([A-Za-z_]\w*)/g)) vars.set(m[1], 'Collection');
    for (const m of t.matchAll(/\bUpdateContext\s*\(\s*\{([^}]*)\}/g)) {
      for (const v of m[1].matchAll(/([A-Za-z_]\w*)\s*:/g)) vars.set(v[1], 'Variable de contexte');
    }
  }
  return vars;
}

function controlDoc(name) {
  const node = appTree.byName.get(name);
  const md = new vscode.MarkdownString();
  const type = node ? controlType(node) : null;
  md.appendMarkdown(`**${name}**${type ? ` · ${type.label}${node.type ? ` (\`${node.type}\`)` : ''}` : ''}\n\n`);
  if (node) {
    const p = nodePath(node);
    if (p.length) md.appendMarkdown(`${p.join(' › ')} › ${name}\n\n`);
  }
  const props = propertiesOf(name);
  if (props.length) md.appendMarkdown(`Propriétés : ${props.slice(0, 30).join(', ')}${props.length > 30 ? '…' : ''}`);
  return md;
}

const completionProvider = {
  provideCompletionItems(document, position) {
    const before = document.lineAt(position).text.slice(0, position.character);
    const dot = /('(?:[^']|'')+'|[A-Za-z_]\w*)\.\w*$/.exec(before);
    if (dot) {
      const name = dot[1].replace(/^'|'$/g, '').replace(/''/g, "'");
      const declared = propertiesByControl.has(name);
      return propertiesOf(name).map((p) => {
        const it = new vscode.CompletionItem(p, FX.GLOBALS[name] ? vscode.CompletionItemKind.EnumMember : vscode.CompletionItemKind.Property);
        if (!declared && appTree.byName.has(name)) it.detail = 'propriété usuelle du type';
        return it;
      });
    }
    const items = ALL_FUNCTIONS.map((f) => {
      const it = new vscode.CompletionItem(f, vscode.CompletionItemKind.Function);
      it.insertText = new vscode.SnippetString(`${f}($0)`);
      it.command = { command: 'editor.action.triggerParameterHints', title: '' };
      if (FX.FUNCTIONS[f]) {
        it.detail = fxSignature(f);
        it.documentation = FX.FUNCTIONS[f][1];
      }
      return it;
    });
    for (const k of FX.KEYWORDS) items.push(new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword));
    for (const c of knownControls()) {
      const node = appTree.byName.get(c);
      const it = new vscode.CompletionItem(c, node && node.level === 1 ? vscode.CompletionItemKind.Module : vscode.CompletionItemKind.Variable);
      it.insertText = quoteName(c);
      it.filterText = c;
      it.detail = node ? controlType(node).label + (nodePath(node)[0] ? ` · ${nodePath(node)[0]}` : '') : 'Contrôle';
      items.push(it);
    }
    for (const [v, kind] of knownVariables()) {
      const it = new vscode.CompletionItem(v, kind === 'Collection' ? vscode.CompletionItemKind.Struct : vscode.CompletionItemKind.Variable);
      it.detail = kind;
      items.push(it);
    }
    return items;
  },
};

const hoverProvider = {
  provideHover(document, position) {
    const range = document.getWordRangeAtPosition(position, /'(?:[^']|'')+'|[A-Za-z_]\w*/);
    if (!range) return;
    const word = document.getText(range).replace(/^'|'$/g, '').replace(/''/g, "'");
    if (FX.FUNCTIONS[word]) {
      const md = new vscode.MarkdownString();
      md.appendCodeblock(fxSignature(word), 'powerfx');
      md.appendMarkdown(FX.FUNCTIONS[word][1]);
      return new vscode.Hover(md, range);
    }
    if (appTree.byName.has(word) || knownControls().includes(word)) return new vscode.Hover(controlDoc(word), range);
    // variables, collections, named formulas: fx-tools hover (definition sites, reads)
  },
};

const signatureProvider = {
  provideSignatureHelp(document, position) {
    const text = document.getText(new vscode.Range(new vscode.Position(Math.max(0, position.line - 50), 0), position));
    // Walk back to the unclosed "(" of the call the cursor is in, skipping strings and nested calls.
    let depth = 0;
    let commas = 0;
    let inString = null;
    for (let i = text.length - 1; i >= 0; i--) {
      const ch = text[i];
      if (inString) {
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'") inString = ch;
      else if (ch === ')' || ch === ']' || ch === '}') depth++;
      else if ((ch === '(' || ch === '[' || ch === '{') && depth > 0) depth--;
      else if (ch === '{' || ch === '[') return; // inside a record/table literal
      else if (ch === ',' && depth === 0) commas++;
      else if (ch === '(' && depth === 0) {
        const name = /([A-Za-z_]\w*)\s*$/.exec(text.slice(0, i));
        if (!name || !FX.FUNCTIONS[name[1]]) return;
        const sig = new vscode.SignatureInformation(fxSignature(name[1]), FX.FUNCTIONS[name[1]][1]);
        const params = FX.FUNCTIONS[name[1]][0].replace(/[[\]…]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
        sig.parameters = [...new Set(params)].map((p) => new vscode.ParameterInformation(p));
        const help = new vscode.SignatureHelp();
        help.signatures = [sig];
        help.activeSignature = 0;
        help.activeParameter = Math.min(commas, sig.parameters.length - 1);
        return help;
      }
    }
  },
};

function activate(context) {
  extensionId = context.extension.id;
  extContext = context;
  output = vscode.window.createOutputChannel('Power Apps X VS Code');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  propertyItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  propertyItem.command = 'powerappsBridge.goToProperty';
  diagnostics = vscode.languages.createDiagnosticCollection('powerfx');
  statusItem.show();

  context.subscriptions.push(
    output,
    statusItem,
    propertyItem,
    diagnostics,
    vscode.languages.registerCompletionItemProvider({ language: 'powerfx' }, completionProvider, '.'),
    vscode.languages.registerHoverProvider({ language: 'powerfx' }, hoverProvider),
    vscode.languages.registerSignatureHelpProvider({ language: 'powerfx' }, signatureProvider, '(', ','),
    vscode.commands.registerCommand('powerappsBridge.goToProperty', cmdGoToProperty),
    vscode.commands.registerCommand('powerappsBridge.goToControl', cmdGoToControl),
    vscode.commands.registerCommand('powerappsBridge.goToFormula', cmdGoToFormula),
    (treeView = vscode.window.createTreeView('powerappsBridge.tree', { treeDataProvider: appTree, showCollapseAll: true })),
    (propsTreeView = vscode.window.createTreeView('powerappsBridge.props', { treeDataProvider: propsView })),
    treeView.onDidChangeVisibility(() => revealCurrent()),
    propsTreeView.onDidChangeVisibility(() => updateViews()),
    vscode.commands.registerCommand('powerappsBridge.loadProperties', () => loadProperties()),
    vscode.commands.registerCommand('powerappsBridge.refreshTree', () => refreshTree({ full: true })),
    vscode.commands.registerCommand('powerappsBridge.expandTree', () => refreshTree({ expand: true })),
    vscode.commands.registerCommand('powerappsBridge.exportApp', () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Power Apps : export de toute l’app…' }, () =>
        exportApp().then((r) => vscode.window.setStatusBarMessage(`$(check) ${r.formulas} formules exportées`, 5000), () => {})
      )
    ),
    vscode.commands.registerCommand('powerappsBridge.renameControl', cmdRenameControl),
    vscode.commands.registerCommand('powerappsBridge.pickProperty', cmdPickProperty),
    vscode.commands.registerCommand('powerappsBridge.selectControl', (name) => goTo(name, undefined)),
    vscode.commands.registerCommand('powerappsBridge.openFormula', cmdOpenFormula),
    vscode.commands.registerCommand('powerappsBridge.showPreview', () => screenPreview.show()),
    vscode.commands.registerCommand('powerappsBridge.revealInPreview', (node) =>
      screenPreview.show({ focus: node && node.name ? node.name : current && current.control })
    ),
    vscode.commands.registerCommand('powerappsBridge.copyName', (node) => {
      const name = node && node.name ? node.name : current && current.control;
      if (name) vscode.env.clipboard.writeText(name);
    }),
    vscode.commands.registerCommand('powerappsBridge.help', cmdHelp),
    vscode.commands.registerCommand('powerappsBridge.openWalkthrough', openWalkthrough),
    vscode.languages.registerDocumentLinkProvider({ language: 'powerfx' }, documentLinkProvider),
    vscode.workspace.registerFileSystemProvider(SCHEME, fsProvider, { isCaseSensitive: true }),
    vscode.workspace.onDidChangeTextDocument(onLocalChange),
    vscode.commands.registerCommand('powerappsBridge.restart', startServer),
    vscode.commands.registerCommand('powerappsBridge.showLog', () => output.show(true)),
    vscode.commands.registerCommand('powerappsBridge.forgetBrowsers', async () => {
      await context.globalState.update(TRUSTED_KEY, []);
      refusedOrigins.clear();
      vscode.window.showInformationMessage('Power Apps X VS Code : les extensions navigateur autorisées ont été oubliées. La prochaine connexion redemandera l’autorisation.');
      startServer(); // drops current connections
    }),
    vscode.commands.registerCommand('powerappsBridge.toggleFollow', async () => {
      const next = !config().get('followSelection', true);
      await config().update('followSelection', next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`Power Apps: follow selection ${next ? 'on' : 'off'}`, 3000);
      updateStatus();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('powerappsBridge.port')) startServer();
      if (e.affectsConfiguration('powerappsBridge.followSelection')) updateStatus();
      if (e.affectsConfiguration('powerappsBridge.mirrorFolder') || e.affectsConfiguration('powerappsBridge.syncFromDisk')) mirrorAll();
    }),
    { dispose: stopServer },
    { dispose: () => diskWatcher && diskWatcher.dispose() }
  );

  fxTools = require('./fx-tools').register(context, {
    version: () => fsProvider.version,
    *formulas() {
      for (const [key, m] of meta) {
        if (m.control === 'Unknown') continue;
        const uri = vscode.Uri.parse(key);
        const f = fsProvider.files.get(uri.path);
        if (f) yield { uri, control: m.control, property: m.property, text: f.data.toString('utf8') };
      }
    },
    controls: () => appTree.byName,
    typeOf: (node) => controlType(node),
    pathOf,
    formula: knownFormula,
    config,
    log,
    selectControl: (name) => goTo(name, undefined),
    openFormula: cmdOpenFormula,
    renameControl: renameControlInStudio,
    afterRenames,
    writeWorkspaceFile: (name, text) => {
      const root = mirrorRoot();
      if (root) mirrorWrite(path.join(root, name), text);
    },
  });
  fsProvider.onChanged = () => fxTools.onFormulasChanged();

  startServer();
  mirrorAll(); // workspace folder: guide, .gitignore, disk watcher

  // First run: show the getting-started walkthrough once.
  if (!context.globalState.get('walkthroughShown')) {
    context.globalState.update('walkthroughShown', true);
    openWalkthrough();
  }
}

function deactivate() {
  stopServer();
}

module.exports = { activate, deactivate };
