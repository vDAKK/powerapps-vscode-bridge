'use strict';

// "Contrôle" side bar view: an inspector for the control selected in Studio. A webview (not a tree view) so it
// can show a header with the control's type, its path and actions, a live filter over property names and
// formulas, and each formula's preview on its own line.

const vscode = require('vscode');
const crypto = require('crypto');
const { typeIconScript, escapeHtml: esc, uiLanguage, l10nScript } = require('./ui-icons');

class Inspector {
  /**
   * @param {object} deps
   *   state() -> payload (see extension.js inspectorState), open(control, property), select(name),
   *   command(id, ...args)
   */
  constructor(deps) {
    this.deps = deps;
    this.view = null;
    this.timer = null;
  }

  get visible() {
    return !!this.view && this.view.visible;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.page();
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => this.visible && this.post());
    view.onDidDispose(() => (this.view = null));
  }

  onMessage(m) {
    switch (m.type) {
      case 'ready':
        return this.flush();
      case 'open':
        return this.deps.open(m.control, m.property);
      case 'select':
        return this.deps.select(m.name);
      case 'command':
        return vscode.commands.executeCommand(m.command, ...(m.args || []));
    }
  }

  /** Coalesces bursts of changes (export, selection, diagnostics) into one update. */
  post() {
    if (!this.view) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 60);
  }

  flush() {
    if (!this.view || !this.view.visible) return;
    const s = this.deps.state();
    this.view.description = s.control || undefined;
    this.view.webview.postMessage({ type: 'state', ...s });
  }

  focusFilter() {
    if (this.view) this.view.webview.postMessage({ type: 'focusFilter' });
  }

  page() {
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = ["default-src 'none'", "style-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`].join('; ');
    const lang = uiLanguage(vscode);
    const T = {
      location: vscode.l10n.t('Location'),
      showInPreview: vscode.l10n.t('Show in the screen preview'),
      preview: vscode.l10n.t('Preview'),
      refsTitle: vscode.l10n.t('Formulas that reference this control'),
      refs: vscode.l10n.t('References'),
      renameTitle: vscode.l10n.t('Rename (Studio updates the references)'),
      rename: vscode.l10n.t('Rename'),
      copyName: vscode.l10n.t('Copy name'),
      filter: vscode.l10n.t('Filter'),
      filterTitle: vscode.l10n.t('Filter by property name or formula text (shortcut: /)'),
      filterLabel: vscode.l10n.t('Filter properties'),
      shown: vscode.l10n.t('Properties shown'),
      changedTitle: vscode.l10n.t('Properties that are not at their default value'),
      changed: vscode.l10n.t('Changed'),
      allTitle: vscode.l10n.t('All properties of the control'),
      all: vscode.l10n.t('All'),
      noSelection: vscode.l10n.t('No control selected'),
      noSelectionText: vscode.l10n.t('Select a control in Studio, in the tree view or in the screen preview.'),
      notConnected: vscode.l10n.t('Studio not connected'),
      notConnectedText: vscode.l10n.t('Open your app in Power Apps Studio with the browser extension enabled.'),
      propError: vscode.l10n.t('{0} property with an error'),
      propErrors: vscode.l10n.t('{0} properties with errors'),
      select: vscode.l10n.t('Select {0}'),
      suggestion: vscode.l10n.t('Default name. Suggestion:'),
      renameTo: vscode.l10n.t('Rename to {0}'),
      byDefault: vscode.l10n.t('default'),
      notLoaded: vscode.l10n.t('not loaded'),
      noMatch: vscode.l10n.t('No property matches "{0}".'),
      allDefault: vscode.l10n.t('All properties are at their default value.'),
      noneKnown: vscode.l10n.t('No known properties.'),
      loadAll: vscode.l10n.t('Load all properties from Studio'),
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
    --mono: var(--vscode-editor-font-family, monospace);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: transparent; }
  svg { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  button { font: inherit; color: inherit; }
  [hidden] { display: none !important; }

  /* Header */
  .head { padding: 10px 12px 8px; display: grid; gap: 6px; }
  .title { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .avatar { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border-radius: 7px;
    background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); font: 600 11px var(--vscode-font-family); letter-spacing: .02em; }
  .avatar.bad { background: color-mix(in srgb, var(--err) 16%, transparent); color: var(--err); }
  .name { min-width: 0; }
  .name b { display: block; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name span { font-size: 11.5px; color: var(--muted); }
  .crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; font-size: 11.5px; color: var(--muted); }
  .crumbs button { border: 0; background: none; padding: 1px 3px; border-radius: 3px; cursor: pointer; color: var(--muted); }
  .crumbs button:hover { color: var(--vscode-textLink-foreground); background: var(--vscode-toolbar-hoverBackground); }
  .crumbs i { font-style: normal; opacity: .6; }
  .actions { display: flex; gap: 4px; flex-wrap: wrap; }
  .act { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px; border-radius: 4px; cursor: pointer; font-size: 12px;
    border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .act:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .act svg { width: 14px; height: 14px; }
  .act.icon { width: 24px; padding: 0; justify-content: center; }
  .actions .act:first-child { flex: 1; justify-content: center; }
  .act .n { padding: 0 5px; border-radius: 999px; font-size: 10.5px; line-height: 15px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .note { display: flex; gap: 6px; align-items: flex-start; padding: 6px 8px; border-radius: 4px; font-size: 12px; line-height: 1.4;
    background: var(--vscode-inputValidation-infoBackground, #0078d41a); border: 1px solid var(--vscode-inputValidation-infoBorder, transparent); }
  .note button { border: 0; background: none; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
  .note code { font-family: var(--mono); }

  /* Toolbar */
  .tools { position: sticky; top: 0; z-index: 2; display: flex; gap: 6px; padding: 6px 12px 8px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--line); }
  .search { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; height: 24px; border-radius: 4px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
  .search:focus-within { outline: 1px solid var(--accent); outline-offset: -1px; }
  .search svg { position: absolute; left: 6px; width: 14px; height: 14px; color: var(--muted); }
  .search input { width: 100%; height: 100%; border: 0; outline: 0; padding: 0 6px 0 25px; background: transparent; color: inherit; font: inherit; }
  .search input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .seg { display: flex; flex: none; border-radius: 4px; overflow: hidden; border: 1px solid var(--vscode-input-border, var(--line)); }
  .seg button { border: 0; padding: 0 8px; height: 22px; font-size: 11.5px; cursor: pointer; background: transparent; color: var(--muted); }
  .seg button[aria-pressed="true"] { background: var(--vscode-inputOption-activeBackground, #0078d433); color: var(--vscode-foreground); }

  /* Property list */
  .group { border-bottom: 1px solid var(--line); }
  .gh { width: 100%; display: flex; align-items: center; gap: 6px; padding: 6px 12px; border: 0; background: none; cursor: pointer;
    font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); }
  .gh:hover { color: var(--vscode-foreground); }
  .gh svg { width: 12px; height: 12px; transition: transform .12s; }
  .group.closed .gh svg { transform: rotate(-90deg); }
  .group.closed .rows { display: none; }
  .gh .count { margin-left: auto; font-weight: 500; letter-spacing: 0; }
  .gh .count.bad { color: var(--err); }
  .row { position: relative; display: grid; grid-template-columns: minmax(80px, 38%) 1fr; gap: 8px; align-items: baseline; width: 100%;
    padding: 3px 12px 3px 24px; border: 0; background: none; text-align: left; cursor: pointer; line-height: 18px; color: var(--vscode-foreground); }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row:focus { outline: 1px solid var(--vscode-list-focusOutline, var(--accent)); outline-offset: -1px; }
  .row.cur { background: var(--vscode-list-inactiveSelectionBackground); }
  .row.cur::before { content: ''; position: absolute; left: 12px; top: 5px; bottom: 5px; width: 3px; border-radius: 2px; background: var(--accent); }
  .row .p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row.bad .p { color: var(--err); }
  .row.bad::after { content: ''; position: absolute; left: 13px; top: 50%; width: 6px; height: 6px; margin-top: -3px; border-radius: 50%; background: var(--err); }
  .row.cur.bad::after { display: none; }
  .row .f { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px var(--mono); color: var(--vscode-textPreformat-foreground, var(--vscode-foreground)); opacity: .9; }
  .row .f.dim { font-family: var(--vscode-font-family); font-style: italic; color: var(--muted); opacity: 1; }
  mark { background: var(--vscode-editor-findMatchHighlightBackground, #ea5c0055); color: inherit; border-radius: 2px; }

  .more { padding: 10px 12px 14px; display: grid; gap: 6px; justify-items: start; color: var(--muted); font-size: 12px; }
  .primary { height: 26px; padding: 0 12px; border: 0; border-radius: 4px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }

  .empty { padding: 28px 18px; display: grid; justify-items: center; gap: 8px; text-align: center; color: var(--muted); line-height: 1.5; }
  .empty .ico { width: 40px; height: 40px; display: grid; place-items: center; border-radius: 10px; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
  .empty b { color: var(--vscode-foreground); font-size: 13px; }
  kbd { font: 10.5px var(--mono); padding: 0 4px; border-radius: 3px; border: 1px solid var(--line); }
</style>
</head>
<body>
  <div id="empty" class="empty" hidden></div>
  <div id="main" hidden>
    <section class="head">
      <div class="title">
        <div class="avatar" id="avatar"></div>
        <div class="name"><b id="name"></b><span id="type"></span></div>
      </div>
      <nav class="crumbs" id="crumbs" aria-label="${esc(T.location)}"></nav>
      <div class="actions">
        <button class="act" data-cmd="powerappsBridge.revealInPreview" title="${esc(T.showInPreview)}">
          <svg viewBox="0 0 16 16"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>${esc(T.preview)}</button>
        <button class="act" data-cmd="powerappsBridge.findUsages" title="${esc(T.refsTitle)}">
          <svg viewBox="0 0 16 16"><path d="M3 4h10M3 8h6M3 12h8"/></svg>${esc(T.refs)}<span class="n" id="refs"></span></button>
        <button class="act icon" data-cmd="powerappsBridge.renameControl" title="${esc(T.renameTitle)}" aria-label="${esc(T.rename)}">
          <svg viewBox="0 0 16 16"><path d="M10.5 2.5l3 3L6 13H3v-3z"/></svg></button>
        <button class="act icon" data-cmd="powerappsBridge.copyName" title="${esc(T.copyName)}" aria-label="${esc(T.copyName)}">
          <svg viewBox="0 0 16 16"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.5V3.5A1 1 0 0 1 4 2.5h6.5"/></svg></button>
      </div>
      <div class="note" id="note" hidden></div>
    </section>
    <div class="tools">
      <label class="search">
        <svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>
        <input id="filter" type="search" placeholder="${esc(T.filter)}" title="${esc(T.filterTitle)}" aria-label="${esc(T.filterLabel)}" spellcheck="false">
      </label>
      <div class="seg" role="group" aria-label="${esc(T.shown)}">
        <button id="modeSet" aria-pressed="true" title="${esc(T.changedTitle)}">${esc(T.changed)}</button>
        <button id="modeAll" aria-pressed="false" title="${esc(T.allTitle)}">${esc(T.all)}</button>
      </div>
    </div>
    <div id="list" role="list"></div>
    <div class="more" id="more" hidden></div>
  </div>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  ${l10nScript(T, lang)}
  const ui = Object.assign({ mode: 'set', closed: {} }, vscode.getState() || {});
  let s = null;
  let filter = '';
  let requested = null; // control whose full property list was asked for
  const save = () => vscode.setState(ui);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const chevron = '<svg viewBox="0 0 16 16"><path d="m4 6 4 4 4-4"/></svg>';

  for (const b of document.querySelectorAll('[data-cmd]')) {
    b.onclick = () => s && s.control && vscode.postMessage({ type: 'command', command: b.dataset.cmd,
      args: [b.dataset.cmd === 'powerappsBridge.findUsages' ? s.control : { name: s.control }] });
  }
  $('modeSet').onclick = () => { ui.mode = 'set'; save(); render(); };
  $('modeAll').onclick = () => { ui.mode = 'all'; save(); render(); };
  $('filter').oninput = (e) => { filter = e.target.value.trim().toLowerCase(); render(); };
  $('filter').onkeydown = (e) => {
    if (e.key === 'Escape') { e.target.value = ''; filter = ''; render(); }
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      const first = document.querySelector('.row');
      if (first) { e.preventDefault(); e.key === 'Enter' ? first.click() : first.focus(); }
    }
  };
  document.addEventListener('keydown', (e) => {
    if (e.target.classList && e.target.classList.contains('row')) {
      const rows = [...document.querySelectorAll('.row')];
      const i = rows.indexOf(e.target);
      if (e.key === 'ArrowDown' && rows[i + 1]) { e.preventDefault(); rows[i + 1].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (rows[i - 1] || $('filter')).focus(); }
    }
    if (e.key === '/' && document.activeElement !== $('filter')) { e.preventDefault(); $('filter').focus(); }
  });
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'state') { s = m; render(); }
    if (m.type === 'focusFilter') { $('filter').focus(); $('filter').select(); }
  });

  function empty(title, text) {
    $('main').hidden = true;
    const box = $('empty');
    box.hidden = false;
    box.textContent = '';
    const ico = el('div', 'ico');
    ico.innerHTML = '<svg viewBox="0 0 16 16"><path d="M3 2.5l9 5-4 1-2 4z"/></svg>';
    box.append(ico, el('b', null, title), el('div', null, text));
  }

  function highlight(parent, text) {
    if (!filter) return parent.append(text);
    const i = text.toLowerCase().indexOf(filter);
    if (i < 0) return parent.append(text);
    parent.append(text.slice(0, i), el('mark', null, text.slice(i, i + filter.length)), text.slice(i + filter.length));
  }

  ${typeIconScript()}

  function render() {
    if (!s) return;
    if (!s.control) {
      return s.connected
        ? empty(T.noSelection, T.noSelectionText)
        : empty(T.notConnected, T.notConnectedText);
    }
    $('empty').hidden = true;
    $('main').hidden = false;

    const errCount = s.props.filter((p) => p.errors.length).length;
    $('avatar').innerHTML = typeIcon(s.typeKey);
    $('avatar').classList.toggle('bad', errCount > 0);
    $('name').textContent = s.control;
    $('name').title = s.control;
    $('type').textContent = s.typeLabel + (errCount ? ' · ' + plural(errCount, T.propError, T.propErrors) : '');

    const crumbs = $('crumbs');
    crumbs.textContent = '';
    crumbs.hidden = !s.path.length;
    s.path.forEach((p, i) => {
      if (i) crumbs.append(el('i', null, '›'));
      const b = el('button', null, p);
      b.title = fmt(T.select, p);
      b.onclick = () => vscode.postMessage({ type: 'select', name: p });
      crumbs.append(b);
    });
    $('refs').textContent = s.refs ? String(s.refs) : '';
    $('refs').hidden = !s.refs;

    const note = $('note');
    note.textContent = '';
    note.hidden = !s.suggestion;
    if (s.suggestion) {
      note.append(T.suggestion + ' ');
      const b = el('button', null, s.suggestion);
      b.title = fmt(T.renameTo, s.suggestion);
      b.onclick = () => vscode.postMessage({ type: 'command', command: 'powerappsBridge.renameControl', args: [{ name: s.control }] });
      note.append(b);
    }

    // "All" stays meaningful when another control gets selected: fetch its list once (it opens Studio's
    // property dropdown briefly, hence only on demand).
    if (ui.mode === 'all' && !s.listed && s.connected && requested !== s.control) {
      requested = s.control;
      vscode.postMessage({ type: 'command', command: 'powerappsBridge.loadProperties' });
    }
    $('modeSet').setAttribute('aria-pressed', String(ui.mode === 'set'));
    $('modeAll').setAttribute('aria-pressed', String(ui.mode === 'all'));

    const visible = s.props.filter((p) =>
      (ui.mode === 'all' || p.formula != null || p.name === s.property) &&
      (!filter || p.name.toLowerCase().includes(filter) || (p.formula || '').toLowerCase().includes(filter)));

    const list = $('list');
    const focused = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.prop;
    list.textContent = '';
    for (const g of s.groups) {
      const props = visible.filter((p) => p.group === g.key);
      if (!props.length) continue;
      const bad = props.filter((p) => p.errors.length).length;
      const sec = el('section', 'group' + (ui.closed[g.key] && !filter ? ' closed' : ''));
      const gh = el('button', 'gh');
      gh.innerHTML = chevron;
      gh.append(g.label);
      const count = el('span', 'count' + (bad ? ' bad' : ''), bad ? bad + ' ⚠ · ' + props.length : String(props.length));
      gh.append(count);
      gh.setAttribute('aria-expanded', String(!sec.classList.contains('closed')));
      gh.onclick = () => { ui.closed[g.key] = !ui.closed[g.key]; save(); render(); };
      const rows = el('div', 'rows');
      for (const p of props) {
        const row = el('button', 'row' + (p.name === s.property ? ' cur' : '') + (p.errors.length ? ' bad' : ''));
        row.dataset.prop = p.name;
        row.setAttribute('role', 'listitem');
        const name = el('span', 'p');
        highlight(name, p.name);
        const f = el('span', 'f' + (p.formula == null ? ' dim' : ''));
        if (p.formula == null) f.textContent = s.exported ? T.byDefault : T.notLoaded;
        else highlight(f, p.preview);
        row.append(name, f);
        row.title = p.name + (p.formula != null ? '\\n\\n' + p.formula.slice(0, 600) : '') + (p.errors.length ? '\\n\\n⚠ ' + p.errors.join('\\n⚠ ') : '');
        row.onclick = () => vscode.postMessage({ type: 'open', control: s.control, property: p.name });
        rows.append(row);
      }
      sec.append(gh, rows);
      list.append(sec);
    }

    const more = $('more');
    more.textContent = '';
    more.hidden = true;
    if (!visible.length) {
      more.hidden = false;
      more.append(filter ? fmt(T.noMatch, filter) : ui.mode === 'set' ? T.allDefault : T.noneKnown);
    }
    if (ui.mode === 'all' && !s.listed) {
      more.hidden = false;
      const b = el('button', 'primary', T.loadAll);
      b.onclick = () => vscode.postMessage({ type: 'command', command: 'powerappsBridge.loadProperties' });
      more.append(b);
    }
    if (focused) {
      const again = list.querySelector('[data-prop="' + CSS.escape(focused) + '"]');
      if (again) again.focus();
    }
    const cur = list.querySelector('.row.cur');
    if (cur && !focused && document.activeElement !== $('filter')) cur.scrollIntoView({ block: 'nearest' });
  }

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
}

module.exports = { Inspector };
