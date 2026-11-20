// Service worker: owns the WebSocket to VS Code and routes messages to/from the Studio frame.
const VERSION = chrome.runtime.getManifest().version;
const DEFAULT_PORT = 8765;

let ws = null;
let connecting = false;
let wsPort = DEFAULT_PORT;
let reconnectTimer = null;
let backoff = 1000;
let state = 'disconnected';
let lastInfo = null; // { control, property, mode }
const ports = new Set();
let activePort = null;

function setState(s) {
  state = s;
  const badge = { connected: 'ON', connecting: '…', disconnected: '' }[s] ?? '';
  chrome.action.setBadgeText({ text: badge });
  chrome.action.setBadgeBackgroundColor({ color: s === 'connected' ? '#107c10' : '#8a8886' });
}

async function getConfiguredPort() {
  const { port } = await chrome.storage.local.get({ port: DEFAULT_PORT });
  return Number(port) || DEFAULT_PORT;
}

function broadcast(msg) {
  for (const p of ports) {
    try {
      p.postMessage(msg);
    } catch {}
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (ports.size === 0) return; // no Studio tab: stay idle
  reconnectTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 10000);
}

async function connect() {
  if (connecting || (ws && ws.readyState <= 1)) return;
  connecting = true;
  clearTimeout(reconnectTimer);
  try {
    wsPort = await getConfiguredPort();
    const sock = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    ws = sock;
    setState('connecting');
    sock.onopen = () => {
      backoff = 1000;
      setState('connected');
      sock.send(JSON.stringify({ type: 'hello', version: VERSION }));
      broadcast({ type: 'resync' }); // page.js re-announces the current selection
    };
    sock.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'heartbeat') {
        // VS Code's keep-alive: answering keeps this service worker (and the socket) from being suspended.
        sock.send('{"type":"ping"}');
        return;
      }
      if (activePort && ports.has(activePort)) activePort.postMessage(msg);
      else broadcast(msg);
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      setState('disconnected');
      scheduleReconnect();
    };
    sock.onerror = () => {};
  } catch {
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function sendToVsCode(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  else connect(); // message dropped; a resync follows on connect
}

chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== 'pa-bridge') return;
  ports.add(p);
  connect();
  p.onMessage.addListener((msg) => {
    if (msg.type === 'selection' || msg.type === 'formula') {
      activePort = p;
      lastInfo = { control: msg.control, property: msg.property, mode: msg.mode };
    }
    sendToVsCode(msg);
  });
  p.onDisconnect.addListener(() => {
    ports.delete(p);
    if (activePort === p) activePort = null;
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    sendResponse({ state, port: wsPort, lastInfo, frames: ports.size });
  } else if (msg.type === 'reconnect') {
    backoff = 1000;
    if (ws) ws.close();
    else connect();
    sendResponse({ ok: true });
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.port && ws) ws.close(); // onclose -> reconnect on the new port
});

// Keep the WebSocket (and thus the service worker) alive: Chrome suspends an idle worker after ~30 s.
setInterval(() => {
  if (ws && ws.readyState === 1) ws.send('{"type":"ping"}');
}, 10000);
