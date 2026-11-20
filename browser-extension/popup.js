const $ = (id) => document.getElementById(id);

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'getStatus' });
  $('dot').className = `dot ${s.state}`;
  $('state').textContent =
    { connected: 'Connecté à VS Code', connecting: 'Connexion à VS Code…', disconnected: 'Déconnecté de VS Code' }[s.state] ||
    s.state;
  $('info').textContent = s.lastInfo
    ? `Sélection : ${s.lastInfo.control}.${s.lastInfo.property} (${s.lastInfo.mode})`
    : s.frames
      ? 'Studio détecté, aucune sélection'
      : 'Aucune barre de formule détectée';
  let hint = '';
  if (!s.frames) hint = 'Ouvre une canvas app en modification dans Power Apps Studio (make.powerapps.com).';
  else if (s.state !== 'connected')
    hint = `VS Code n'écoute pas sur le port ${s.port}. Vérifie que l'extension « Power Apps X VS Code » est installée dans VS Code et que le port est le même des deux côtés, puis clique sur Reconnecter.`;
  else if (!s.lastInfo) hint = 'Sélectionne un contrôle dans Studio : sa formule s’ouvre dans VS Code.';
  $('hint').textContent = hint;
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
