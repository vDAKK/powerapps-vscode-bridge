'use strict';

// "Screen preview" webview: a live copy of the current Studio screen. The browser extension serializes the
// screen's HTML with its computed styles (no scripts, no stylesheets); it is re-rendered here, scaled to fit,
// with an overlay to show the selection, errors and search hits. Clicking a control selects it in Studio.

const vscode = require('vscode');
const crypto = require('crypto');

const POLL_MS = 3000; // catch changes made in Studio (drag, resize, data refresh) while the panel is visible

class ScreenPreview {
  /**
   * @param {object} deps
   *   request(type, payload, timeoutMs) -> Promise, select(name) -> Promise, current() -> {control}|null,
   *   errorControls() -> string[], screens() -> string[], connected() -> boolean
   */
  constructor(deps) {
    this.deps = deps;
    this.panel = null;
    this.mirror = null; // last answer without its html
    this.html = null;
    this.sentHtml = null;
    this.error = null;
    this.timer = null;
    this.poller = null;
    this.running = false;
    this.again = false;
    this.focusName = null;
  }

  get visible() {
    return !!this.panel && this.panel.visible;
  }

  show({ focus } = {}) {
    if (focus) this.focusName = focus;
    if (this.panel) {
      this.panel.reveal(undefined, true);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'powerappsBridge.preview',
        'Aperçu Power Apps',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
      );
      this.panel.iconPath = new vscode.ThemeIcon('device-desktop');
      this.sentHtml = null;
      this.panel.webview.html = this.page();
      this.panel.onDidDispose(() => {
        this.panel = null;
        clearTimeout(this.timer);
        clearInterval(this.poller);
      });
      this.panel.onDidChangeViewState(() => this.visible && this.schedule(0));
      this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
      this.poller = setInterval(() => this.visible && this.deps.connected() && this.refresh(), POLL_MS);
    }
    this.post();
    this.schedule(0);
  }

  onMessage(m) {
    switch (m.type) {
      case 'ready':
        this.sentHtml = null; // the webview (re)loaded: resend the screen
        this.post();
        break;
      case 'select':
        this.deps.select(m.name).then(() => this.schedule(400));
        break;
      case 'screen':
        this.deps.select(m.name).then(() => this.schedule(800));
        break;
      case 'refresh':
        this.schedule(0);
        break;
      case 'command':
        vscode.commands.executeCommand(m.command, ...(m.args || []));
        break;
    }
  }

  /** Refresh the copy of the screen after `delay` ms, coalescing bursts. */
  schedule(delay = 500) {
    if (!this.panel) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), delay);
  }

  async refresh() {
    if (!this.panel || !this.panel.visible) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      if (this.deps.connected()) {
        const { html, ...rest } = await this.deps.request('mirror', {}, 8000);
        this.mirror = rest;
        this.html = html || null;
        this.error = null;
      }
    } catch (e) {
      this.error = e.message;
    } finally {
      this.running = false;
    }
    this.post();
    if (this.again) {
      this.again = false;
      this.schedule(200);
    }
  }

  /** Push the state to the webview; the screen HTML is only resent when it changed. */
  post() {
    if (!this.panel) return;
    const cur = this.deps.current();
    let html;
    if (this.html && this.html !== this.sentHtml) html = this.sentHtml = this.html;
    if (!this.html) this.sentHtml = null;
    this.panel.webview.postMessage({
      type: 'state',
      connected: this.deps.connected(),
      error: this.error,
      mirror: this.mirror,
      html,
      hasHtml: !!this.html,
      selected: cur ? cur.control : null,
      errors: this.deps.errorControls(),
      screens: this.deps.screens(),
      focus: this.focusName,
    });
    this.focusName = null;
    this.panel.title = this.mirror && this.mirror.screen ? `Aperçu · ${this.mirror.screen}` : 'Aperçu Power Apps';
  }

  page() {
    const nonce = crypto.randomBytes(16).toString('base64');
    // Inline styles are needed for the copied screen; scripts stay restricted to this page's own nonce.
    const csp = [
      "default-src 'none'",
      'img-src https: data:',
      'font-src https: data:',
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return /* html */ `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { --sel: var(--vscode-focusBorder); --err: var(--vscode-errorForeground); --match: var(--vscode-editorWarning-foreground, #cca700); }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  .bar select, .bar input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; border-radius: 2px; font: inherit; }
  .bar input { flex: 1; min-width: 120px; }
  .bar select:focus, .bar input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .bar button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; padding: 4px 8px; border-radius: 2px; cursor: pointer; font: inherit; }
  .bar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .bar button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 12px; overflow: hidden; }
  .frame { position: relative; flex: none; overflow: hidden; background: #fff; box-shadow: 0 2px 14px #0005; outline: 1px solid var(--vscode-widget-border, #8884); }
  #mirror { position: absolute; left: 0; top: 0; transform-origin: 0 0; cursor: pointer; }
  #mirror * { cursor: pointer !important; user-select: none; }
  #overlay { position: absolute; inset: 0; pointer-events: none; }
  .ov { position: absolute; box-sizing: border-box; }
  .ov.all { border: 1px dashed color-mix(in srgb, var(--vscode-focusBorder) 60%, transparent); }
  .ov.hover { border: 2px solid var(--sel); background: color-mix(in srgb, var(--vscode-focusBorder) 10%, transparent); }
  .ov.sel { border: 2px solid var(--sel); }
  .ov.err { border: 2px dashed var(--err); }
  .ov.match { border: 2px solid var(--match); background: color-mix(in srgb, var(--match) 15%, transparent); }
  .ov .lbl { position: absolute; left: -2px; bottom: 100%; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px/16px var(--vscode-font-family); padding: 0 5px; border-radius: 3px 3px 0 0; color: var(--vscode-button-foreground); background: var(--sel); }
  .ov.err .lbl { background: var(--err); }
  .ov.all .lbl { position: absolute; left: 0; top: 0; bottom: auto; border-radius: 0 0 3px 0; font-size: 10px; line-height: 13px; background: color-mix(in srgb, var(--vscode-editor-background) 85%, transparent); color: var(--vscode-editor-foreground); }
  .ov.inside .lbl { bottom: auto; top: 0; border-radius: 0 0 3px 0; }
  .tip { position: fixed; pointer-events: none; padding: 3px 7px; background: var(--vscode-editorHoverWidget-background); color: var(--vscode-editorHoverWidget-foreground); border: 1px solid var(--vscode-editorHoverWidget-border); border-radius: 3px; font-size: 12px; display: none; z-index: 10; white-space: nowrap; }
  .status { padding: 4px 10px 8px; font-size: 12px; color: var(--vscode-descriptionForeground); min-height: 1em; }
  .status a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .empty { max-width: 460px; text-align: center; line-height: 1.6; color: var(--vscode-descriptionForeground); }
  .empty h2 { font-size: 15px; color: var(--vscode-foreground); }
</style>
</head>
<body>
  <div class="bar">
    <select id="screen" title="Écran affiché dans Studio"></select>
    <input id="filter" type="search" placeholder="Rechercher un contrôle… (Entrée : le sélectionner)">
    <button id="names" title="Afficher le nom et le contour de tous les contrôles">Noms</button>
    <button id="refresh" title="Actualiser depuis Studio">⟳</button>
  </div>
  <div class="stage" id="stage"></div>
  <div class="status" id="status"></div>
  <div class="tip" id="tip"></div>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const saved = vscode.getState() || { names: false };
  const NAME = 'data-control-name';
  let state = null;
  let html = null;
  let rendered = null; // html currently in the DOM
  let filter = '';
  let hovered = null;

  $('names').onclick = () => { saved.names = !saved.names; vscode.setState(saved); render(); };
  $('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
  $('screen').onchange = (e) => vscode.postMessage({ type: 'screen', name: e.target.value });
  $('filter').oninput = (e) => { filter = e.target.value.trim().toLowerCase(); render(); };
  $('filter').onkeydown = (e) => {
    if (e.key === 'Escape') { e.target.value = ''; filter = ''; render(); }
    if (e.key === 'Enter') {
      const hit = matches()[0];
      if (hit) vscode.postMessage({ type: 'select', name: hit });
    }
  };
  window.addEventListener('resize', () => { layout(); overlays(); });
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.type !== 'state') return;
    if (m.html) html = m.html;
    if (!m.hasHtml) html = null;
    if (m.focus) { $('filter').value = m.focus; filter = m.focus.toLowerCase(); }
    state = m;
    render();
  });

  const controls = () => (state && state.mirror && state.mirror.controls) || [];
  function matches() {
    if (!filter) return [];
    const all = controls();
    const exact = all.filter((n) => n.toLowerCase() === filter);
    return exact.length ? exact : all.filter((n) => n.toLowerCase().includes(filter));
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function empty(title, text, link) {
    rendered = null;
    const stage = $('stage');
    stage.textContent = '';
    const box = el('div', 'empty');
    box.append(el('h2', null, title), el('div', null, text));
    stage.append(box);
    if (link) {
      const a = el('a', null, link[0]);
      a.onclick = () => vscode.postMessage({ type: 'command', command: link[1] });
      $('status').append(a);
    }
  }

  function render() {
    $('names').classList.toggle('on', !!saved.names);
    $('status').textContent = '';
    if (!state) return;
    const mirror = state.mirror;

    const sel = $('screen');
    const screens = [...state.screens];
    if (mirror && mirror.screen && !screens.includes(mirror.screen)) screens.unshift(mirror.screen);
    sel.textContent = '';
    for (const s of screens) sel.append(new Option(s, s, false, !!mirror && s === mirror.screen));
    sel.hidden = !screens.length;

    if (!state.connected) return empty('Studio non connecté', 'Ouvre ton app dans Power Apps Studio avec l’extension navigateur active : l’écran s’affichera ici.', ['Ouvrir le guide de démarrage', 'powerappsBridge.openWalkthrough']);
    if (state.error && !html) return empty('Aperçu indisponible', 'Studio n’a pas répondu (' + state.error + '). Recharge l’extension navigateur et l’onglet Studio, puis actualise.');
    if (!mirror) return empty('Chargement…', '');
    if (!html) {
      return empty(
        'Écran introuvable',
        mirror.controlsFound
          ? 'Des contrôles sont visibles mais aucun écran n’a été reconnu. Sélectionne un écran dans l’arborescence de Studio.'
          : 'Le canevas de Studio n’a pas été trouvé. Le « Diagnostic de la page » (menu de l’extension navigateur) aide à comprendre pourquoi.'
      );
    }

    if (rendered !== html) {
      const stage = $('stage');
      stage.textContent = '';
      const frame = el('div', 'frame');
      frame.id = 'frame';
      const m = el('div');
      m.id = 'mirror';
      m.style.width = mirror.width + 'px';
      m.style.height = mirror.height + 'px';
      m.innerHTML = html;
      const ov = el('div');
      ov.id = 'overlay';
      frame.append(m, ov);
      stage.append(frame);
      m.addEventListener('click', (e) => {
        e.preventDefault();
        const c = e.target.closest('[' + NAME + ']');
        if (c) vscode.postMessage({ type: 'select', name: c.getAttribute(NAME) });
      });
      m.addEventListener('mousemove', (e) => hover(e));
      m.addEventListener('mouseleave', () => hover(null));
      rendered = html;
      layout();
    }
    overlays();

    const hits = matches();
    const parts = [controls().length + ' contrôle(s)'];
    if (state.errors.length) parts.push(state.errors.length + ' en erreur');
    if (filter) parts.push(hits.length + ' correspondance(s)');
    $('status').append(parts.join(' · ') + '. Clic : sélectionner dans Studio et ouvrir sa formule.');
    if (mirror.truncated) $('status').append(el('div', null, 'Écran très chargé : une partie des éléments n’est pas reproduite.'));
  }

  function layout() {
    const frame = $('frame');
    const m = $('mirror');
    if (!frame || !state || !state.mirror) return;
    const stage = $('stage');
    const w = state.mirror.width || 1;
    const h = state.mirror.height || 1;
    const scale = Math.min((stage.clientWidth - 24) / w, (stage.clientHeight - 24) / h);
    frame.style.width = Math.max(40, w * scale) + 'px';
    frame.style.height = Math.max(40, h * scale) + 'px';
    m.style.transform = 'scale(' + scale + ')';
  }

  function boxesOf(name) {
    const frame = $('frame');
    if (!frame) return [];
    const base = frame.getBoundingClientRect();
    const out = [];
    for (const e of $('mirror').querySelectorAll('[' + NAME + '="' + CSS.escape(name) + '"]')) {
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out.push({ left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height });
      if (out.length > 200) break;
    }
    return out;
  }

  function addBoxes(ov, name, cls, label) {
    let first = true;
    for (const b of boxesOf(name)) {
      const d = el('div', 'ov ' + cls);
      d.style.left = b.left + 'px';
      d.style.top = b.top + 'px';
      d.style.width = b.width + 'px';
      d.style.height = b.height + 'px';
      if (b.top < 18) d.classList.add('inside');
      if (label && first) d.append(el('span', 'lbl', label));
      first = false;
      ov.append(d);
    }
  }

  function overlays() {
    const ov = $('overlay');
    if (!ov || !state) return;
    ov.textContent = '';
    if (saved.names) for (const n of controls().slice(0, 300)) addBoxes(ov, n, 'all', n);
    for (const n of matches()) addBoxes(ov, n, 'match', n);
    for (const n of state.errors) addBoxes(ov, n, 'err', n + ' ⚠');
    if (state.selected) addBoxes(ov, state.selected, 'sel', state.selected);
    if (hovered && hovered !== state.selected) addBoxes(ov, hovered, 'hover', null);
  }

  function hover(e) {
    const tip = $('tip');
    const c = e && e.target.closest('[' + NAME + ']');
    const name = c ? c.getAttribute(NAME) : null;
    if (name !== hovered) { hovered = name; overlays(); }
    if (!name) { tip.style.display = 'none'; return; }
    tip.textContent = name + (state.errors.includes(name) ? '  ⚠ erreur de formule' : '');
    tip.style.display = 'block';
    tip.style.left = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 4) + 'px';
    tip.style.top = e.clientY + 14 + 'px';
  }

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
}

module.exports = { ScreenPreview };
