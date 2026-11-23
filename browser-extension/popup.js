const $ = (id) => document.getElementById(id);

const MODES = { monaco: 'éditeur', textarea: 'texte' };

async function refresh() {
  let s;
  try {
    s = await chrome.runtime.sendMessage({ type: 'getStatus' });
  } catch {
    s = { state: 'disconnected', port: '?', frames: 0 };
  }
  $('status').dataset.state = s.state;
  $('state').textContent =
    { connected: 'Connecté à VS Code', connecting: 'Connexion à VS Code…', disconnected: 'Déconnecté de VS Code' }[s.state] ||
    s.state;
  $('sub').textContent = !s.frames
    ? 'Aucun onglet Power Apps Studio détecté'
    : s.state === 'connected'
      ? `Studio relié · port ${s.port}`
      : `Studio détecté · port ${s.port}`;

  const info = s.lastInfo;
  $('selection').hidden = !info || !info.control;
  if (info && info.control) {
    $('ctrl').textContent = info.control;
    $('prop').textContent = `.${info.property || ''}`;
    $('mode').textContent = MODES[info.mode] || info.mode || '';
    $('mode').hidden = !info.mode;
    $('selection').title = `${info.control}.${info.property}`;
  }

  let hint = '';
  let action = null;
  if (!s.frames) {
    hint = 'Ouvre une canvas app en modification dans Power Apps Studio.';
    action = 'openStudio';
  } else if (s.state !== 'connected') {
    hint = `VS Code ne répond pas sur le port ${s.port}. Vérifie que l’extension « Power Apps X VS Code » est installée dans VS Code avec le même port. À la première connexion, VS Code demande d’autoriser ce navigateur : accepte la demande.`;
    action = 'reconnectMain';
  } else if (!info) {
    hint = 'Sélectionne un contrôle dans Studio : sa formule s’ouvre dans VS Code.';
  }
  $('hint').textContent = hint;
  $('openStudio').hidden = action !== 'openStudio';
  $('reconnectMain').hidden = action !== 'reconnectMain';
}

(async () => {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  const { port } = await chrome.storage.local.get({ port: 8765 });
  $('port').value = port;
  refresh();
  setInterval(refresh, 1000);
})();

async function savePort() {
  const input = $('port');
  if (!input.reportValidity()) return;
  await chrome.storage.local.set({ port: Number(input.value) || 8765 });
  const b = $('save');
  b.textContent = 'Enregistré ✓';
  b.classList.add('done');
  setTimeout(() => {
    b.textContent = 'Enregistrer';
    b.classList.remove('done');
  }, 1500);
}

$('save').onclick = savePort;
$('port').onkeydown = (e) => e.key === 'Enter' && savePort();

const reconnect = () => chrome.runtime.sendMessage({ type: 'reconnect' }).then(refresh, () => {});
$('reconnect').onclick = reconnect;
$('reconnectMain').onclick = reconnect;
$('openStudio').onclick = () => chrome.tabs.create({ url: 'https://make.powerapps.com/' });

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
    out.value = `Erreur : ${e.message}`;
  }
};

$('copy').onclick = async () => {
  await navigator.clipboard.writeText($('out').value);
  $('copy').textContent = 'Copié ✓';
  setTimeout(() => ($('copy').textContent = 'Copier le résultat'), 1500);
};
