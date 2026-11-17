// Isolated-world content script: relays messages between page.js (MAIN world) and the service worker.
(() => {
  'use strict';
  const OUT = 'pa-bridge:out';
  const IN = 'pa-bridge:in';
  let port = null;
  let dead = false; // extension reloaded/uninstalled: stop trying

  function toPage(msg) {
    window.postMessage({ channel: IN, msg }, '*');
  }

  function ensurePort() {
    if (port || dead) return port;
    try {
      port = chrome.runtime.connect({ name: 'pa-bridge' });
    } catch {
      dead = true;
      return null;
    }
    port.onMessage.addListener(toPage);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      // Service worker restarted: reconnect and make page.js re-announce its selection.
      setTimeout(() => {
        if (ensurePort()) toPage({ type: 'resync' });
      }, 1000);
    });
    return port;
  }

  // Only frames that actually host the formula bar talk to page.js -> only they open a port.
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.channel !== OUT) return;
    const p = ensurePort();
    if (!p) return;
    try {
      p.postMessage(e.data.msg);
    } catch {
      port = null;
    }
  });
})();
