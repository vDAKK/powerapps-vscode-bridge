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

  // Until VS Code has answered once, the likely cause of "disconnected" is that its extension is missing.
  if (s.state === 'connected') everConnected = true;
  const needsVs = !everConnected && s.state !== 'connected';

  let hint = '';
  const actions = [];
  if (!s.frames) {
    hint = needsVs
      ? 'Cette extension fonctionne avec l’extension « Power Apps X VS Code » pour VS Code : installe-la, puis ouvre une canvas app en modification dans Power Apps Studio.'
      : 'Ouvre une canvas app en modification dans Power Apps Studio.';
    if (needsVs) actions.push('installVs');
    actions.push('openStudio');
  } else if (s.state !== 'connected') {
    hint = needsVs
      ? `VS Code ne répond pas. Installe l’extension « Power Apps X VS Code » dans VS Code et garde VS Code ouvert. À la première connexion, VS Code demande d’autoriser ce navigateur : accepte.`
      : `VS Code ne répond pas sur le port ${s.port}. Vérifie que VS Code est ouvert avec l’extension « Power Apps X VS Code » et le même port. Si VS Code demande d’autoriser ce navigateur, accepte.`;
    if (needsVs) actions.push('installVs');
    actions.push('reconnectMain');
  } else if (!info) {
    hint = 'Sélectionne un contrôle dans Studio : sa formule s’ouvre dans VS Code.';
  }
  $('hint').textContent = hint;
  for (const id of ['installVs', 'openStudio', 'reconnectMain']) {
    $(id).hidden = !actions.includes(id);
    $(id).classList.toggle('primary', id === actions[0]); // one main action at a time
  }
}

let everConnected = false;

(async () => {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  const stored = await chrome.storage.local.get({ port: 8765, everConnected: false });
  $('port').value = stored.port;
  everConnected = stored.everConnected;
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
// The welcome page offers both "open in VS Code" (vscode: link) and the Marketplace page.
$('installVs').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });

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
