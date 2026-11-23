'use strict';

// "Application" side bar view: the app's screens and controls. A webview rather than a tree view so it can
// carry a summary, an inline filter with highlighting, type glyphs, error counts, hover actions and empty
// states with real buttons. Right-click menus still come from package.json (menus › webview/context).

const vscode = require('vscode');
const crypto = require('crypto');
const { typeIconScript, escapeHtml: esc, uiLanguage, l10nScript } = require('./ui-icons');

class Outline {
  /**
   * @param {object} deps
   *   state() -> payload (see extension.js outlineState), select(name)
   */
  constructor(deps) {
    this.deps = deps;
    this.view = null;
    this.timer = null;
    this.badge = undefined;
  }

  get visible() {
    return !!this.view && this.view.visible;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.page();
    view.badge = this.badge;
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => this.visible && this.post());
    view.onDidDispose(() => (this.view = null));
  }

  setBadge(badge) {
    this.badge = badge;
    if (this.view) this.view.badge = badge;
  }

  onMessage(m) {
    switch (m.type) {
      case 'ready':
        return this.flush();
      case 'select':
        return this.deps.select(m.name);
      case 'command':
        return vscode.commands.executeCommand(m.command, ...(m.args || []));
      case 'open':
        return vscode.env.openExternal(vscode.Uri.parse(m.url));
    }
  }

  post() {
    if (!this.view) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 60);
  }

  flush() {
    if (!this.view || !this.view.visible) return;
    const s = this.deps.state();
    this.view.description = s.screen || undefined;
    this.view.webview.postMessage({ type: 'state', ...s });
  }

  focusFilter() {
    if (this.view) {
      this.view.show(false);
      this.view.webview.postMessage({ type: 'focusFilter' });
    }
  }

  page() {
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = ["default-src 'none'", "style-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`].join('; ');
    const lang = uiLanguage(vscode);
    const T = {
      search: vscode.l10n.t('Search for a control'),
      filterTitle: vscode.l10n.t('Filter by name or type (shortcut: /)'),
      reveal: vscode.l10n.t('Show the selected control'),
      collapse: vscode.l10n.t('Collapse all'),
      tree: vscode.l10n.t('Screens and controls'),
      stopped: vscode.l10n.t('Server stopped'),
      stoppedText: vscode.l10n.t('The port may already be in use by another VS Code window.'),
      restart: vscode.l10n.t('Restart the server'),
      showLog: vscode.l10n.t('Show the log'),
      waiting: vscode.l10n.t('Waiting for Power Apps Studio'),
      openPowerApps: vscode.l10n.t('Open Power Apps'),
      gettingStarted: vscode.l10n.t('Getting started'),
      log: vscode.l10n.t('Log'),
      step1: vscode.l10n.t('Install the "Power Apps X VS Code" browser extension.'),
      step2: vscode.l10n.t('Open your canvas app for editing in Studio.'),
      step3: vscode.l10n.t('Select a control: its formula opens here.'),
      loading: vscode.l10n.t('Loading the app…'),
      loadingText: vscode.l10n.t('Reading screens and controls from Studio.'),
      emptyTree: vscode.l10n.t('Empty tree view'),
      emptyTreeText: vscode.l10n.t(
        'Studio is connected but its Tree view panel is not shown. Open it in Studio, then reload.'
      ),
      reload: vscode.l10n.t('Reload'),
      screen: vscode.l10n.t('{0} screen'),
      screens: vscode.l10n.t('{0} screens'),
      control: vscode.l10n.t('{0} control'),
      controls: vscode.l10n.t('{0} controls'),
      offline: vscode.l10n.t('offline'),
      error: vscode.l10n.t('{0} error'),
      errors: vscode.l10n.t('{0} errors'),
      problems: vscode.l10n.t('Open the Problems view'),
      openProperty: vscode.l10n.t('Open a property…'),
      showInPreview: vscode.l10n.t('Show in the preview'),
      groupTitle: vscode.l10n.t('Controls opened during the session but missing from the loaded tree view'),
      formulaErrors: vscode.l10n.t('{0} formula(s) with errors'),
      defaultName: vscode.l10n.t('Default name: right-click › Rename'),
      noMatch: vscode.l10n.t('No control matches "{0}".'),
    };
    return /* html */ `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --muted: var(--vscode-descriptionForeground);
    --line: var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border, #8883));
    --accent: var(--vscode-focusBorder);
    --err: var(--vscode-errorForeground);
    --guide: var(--vscode-tree-indentGuidesStroke, #8885);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: transparent; user-select: none; }
  svg { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  button { font: inherit; color: inherit; }
  [hidden] { display: none !important; }

  .top { position: sticky; top: 0; z-index: 2; display: grid; gap: 6px; padding: 8px 12px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--line); }
  .sum { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); min-height: 18px; }
  .pill { display: inline-flex; align-items: center; gap: 4px; padding: 0 7px; border-radius: 999px; font-size: 11px; line-height: 16px; border: 0; cursor: pointer;
    background: color-mix(in srgb, var(--err) 18%, transparent); color: var(--err); }
  .pill:hover { background: color-mix(in srgb, var(--err) 28%, transparent); }
  .pill i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .spin { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid var(--muted); border-right-color: transparent; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .bar { display: flex; gap: 4px; align-items: center; }
  .search { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; height: 24px; border-radius: 4px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
  .search:focus-within { outline: 1px solid var(--accent); outline-offset: -1px; }
  .search svg { position: absolute; left: 6px; width: 14px; height: 14px; color: var(--muted); }
  .search input { width: 100%; height: 100%; border: 0; outline: 0; padding: 0 6px 0 25px; background: transparent; color: inherit; font: inherit; }
  .search input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .ib { display: inline-grid; place-items: center; width: 24px; height: 24px; flex: none; border: 0; border-radius: 4px; background: transparent; cursor: pointer; color: var(--vscode-icon-foreground, var(--vscode-foreground)); }
  .ib:hover { background: var(--vscode-toolbar-hoverBackground); }
  .ib:focus-visible { outline: 1px solid var(--accent); }

  /* Tree */
  #tree { padding: 4px 0 12px; }
  .row { position: relative; display: flex; align-items: center; gap: 5px; height: 22px; padding-right: 8px; cursor: pointer; white-space: nowrap; outline: none; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row:focus { outline: 1px solid var(--vscode-list-focusOutline, var(--accent)); outline-offset: -1px; }
  .row.cur { background: var(--vscode-list-inactiveSelectionBackground); color: var(--vscode-list-inactiveSelectionForeground, inherit); }
  .row.cur:focus, body.focused .row.cur { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground, inherit); }
  .row.anc .nm { font-weight: 600; }
  .indent { display: flex; align-self: stretch; flex: none; }
  .indent span { width: 12px; flex: none; }
  .indent span.g { border-left: 1px solid transparent; margin-left: 7px; width: 5px; }
  #tree:hover .indent span.g, .row.cur .indent span.g { border-left-color: var(--guide); }
  .tw { display: inline-grid; place-items: center; width: 16px; height: 16px; flex: none; color: var(--muted); }
  .tw svg { width: 12px; height: 12px; transition: transform .1s; }
  .row.closed .tw svg { transform: rotate(-90deg); }
  .ty { color: var(--muted); display: inline-grid; }
  .row.cur .ty, .row.anc .ty { color: var(--accent); }
  .row.bad .ty { color: var(--err); }
  .row.screen .ty { color: var(--vscode-symbolIcon-classForeground, var(--accent)); }
  .nm { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .row.bad .nm { color: var(--err); }
  .row.def .nm { font-style: italic; }
  .meta { margin-left: auto; display: flex; align-items: center; gap: 6px; padding-left: 8px; font-size: 11px; color: var(--muted); }
  .meta .e { color: var(--err); font-weight: 600; }
  .acts { display: none; gap: 2px; }
  .row:hover .acts, .row:focus .acts { display: flex; }
  .row:hover .cnt, .row:focus .cnt { display: none; }
  .acts button { display: inline-grid; place-items: center; width: 20px; height: 20px; border: 0; border-radius: 3px; background: transparent; cursor: pointer; color: var(--vscode-icon-foreground, var(--vscode-foreground)); }
  .acts button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .acts svg { width: 14px; height: 14px; }
  mark { background: var(--vscode-editor-findMatchHighlightBackground, #ea5c0055); color: inherit; border-radius: 2px; }
  .none { padding: 14px 12px; color: var(--muted); font-size: 12px; }

  /* Empty states */
  .empty { padding: 22px 16px; display: grid; gap: 12px; color: var(--muted); line-height: 1.5; }
  .empty .ico { width: 40px; height: 40px; display: grid; place-items: center; border-radius: 10px; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
  .empty b { color: var(--vscode-foreground); font-size: 13px; }
  .steps { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; counter-reset: s; }
  .steps li { display: flex; gap: 8px; counter-increment: s; }
  .steps li::before { content: counter(s); flex: none; width: 18px; height: 18px; display: grid; place-items: center; border-radius: 50%; font-size: 11px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .btns { display: flex; flex-wrap: wrap; gap: 6px; }
  .btn { height: 26px; padding: 0 12px; border: 0; border-radius: 4px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn.primary:hover { background: var(--vscode-button-hoverBackground); }
  .link { border: 0; background: none; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 12px; }
</style>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
  <div id="empty" class="empty" hidden></div>
  <div id="main" hidden>
    <div class="top">
      <div class="sum" id="sum"></div>
      <div class="bar">
        <label class="search">
          <svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>
          <input id="filter" type="search" placeholder="${esc(T.search)}" aria-label="${esc(T.search)}" spellcheck="false" title="${esc(T.filterTitle)}">
        </label>
        <button class="ib" id="reveal" title="${esc(T.reveal)}" aria-label="${esc(T.reveal)}">
          <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5"/><circle cx="8" cy="8" r="1.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2"/></svg></button>
        <button class="ib" id="collapse" title="${esc(T.collapse)}" aria-label="${esc(T.collapse)}">
          <svg viewBox="0 0 16 16"><path d="m4.5 9.5 3.5-3 3.5 3"/><path d="M3 13h10"/></svg></button>
      </div>
    </div>
    <div id="tree" role="tree" aria-label="${esc(T.tree)}"></div>
  </div>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  ${typeIconScript()}
  ${l10nScript(T, lang)}
  const ui = Object.assign({ open: {} }, vscode.getState() || {});
  const save = () => vscode.setState(ui);
  let s = null;
  let filter = '';
  let lastCurrent = null;
  let nodes = [];
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const svg = (inner) => '<svg viewBox="0 0 16 16">' + inner + '</svg>';
  const CHEVRON = svg('<path d="m4 6 4 4 4-4"/>');
  const EYE = svg('<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>');
  const PROPS = svg('<path d="M3 4h10M3 8h10M3 12h6"/>');
  const cmd = (command, args) => vscode.postMessage({ type: 'command', command, args });

  window.addEventListener('focus', () => document.body.classList.add('focused'));
  window.addEventListener('blur', () => document.body.classList.remove('focused'));
  $('filter').oninput = (e) => { filter = e.target.value.trim().toLowerCase(); render(); };
  $('filter').onkeydown = (e) => {
    if (e.key === 'Escape') { e.target.value = ''; filter = ''; render(); }
    if (e.key === 'ArrowDown') { const r = document.querySelector('.row'); if (r) { e.preventDefault(); r.focus(); } }
    if (e.key === 'Enter') { const r = document.querySelector('.row.hit') || document.querySelector('.row'); if (r) select(r.dataset.name); }
  };
  $('collapse').onclick = () => { ui.open = {}; save(); render(); };
  $('reveal').onclick = () => { if (s && s.current) { openPath(s.current); render(); scrollToCurrent(true); } };

  // Keyboard navigation, like a native tree.
  document.addEventListener('keydown', (e) => {
    const row = e.target.closest && e.target.closest('.row');
    if (e.key === '/' && document.activeElement !== $('filter')) { e.preventDefault(); $('filter').focus(); return; }
    if (!row) return;
    const rows = [...document.querySelectorAll('.row')];
    const i = rows.indexOf(row);
    const n = nodes[row.dataset.i];
    const go = (r) => { if (r) { e.preventDefault(); r.focus(); } };
    if (e.key === 'ArrowDown') go(rows[i + 1]);
    else if (e.key === 'ArrowUp') rows[i - 1] ? go(rows[i - 1]) : (e.preventDefault(), $('filter').focus());
    else if (e.key === 'Home') go(rows[0]);
    else if (e.key === 'End') go(rows[rows.length - 1]);
    else if (e.key === 'ArrowRight' && n.kids) { e.preventDefault(); if (!isOpen(n)) toggle(n, true); else go(rows[i + 1]); }
    else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (n.kids && isOpen(n)) toggle(n, false);
      else if (n.parent != null) go(document.querySelector('.row[data-i="' + n.parent + '"]'));
    }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!n.group) select(n.name); }
    else if (e.key === 'F2' && !n.group) { e.preventDefault(); cmd('powerappsBridge.renameControl', [{ name: n.name }]); }
  });

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'focusFilter') { $('filter').focus(); $('filter').select(); }
    if (m.type !== 'state') return;
    s = m;
    build();
    if (s.current && s.current !== lastCurrent) { openPath(s.current); lastCurrent = s.current; render(); scrollToCurrent(false); }
    else render();
  });

  /** Flat rows (depth-first, with levels) -> nodes with parent indexes. */
  function build() {
    nodes = [];
    const stack = [];
    for (const r of s.rows) {
      while (stack.length && nodes[stack[stack.length - 1]].level >= r.level) stack.pop();
      const parent = stack.length ? stack[stack.length - 1] : null;
      const n = Object.assign({}, r, { i: nodes.length, parent, kids: 0 });
      if (parent != null) nodes[parent].kids++;
      nodes.push(n);
      stack.push(n.i);
    }
  }
  const key = (n) => (n.group ? 'group:' : '') + n.name;
  // Everything starts closed except the path to the selected control (openPath); what the user opens or
  // closes is kept.
  const isOpen = (n) => !!ui.open[key(n)];
  function toggle(n, open) { ui.open[key(n)] = open; save(); render(); focusRow(n.i); }
  function focusRow(i) { const r = document.querySelector('.row[data-i="' + i + '"]'); if (r) r.focus(); }
  function ancestors(n) { const out = []; for (let p = n.parent; p != null; p = nodes[p].parent) out.push(nodes[p]); return out; }
  function openPath(name) {
    const n = nodes.find((x) => x.name === name && !x.group);
    if (!n) return;
    for (const a of ancestors(n)) ui.open[key(a)] = true;
    save();
  }
  function scrollToCurrent(focus) {
    const r = document.querySelector('.row.cur');
    if (!r) return;
    r.scrollIntoView({ block: 'nearest' });
    if (focus) r.focus();
  }
  function select(name) { vscode.postMessage({ type: 'select', name }); }

  function highlight(parent, text) {
    const i = filter ? text.toLowerCase().indexOf(filter) : -1;
    if (i < 0) return parent.append(text);
    parent.append(text.slice(0, i), el('mark', null, text.slice(i, i + filter.length)), text.slice(i + filter.length));
  }

  function empty(icon, title, body, buttons, steps) {
    $('main').hidden = true;
    const box = $('empty');
    box.hidden = false;
    box.textContent = '';
    const ico = el('div', 'ico');
    ico.innerHTML = svg(icon);
    const head = el('div');
    head.append(el('b', null, title));
    if (body) head.append(el('div', null, body));
    box.append(ico, head);
    if (steps) { const ol = el('ol', 'steps'); for (const t of steps) ol.append(el('li', null, t)); box.append(ol); }
    const btns = el('div', 'btns');
    for (const [label, msg, primary] of buttons || []) {
      const b = el('button', 'btn' + (primary ? ' primary' : ''), label);
      b.onclick = () => vscode.postMessage(msg);
      btns.append(b);
    }
    box.append(btns);
  }

  function render() {
    if (!s) return;
    const command = (c) => ({ type: 'command', command: c });
    if (!s.server) {
      return empty('<circle cx="8" cy="8" r="6"/><path d="M4 12 12 4"/>', T.stopped, T.stoppedText,
        [[T.restart, command('powerappsBridge.restart'), true], [T.showLog, command('powerappsBridge.showLog')]]);
    }
    if (!s.connected && !s.rows.length) {
      return empty('<path d="M6 2v3M10 2v3M4.5 5h7v3a3.5 3.5 0 0 1-7 0zM8 11.5V14"/>', T.waiting, null,
        [[T.openPowerApps, { type: 'open', url: 'https://make.powerapps.com/' }, true], [T.gettingStarted, command('powerappsBridge.openWalkthrough')], [T.log, command('powerappsBridge.showLog')]],
        [T.step1, T.step2, T.step3]);
    }
    if (!s.rows.length) {
      return s.loading
        ? empty('<path d="M8 2a6 6 0 1 0 6 6"/>', T.loading, T.loadingText)
        : empty('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 5.5h12"/>', T.emptyTree,
            T.emptyTreeText,
            [[T.reload, command('powerappsBridge.refreshTree'), true]]);
    }
    $('empty').hidden = true;
    $('main').hidden = false;

    // Summary
    const sum = $('sum');
    sum.textContent = '';
    if (s.loading) sum.append(el('span', 'spin'));
    sum.append(plural(s.screens, T.screen, T.screens) + ' · ' + plural(s.controls, T.control, T.controls));
    if (!s.connected) sum.append(' · ' + T.offline);
    if (s.errors) {
      const p = el('button', 'pill');
      p.append(el('i'), plural(s.errors, T.error, T.errors));
      p.title = T.problems;
      p.onclick = () => cmd('workbench.actions.view.problems');
      sum.append(p);
    }

    // Which rows show: everything under open nodes, or, when filtering, the hits and their ancestors.
    let show;
    const hits = new Set();
    if (filter) {
      show = new Set();
      for (const n of nodes) {
        if (n.name.toLowerCase().includes(filter) || (n.typeLabel || '').toLowerCase().includes(filter)) {
          hits.add(n.i);
          show.add(n.i);
          for (const a of ancestors(n)) show.add(a.i);
        }
      }
    }
    const curNode = s.current ? nodes.find((n) => n.name === s.current && !n.group) : null;
    const anc = new Set(curNode ? ancestors(curNode).map((a) => a.i) : []);

    const tree = $('tree');
    const focusedName = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.i : null;
    tree.textContent = '';
    let hiddenUnder = Infinity; // level under which rows are inside a closed node
    for (const n of nodes) {
      if (filter) { if (!show.has(n.i)) continue; }
      else {
        if (n.level > hiddenUnder) continue;
        hiddenUnder = n.kids && !isOpen(n) ? n.level : Infinity;
      }
      const open = filter ? true : isOpen(n);
      const row = el('div', 'row');
      row.tabIndex = 0;
      row.dataset.i = n.i;
      row.dataset.name = n.name;
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', n.level);
      if (n.kids) { row.setAttribute('aria-expanded', String(open)); if (!open) row.classList.add('closed'); }
      if (n.level === 1) row.classList.add('screen');
      if (curNode && n.i === curNode.i) { row.classList.add('cur'); row.setAttribute('aria-selected', 'true'); }
      if (anc.has(n.i)) row.classList.add('anc');
      if (n.errors) row.classList.add('bad');
      if (n.def) row.classList.add('def');
      if (hits.has(n.i)) row.classList.add('hit');

      const indent = el('span', 'indent');
      indent.append(el('span'));
      for (let l = 1; l < n.level; l++) indent.append(el('span', 'g'));
      const tw = el('span', 'tw');
      if (n.kids) {
        tw.innerHTML = CHEVRON;
        tw.onclick = (e) => { e.stopPropagation(); toggle(n, !isOpen(n)); };
      }
      const ty = el('span', 'ty');
      ty.innerHTML = typeIcon(n.group ? 'hidden' : n.typeKey);
      const nm = el('span', 'nm');
      highlight(nm, n.name);
      const meta = el('span', 'meta');
      if (n.errors) meta.append(el('span', 'e', '⚠ ' + n.errors));
      if (n.kids && !n.group) meta.append(el('span', 'cnt', String(n.count)));
      if (!n.group) {
        const acts = el('span', 'acts');
        const a1 = el('button'); a1.innerHTML = PROPS; a1.title = T.openProperty;
        a1.onclick = (e) => { e.stopPropagation(); cmd('powerappsBridge.pickProperty', [n.name]); };
        const a2 = el('button'); a2.innerHTML = EYE; a2.title = T.showInPreview;
        a2.onclick = (e) => { e.stopPropagation(); cmd('powerappsBridge.revealInPreview', [{ name: n.name }]); };
        acts.append(a1, a2);
        meta.append(acts);
      }
      row.append(indent, tw, ty, nm, meta);
      row.title = n.group ? T.groupTitle
        : n.name + ' · ' + n.typeLabel + (n.path ? '\\n' + n.path : '') + (n.errors ? '\\n⚠ ' + fmt(T.formulaErrors, n.errors) : '') + (n.def ? '\\n' + T.defaultName : '');
      if (!n.group) {
        row.dataset.vscodeContext = JSON.stringify({ webviewSection: 'control', name: n.name, preventDefaultContextMenuItems: true });
        row.onclick = () => { if (n.kids && curNode && n.i === curNode.i) toggle(n, !isOpen(n)); else select(n.name); };
        row.ondblclick = () => n.kids && toggle(n, !isOpen(n));
      } else {
        row.onclick = () => toggle(n, !isOpen(n));
      }
      tree.append(row);
    }
    if (filter && !hits.size) tree.append(el('div', 'none', fmt(T.noMatch, filter)));
    if (focusedName != null) focusRow(focusedName);
  }

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
}

module.exports = { Outline };
