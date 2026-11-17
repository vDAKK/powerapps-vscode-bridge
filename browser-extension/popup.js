const $ = (id) => document.getElementById(id);

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'getStatus' });
  $('dot').className = `dot ${s.state}`;
  $('state').textContent =
    { connected: 'Connecté à VS Code', connecting: 'Connexion…', disconnected: 'Déconnecté' }[s.state] || s.state;
  $('info').textContent = s.lastInfo
    ? `${s.lastInfo.control}.${s.lastInfo.property} (${s.lastInfo.mode})`
    : s.frames
      ? 'Studio détecté, aucune sélection'
      : 'Aucune barre de formule détectée (ouvre une app dans Power Apps Studio)';
}

(async () => {
  const { port } = await chrome.storage.local.get({ port: 8765 });
  $('port').value = port;
  refresh();
  setInterval(refresh, 1000);
})();

$('save').onclick = async () => {
  await chrome.storage.local.set({ port: Number($('port').value) || 8765 });
};

$('reconnect').onclick = () => chrome.runtime.sendMessage({ type: 'reconnect' });

$('diag').onclick = async () => {
  const out = $('out');
  out.hidden = false;
  out.value = 'Analyse…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: 'MAIN',
      func: () => (window.__paBridge ? window.__paBridge.diagnose() : { url: location.href, bridgeLoaded: false }),
    });
    out.value = JSON.stringify(
      results.map((r) => ({ frameId: r.frameId, ...r.result })),
      null,
      2
    );
    $('copy').hidden = false;
  } catch (e) {
    out.value = `Erreur: ${e.message}`;
  }
};

$('copy').onclick = () => navigator.clipboard.writeText($('out').value);
