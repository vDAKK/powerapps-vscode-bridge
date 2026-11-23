'use strict';

// "Screen preview" webview: a live copy of the current Studio screen. The browser extension serializes the
// screen's HTML with its computed styles (no scripts, no stylesheets); it is re-rendered here, scaled to fit,
// with an overlay to show the selection, errors and search hits. Clicking a control selects it in Studio.

const vscode = require('vscode');
const crypto = require('crypto');
const { escapeHtml: esc, uiLanguage, l10nScript } = require('./ui-icons');

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
        vscode.l10n.t('Power Apps Preview'),
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
    this.panel.title =
      this.mirror && this.mirror.screen
        ? vscode.l10n.t('Preview · {0}', this.mirror.screen)
        : vscode.l10n.t('Power Apps Preview');
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
    const lang = uiLanguage(vscode);
    const T = {
      preview: vscode.l10n.t('Preview'),
      screenShown: vscode.l10n.t('Screen shown in Studio'),
      screen: vscode.l10n.t('Screen'),
      search: vscode.l10n.t('Search for a control'),
      selectFirst: vscode.l10n.t('Select the first result'),
      enter: vscode.l10n.t('Enter'),
      showNames: vscode.l10n.t('Show the name and outline of all controls'),
      refresh: vscode.l10n.t('Refresh from Studio'),
      notConnected: vscode.l10n.t('Studio not connected'),
      notConnectedText: vscode.l10n.t(
        'Open your app in Power Apps Studio with the browser extension enabled: the screen will show up here.'
      ),
      gettingStarted: vscode.l10n.t('Getting started'),
      unavailable: vscode.l10n.t('Preview unavailable'),
      noAnswer: vscode.l10n.t(
        'Studio did not respond ({0}). Reload the browser extension and the Studio tab, then try again.'
      ),
      retry: vscode.l10n.t('Retry'),
      loading: vscode.l10n.t('Loading the screen…'),
      noScreen: vscode.l10n.t('Screen not found'),
      noScreenControls: vscode.l10n.t(
        "Controls are visible but no screen was recognized. Select a screen in Studio's tree view."
      ),
      noCanvas: vscode.l10n.t(
        "Studio's canvas was not found. The page diagnostics (browser extension menu) help explain why."
      ),
      control: vscode.l10n.t('{0} control'),
      controls: vscode.l10n.t('{0} controls'),
      withError: vscode.l10n.t('{0} with an error'),
      withErrors: vscode.l10n.t('{0} with errors'),
      result: vscode.l10n.t('{0} result'),
      results: vscode.l10n.t('{0} results'),
      clickHelp: vscode.l10n.t('Click: select in Studio and open the formula'),
      truncated: vscode.l10n.t('Very busy screen: some elements are not reproduced.'),
      formulaError: vscode.l10n.t('formula error'),
    };
    return /* html */ `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body {
    --sel: var(--vscode-focusBorder); --err: var(--vscode-errorForeground); --match: var(--vscode-editorWarning-foreground, #cca700);
    --line: var(--vscode-panel-border, var(--vscode-widget-border, #8883));
    --muted: var(--vscode-descriptionForeground);
  }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  svg { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }

  /* Toolbar */
  .bar { display: flex; gap: 6px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--line); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  .field { position: relative; display: flex; align-items: center; height: 26px; border-radius: 4px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
  .field[hidden] { display: none; }
  .field:focus-within { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .field svg { position: absolute; left: 7px; color: var(--muted); pointer-events: none; }
  .field select, .field input { height: 100%; border: 0; background: transparent; color: inherit; font: inherit; outline: none; padding: 0 8px 0 28px; }
  .field select { max-width: 200px; cursor: pointer; }
  .field select option { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
  .search { flex: 1; min-width: 140px; }
  .search input { width: 100%; }
  .search input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .search kbd { margin-right: 6px; }
  kbd { font: 10.5px var(--vscode-editor-font-family, monospace); padding: 1px 5px; border-radius: 3px; border: 1px solid var(--line); color: var(--muted); background: var(--vscode-keybindingLabel-background, transparent); white-space: nowrap; }
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 26px; min-width: 26px; padding: 0 6px; border: 0; border-radius: 4px; background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground)); cursor: pointer; font: inherit; }
  .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, #8882); }
  .icon-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  .icon-btn[aria-pressed="true"] { background: var(--vscode-inputOption-activeBackground, #0078d433); color: var(--vscode-inputOption-activeForeground, inherit); box-shadow: inset 0 0 0 1px var(--vscode-inputOption-activeBorder, transparent); }
  .icon-btn.spin svg { animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .sep { width: 1px; height: 18px; background: var(--line); margin: 0 2px; }

  /* Canvas */
  .stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 16px; overflow: hidden;
    background-image: radial-gradient(color-mix(in srgb, var(--vscode-foreground) 14%, transparent) 1px, transparent 1px); background-size: 16px 16px; }
  .frame { position: relative; flex: none; overflow: hidden; background: #fff; border-radius: 6px; box-shadow: 0 1px 2px #0002, 0 8px 28px #0004; outline: 1px solid var(--vscode-widget-border, #8884); }
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
  .tip { position: fixed; pointer-events: none; padding: 4px 8px; background: var(--vscode-editorHoverWidget-background); color: var(--vscode-editorHoverWidget-foreground); border: 1px solid var(--vscode-editorHoverWidget-border); border-radius: 4px; box-shadow: 0 2px 8px #0003; font-size: 12px; display: none; z-index: 10; white-space: nowrap; }
  .tip .bad { color: var(--err); margin-left: 6px; }

  /* Footer */
  .status { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 12px; min-height: 18px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--line); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  .status:empty { display: none; }
  .pill { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; line-height: 16px; }
  .pill i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .pill.err { background: color-mix(in srgb, var(--err) 18%, transparent); color: var(--err); }
  .pill.match { background: color-mix(in srgb, var(--match) 20%, transparent); color: var(--vscode-foreground); }
  .pill.match i { background: var(--match); }
  .status .help { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; }
  .status .warn { flex-basis: 100%; color: var(--vscode-editorWarning-foreground); }

  /* Empty states */
  .empty { max-width: 380px; display: grid; justify-items: center; gap: 10px; text-align: center; line-height: 1.55; color: var(--muted); padding: 24px; border-radius: 10px;
    background: var(--vscode-editor-background); border: 1px solid var(--line); }
  .empty .ico { width: 44px; height: 44px; display: grid; place-items: center; border-radius: 12px; background: color-mix(in srgb, var(--vscode-focusBorder) 14%, transparent); color: var(--vscode-focusBorder); }
  .empty .ico svg { width: 22px; height: 22px; }
  .empty .ico.spin svg { animation: spin 1s linear infinite; }
  .empty h2 { margin: 2px 0 0; font-size: 14px; font-weight: 600; color: var(--vscode-foreground); }
  .empty p { margin: 0; }
  .empty button { margin-top: 4px; height: 28px; padding: 0 14px; border: 0; border-radius: 4px; cursor: pointer; font: inherit; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .empty button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
  <div class="bar" role="toolbar" aria-label="${esc(T.preview)}">
    <label class="field" title="${esc(T.screenShown)}">
      <svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 5.5h12"/></svg>
      <select id="screen" aria-label="${esc(T.screen)}"></select>
    </label>
    <label class="field search">
      <svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>
      <input id="filter" type="search" placeholder="${esc(T.search)}" aria-label="${esc(T.search)}" spellcheck="false">
      <kbd title="${esc(T.selectFirst)}">${esc(T.enter)}</kbd>
    </label>
    <span class="sep" aria-hidden="true"></span>
    <button class="icon-btn" id="names" aria-pressed="false" title="${esc(T.showNames)}">
      <svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="1.5" stroke-dasharray="2 2"/><path d="M5 6h6M5 9h4"/></svg>
    </button>
    <button class="icon-btn" id="refresh" title="${esc(T.refresh)}">
      <svg viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>
    </button>
  </div>
  <div class="stage" id="stage"></div>
  <div class="status" id="status" aria-live="polite"></div>
  <div class="tip" id="tip"></div>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  ${l10nScript(T, lang)}
  const saved = vscode.getState() || { names: false };
  const NAME = 'data-control-name';
  let state = null;
  let html = null;
  let rendered = null; // html currently in the DOM
  let filter = '';
  let hovered = null;

  const ICONS = {
    plug: '<path d="M6 2v3M10 2v3M4.5 5h7v3a3.5 3.5 0 0 1-7 0zM8 11.5V14"/>',
    warn: '<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.2v.1"/>',
    load: '<path d="M8 2a6 6 0 1 0 6 6"/>',
    screen: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 6.5l4 4M10 6.5l-4 4"/>',
  };
  const icon = (name) => '<svg viewBox="0 0 16 16">' + ICONS[name] + '</svg>';

  $('names').onclick = () => { saved.names = !saved.names; vscode.setState(saved); render(); };
  $('refresh').onclick = () => {
    $('refresh').classList.add('spin');
    vscode.postMessage({ type: 'refresh' });
  };
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
    setTimeout(() => $('refresh').classList.remove('spin'), 300);
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

  function empty(ico, title, text, action) {
    rendered = null;
    const stage = $('stage');
    stage.textContent = '';
    const box = el('div', 'empty');
    const i = el('div', 'ico' + (ico === 'load' ? ' spin' : ''));
    i.innerHTML = icon(ico);
    box.append(i, el('h2', null, title));
    if (text) box.append(el('p', null, text));
    if (action) {
      const b = el('button', null, action[0]);
      b.onclick = () => vscode.postMessage(action[1]);
      box.append(b);
    }
    stage.append(box);
  }

  function pill(cls, text) {
    const p = el('span', 'pill' + (cls ? ' ' + cls : ''));
    if (cls) p.append(el('i'));
    p.append(text);
    return p;
  }

  function render() {
    $('names').setAttribute('aria-pressed', String(!!saved.names));
    $('status').textContent = '';
    if (!state) return;
    const mirror = state.mirror;

    const sel = $('screen');
    const screens = [...state.screens];
    if (mirror && mirror.screen && !screens.includes(mirror.screen)) screens.unshift(mirror.screen);
    sel.textContent = '';
    for (const s of screens) sel.append(new Option(s, s, false, !!mirror && s === mirror.screen));
    sel.closest('.field').hidden = !screens.length;

    const command = (c) => ({ type: 'command', command: c });
    if (!state.connected) return empty('plug', T.notConnected, T.notConnectedText, [T.gettingStarted, command('powerappsBridge.openWalkthrough')]);
    if (state.error && !html) return empty('warn', T.unavailable, fmt(T.noAnswer, state.error), [T.retry, { type: 'refresh' }]);
    if (!mirror) return empty('load', T.loading, '');
    if (!html) {
      return empty(
        'screen',
        T.noScreen,
        mirror.controlsFound ? T.noScreenControls : T.noCanvas,
        [T.retry, { type: 'refresh' }]
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
    const status = $('status');
    status.append(pill('', plural(controls().length, T.control, T.controls)));
    const errs = state.errors.filter((n) => controls().includes(n)).length;
    if (errs) status.append(pill('err', plural(errs, T.withError, T.withErrors)));
    if (filter) status.append(pill('match', plural(hits.length, T.result, T.results)));
    const help = el('span', 'help', T.clickHelp);
    status.append(help);
    if (mirror.truncated) status.append(el('div', 'warn', T.truncated));
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
    tip.textContent = name;
    if (state.errors.includes(name)) tip.append(el('span', 'bad', '⚠ ' + T.formulaError));
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
