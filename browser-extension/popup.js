const $ = (id) => document.getElementById(id);
const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String));

// Static texts: data-i18n (text content) and data-i18n-<attribute> (title, aria-label, placeholder).
document.documentElement.lang = chrome.i18n.getUILanguage();
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
for (const attr of ['title', 'aria-label', 'placeholder']) {
  for (const el of document.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
}

const MODES = { monaco: t('popupModeEditor'), textarea: t('popupModeText') };
const STATES = {
  connected: t('popupStateConnected'),
  connecting: t('popupStateConnecting'),
  disconnected: t('popupStateDisconnected'),
};

async function refresh() {
  let s;
  try {
    s = await chrome.runtime.sendMessage({ type: 'getStatus' });
  } catch {
    s = { state: 'disconnected', port: '?', frames: 0 };
  }
  $('status').dataset.state = s.state;
  $('state').textContent = STATES[s.state] || s.state;
  $('sub').textContent = !s.frames
    ? t('popupSubNoStudio')
    : t(s.state === 'connected' ? 'popupSubLinked' : 'popupSubDetected', s.port);

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
    hint = needsVs ? t('popupHintInstallAndOpen') : t('popupHintOpenApp');
    if (needsVs) actions.push('installVs');
    actions.push('openStudio');
  } else if (s.state !== 'connected') {
    hint = needsVs ? t('popupHintNoResponseInstall') : t('popupHintNoResponsePort', s.port);
    if (needsVs) actions.push('installVs');
    actions.push('reconnectMain');
  } else if (!info) {
    hint = t('popupHintSelectControl');
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
  b.textContent = t('popupSaved');
  b.classList.add('done');
  setTimeout(() => {
    b.textContent = t('popupSave');
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
  out.value = t('popupAnalyzing');
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
    out.value = t('popupError', e.message);
  }
};

$('copy').onclick = async () => {
  await navigator.clipboard.writeText($('out').value);
  $('copy').textContent = t('popupCopied');
  setTimeout(() => ($('copy').textContent = t('popupCopyResult')), 1500);
};
