// Runs in the page's MAIN world (needs access to Monaco / React internals of Power Apps Studio).
// Detects the selected control + property + formula, reports changes, and applies formulas sent by VS Code.
(() => {
  'use strict';
  if (window.__paBridge) return;

  const VERSION = '0.6.0';
  const OUT = 'pa-bridge:out'; // page -> extension
  const IN = 'pa-bridge:in'; // extension -> page
  const POLL_MS = 200;

  // ---------------------------------------------------------------------------
  // Heuristic selectors. Studio's DOM is undocumented and changes often:
  // use the popup "Diagnostic" button to see what matches and tune these lists.
  // ---------------------------------------------------------------------------
  const FORMULA_BAR_SELECTORS = [
    '[data-control-part="formulaBar"]',
    '[data-automation-id*="formulaBar" i]',
    '[data-testid*="formulaBar" i]',
    '[id*="formulaBar" i]',
    '[id*="formula-bar" i]',
    '[class*="formulaBar" i]',
    '[class*="formula-bar" i]',
    '[aria-label*="formula bar" i]',
    '[aria-label*="barre de formule" i]',
  ];

  const PROPERTY_SELECTORS = [
    '[aria-label="Property" i]',
    '[aria-label="Properties" i]',
    '[aria-label="Propriété" i]',
    '[aria-label="Propriétés" i]',
    '[aria-label*="property selector" i]',
    '[aria-label*="sélecteur de propriété" i]',
    '[class*="propertyDropdown" i]',
    '[class*="property-dropdown" i]',
    '[class*="propertySelector" i]',
    '[data-automation-id*="propertyDropdown" i]',
  ];

  const SELECTED_CONTROL_SELECTORS = [
    '[role="tree"] [role="treeitem"][aria-selected="true"]',
    '[role="treegrid"] [role="row"][aria-selected="true"]',
    '[class*="treeView" i] [aria-selected="true"]',
  ];

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------
  const safe = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function queryFirst(selectors, root = document) {
    for (const sel of selectors) {
      for (const el of root.querySelectorAll(sel)) if (isVisible(el)) return el;
    }
    return null;
  }

  function firstLine(s) {
    return (s || '').trim().split('\n')[0].trim();
  }

  function labelOf(el) {
    return (el.getAttribute('aria-label') || '').trim() || firstLine(el.innerText) || null;
  }

  function valueOf(el) {
    if (typeof el.value === 'string' && el.value.trim()) return el.value.trim();
    return firstLine(el.innerText) || el.getAttribute('aria-valuetext') || el.getAttribute('title') || null;
  }

  // ---------------------------------------------------------------------------
  // Monaco editor discovery: public API first, then React fiber scan.
  // ---------------------------------------------------------------------------
  function monacoApi() {
    try {
      if (window.monaco && window.monaco.editor) return window.monaco;
    } catch {}
    try {
      const r = window.require;
      if (typeof r === 'function' && r.defined && r.defined('vs/editor/editor.main')) return r('vs/editor/editor.main');
    } catch {}
    return null;
  }

  function apiEditors() {
    return safe(() => monacoApi().editor.getEditors()) || [];
  }

  function isEditor(o) {
    try {
      return (
        !!o &&
        typeof o === 'object' &&
        typeof o.getModel === 'function' &&
        typeof o.executeEdits === 'function' &&
        typeof o.getDomNode === 'function'
      );
    } catch {
      return false;
    }
  }

  function owns(ed, node) {
    try {
      const d = ed.getDomNode();
      return !!d && (d === node || d.contains(node) || node.contains(d));
    } catch {
      return false;
    }
  }

  function candidate(v, node) {
    if (isEditor(v) && owns(v, node)) return v;
    try {
      if (v && typeof v === 'object' && isEditor(v.current) && owns(v.current, node)) return v.current;
    } catch {}
    return null;
  }

  function scanObject(obj, node) {
    if (!obj || typeof obj !== 'object' || obj instanceof Node) return null;
    let r = candidate(obj, node);
    if (r) return r;
    let n = 0;
    for (const k in obj) {
      if (++n > 60) break;
      let v;
      try {
        v = obj[k];
      } catch {
        continue;
      }
      r = candidate(v, node);
      if (r) return r;
    }
    return null;
  }

  function fiberOf(el) {
    for (const k of Object.keys(el)) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) return el[k];
    }
    return null;
  }

  function scanReact(node) {
    let el = node;
    let fiber = null;
    for (let up = 0; el && !fiber && up < 10; up++, el = el.parentElement) fiber = fiberOf(el);
    for (let d = 0; fiber && d < 40; d++, fiber = fiber.return) {
      let r = scanObject(fiber.stateNode, node) || scanObject(fiber.memoizedProps, node);
      if (r) return r;
      let h = fiber.memoizedState;
      for (let i = 0; h && typeof h === 'object' && i < 30; i++, h = h.next) {
        r = scanObject(h.memoizedState, node);
        if (r) return r;
      }
    }
    return null;
  }

  const editorCache = new WeakMap(); // .monaco-editor node -> editor
  const missCache = new WeakMap(); // .monaco-editor node -> last failed lookup timestamp

  function findEditorForNode(node) {
    const cached = editorCache.get(node);
    if (cached && owns(cached, node) && safe(() => cached.getModel())) return cached;
    if (Date.now() - (missCache.get(node) || 0) < 2000) return null;
    let ed = apiEditors().find((e) => owns(e, node)) || scanReact(node);
    if (ed) editorCache.set(node, ed);
    else missCache.set(node, Date.now());
    return ed;
  }

  // ---------------------------------------------------------------------------
  // Formula target: { kind: 'monaco' | 'monaco-dom' | 'input' | 'ce', ... }
  // ---------------------------------------------------------------------------
  function topmost(nodes) {
    return nodes
      .map((n) => ({ n, r: n.getBoundingClientRect() }))
      .sort((a, b) => a.r.top - b.r.top || b.r.width - a.r.width)[0]?.n;
  }

  function findFormulaTarget() {
    const bar = queryFirst(FORMULA_BAR_SELECTORS);
    const scope = bar || document;
    const node = topmost([...scope.querySelectorAll('.monaco-editor')].filter(isVisible));
    if (node) {
      const editor = findEditorForNode(node);
      return editor ? { kind: 'monaco', node, editor } : { kind: 'monaco-dom', node };
    }
    if (!bar) return null;
    const input = [...bar.querySelectorAll('textarea, input[type="text"], input:not([type])')].find(isVisible);
    if (input) return { kind: 'input', node: input };
    const ce = [...bar.querySelectorAll('[contenteditable="true"]')].find(isVisible);
    if (ce) return { kind: 'ce', node: ce };
    return null;
  }

  function readViewLines(node) {
    return [...node.querySelectorAll('.view-lines .view-line')]
      .map((l) => ({ top: parseFloat(l.style.top) || 0, text: l.textContent.replace(/ /g, ' ') }))
      .sort((a, b) => a.top - b.top)
      .map((l) => l.text)
      .join('\n');
  }

  function readFormula(t) {
    switch (t.kind) {
      case 'monaco': {
        const model = t.editor.getModel();
        return model ? model.getValue(1 /* LF */) : null;
      }
      case 'monaco-dom':
        return readViewLines(t.node);
      case 'input':
        return t.node.value;
      case 'ce':
        return t.node.innerText.replace(/ /g, ' ');
      default:
        return null;
    }
  }

  function selectAllKey(el) {
    const mac = /Mac/i.test(navigator.platform);
    const ev = new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      ctrlKey: !mac,
      metaKey: mac,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(ev, 'keyCode', { get: () => 65 });
    Object.defineProperty(ev, 'which', { get: () => 65 });
    el.dispatchEvent(ev);
  }

  function writeFormula(t, text) {
    switch (t.kind) {
      case 'monaco': {
        const ed = t.editor;
        const model = ed.getModel();
        if (!model) return { ok: false, error: 'Monaco model not found' };
        if (model.getValue(1) === text) return { ok: true };
        ed.pushUndoStop();
        ed.executeEdits('vscode-bridge', [{ range: model.getFullModelRange(), text, forceMoveMarkers: true }]);
        ed.pushUndoStop();
        return { ok: true };
      }
      case 'monaco-dom': {
        // No editor instance: best effort via Monaco's hidden textarea (select all + synthetic paste).
        const ta = t.node.querySelector('textarea');
        if (!ta) return { ok: false, error: 'Monaco textarea not found' };
        ta.focus();
        selectAllKey(ta);
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        return { ok: true };
      }
      case 'input': {
        const proto = t.node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(t.node, text);
        t.node.dispatchEvent(new Event('input', { bubbles: true }));
        t.node.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      }
      case 'ce': {
        t.node.focus();
        document.execCommand('selectAll');
        document.execCommand('insertText', false, text);
        return { ok: true };
      }
      default:
        return { ok: false, error: `Unsupported target ${t.kind}` };
    }
  }

  // ---------------------------------------------------------------------------
  // Control / property detection
  // ---------------------------------------------------------------------------
  // The Monaco wrapper carries e.g. aria-label="Power fx formula editor for control names Home Screen and property Fill."
  const EDITOR_LABEL_RE = /for control (?:names?|named)\s+(.+?)\s+and property\s+(.+?)\.?\s*$/i;

  function editorLabel() {
    for (const el of document.querySelectorAll('[aria-label*="formula editor for control" i]')) {
      const m = EDITOR_LABEL_RE.exec(el.getAttribute('aria-label') || '');
      if (m && isVisible(el)) return { control: m[1].trim(), property: m[2].trim() };
    }
    return null;
  }

  function readControlFromEditorLabel() {
    return editorLabel()?.control || null;
  }

  // What the formula editor is really bound to (the property combobox may hold typed text).
  function editorProperty() {
    return editorLabel()?.property || readProperty(currentTarget);
  }

  function readControl() {
    const fromLabel = readControlFromEditorLabel();
    if (fromLabel) return fromLabel;
    for (const sel of SELECTED_CONTROL_SELECTORS) {
      const el = [...document.querySelectorAll(sel)].find(isVisible);
      if (el) return labelOf(el);
    }
    return null;
  }

  function readProperty(target) {
    const bar = queryFirst(FORMULA_BAR_SELECTORS);
    const scopes = bar ? [bar.parentElement || bar, document] : [document];
    for (const scope of scopes) {
      const el = queryFirst(PROPERTY_SELECTORS, scope);
      if (el) {
        const v = valueOf(el);
        if (v) return v;
      }
    }
    // Fallback: the dropdown sitting just left of the formula editor, on the same row.
    if (target) {
      const tr = target.node.getBoundingClientRect();
      const mid = tr.top + Math.min(tr.height, 40) / 2;
      const near = [...document.querySelectorAll('[role="combobox"], select, button[aria-haspopup="listbox"]')]
        .filter(isVisible)
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.top - 10 <= mid && r.bottom + 10 >= mid && r.right <= tr.left + 5)
        .sort((a, b) => b.r.right - a.r.right)[0];
      if (near) return valueOf(near.el);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Navigation: drive the property combobox and the tree view like a user would.
  // ---------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  async function waitFor(fn, timeout = 3000, step = 50) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = safe(fn);
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(step);
    }
  }

  function realClick(el) {
    const r = el.getBoundingClientRect();
    const o = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      clientX: r.left + Math.min(r.width / 2, 20),
      clientY: r.top + Math.min(r.height / 2, 14),
    };
    const p = { ...o, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', p));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', p));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }

  function pressKey(el, key) {
    const codes = { Escape: 27, Enter: 13 };
    for (const type of ['keydown', 'keyup']) {
      const ev = new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'keyCode', { get: () => codes[key] || 0 });
      el.dispatchEvent(ev);
    }
  }

  function typeInto(input, text) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function propertyInput() {
    const el = document.getElementById('powerapps-property-combo-box') || queryFirst(PROPERTY_SELECTORS);
    return el && isVisible(el) ? el : null;
  }

  function optionLabel(o) {
    return firstLine(o.innerText) || (o.getAttribute('aria-label') || '').trim();
  }

  function visibleOptions() {
    return [...document.querySelectorAll('[role="option"]')].filter(isVisible);
  }

  async function openPropertyList() {
    const input = propertyInput();
    if (!input) throw new Error('Property selector not found in Studio');
    if (visibleOptions().length) return input;
    input.focus();
    realClick(input);
    if (await waitFor(() => visibleOptions().length, 800)) return input;
    const icon = input.parentElement && input.parentElement.querySelector('[class*="expandIcon" i], [aria-label^="Open" i]');
    if (icon) realClick(icon);
    if (await waitFor(() => visibleOptions().length, 1500)) return input;
    throw new Error('Could not open the property list');
  }

  async function listProperties() {
    const input = await openPropertyList();
    const items = [...new Set(visibleOptions().map(optionLabel).filter(Boolean))];
    pressKey(input, 'Escape');
    return items;
  }

  async function selectProperty(name) {
    const input = await openPropertyList();
    const find = () => visibleOptions().find((o) => norm(optionLabel(o)) === norm(name));
    let opt = find();
    if (!opt) {
      typeInto(input, name); // the list may be long/virtualized: narrow it down
      opt = await waitFor(find, 1000);
    }
    if (opt) {
      opt.scrollIntoView({ block: 'nearest' });
      realClick(opt);
    } else {
      pressKey(input, 'Enter');
    }
    const ok = await waitFor(() => norm(editorProperty()) === norm(name), 2500);
    if (!ok) {
      pressKey(input, 'Escape');
      throw new Error(`Property "${name}" not found for this control`);
    }
  }

  function treeItems() {
    return [...document.querySelectorAll('[role="treeitem"]')].filter(isVisible);
  }

  function treeLabel(item) {
    return firstLine(item.innerText) || (item.getAttribute('aria-label') || '').trim();
  }

  function treeLevel(item) {
    const lvl = parseInt(item.getAttribute('aria-level'), 10);
    if (lvl > 0) return lvl;
    let n = 1;
    for (let p = item.parentElement; p; p = p.parentElement) if (p.getAttribute('role') === 'treeitem') n++;
    return n;
  }

  /** Hint about the control type: icon names / labels Studio puts on the tree row (format varies across versions). */
  function treeTypeHint(item) {
    const bits = [];
    const aria = (item.getAttribute('aria-label') || '').trim();
    if (aria && norm(aria) !== norm(treeLabel(item))) bits.push(aria);
    for (const e of item.querySelectorAll('[data-icon-name], [data-control-type], [data-type], svg[aria-label], img[alt]')) {
      if (e.closest('[role="treeitem"]') !== item) continue;
      const v =
        e.getAttribute('data-control-type') ||
        e.getAttribute('data-type') ||
        e.getAttribute('data-icon-name') ||
        e.getAttribute('aria-label') ||
        e.getAttribute('alt') ||
        '';
      if (v && !/chevron|expand|collapse|développer|réduire|more|plus/i.test(v)) bits.push(v);
      if (bits.length >= 4) break;
    }
    return bits.join(' | ').slice(0, 160) || undefined;
  }

  function treeEntry(i) {
    return {
      name: treeLabel(i),
      level: treeLevel(i),
      expanded: i.hasAttribute('aria-expanded') ? i.getAttribute('aria-expanded') === 'true' : undefined,
      hint: treeTypeHint(i),
    };
  }

  // Flat list, in display order, of the rows Studio's tree view renders now; `level` gives the hierarchy (1 = screen).
  function listControls() {
    return treeItems().map(treeEntry).filter((c) => c.name);
  }

  /**
   * Whole app hierarchy read from Studio's own data, without touching the UI: the React tree view component
   * receives every node (collapsed ones included) in its `treeItems` prop — {label, key, children, templateName}.
   * Returns null when that structure can't be found (other Studio version: callers fall back to crawlTree).
   */
  function modelTree() {
    for (const tree of document.querySelectorAll('[role="tree"], [role="treegrid"]')) {
      const fiberKey = Object.keys(tree).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      let f = fiberKey && tree[fiberKey];
      for (let i = 0; f && i < 40; i++, f = f.return) {
        const p = f.memoizedProps;
        if (!p || !Array.isArray(p.treeItems) || !p.treeItems.length) continue;
        const expandedKeys = p.expandedItemKeys;
        const isExpanded = (k) =>
          !expandedKeys ? undefined
            : typeof expandedKeys.has === 'function' ? expandedKeys.has(k)
            : Array.isArray(expandedKeys) ? expandedKeys.includes(k) : !!expandedKeys[k];
        const out = [];
        const walk = (items, level) => {
          for (const it of items || []) {
            if (!it || typeof it.label !== 'string' || !it.label) continue;
            const kids = Array.isArray(it.children) ? it.children : [];
            out.push({
              name: it.label,
              level,
              expanded: kids.length ? isExpanded(it.key) : undefined,
              hint: [it.templateName, it.templateClassName].filter(Boolean).join(' | ') || undefined,
              type: it.templateName || undefined,
              source: 'model',
            });
            walk(kids, level + 1);
          }
        };
        walk(p.treeItems, 1);
        if (out.length) return out;
      }
    }
    return null;
  }

  /** Every control of the app: from Studio's data when possible, else by expanding/scrolling the tree view. */
  async function allControls({ restore = true } = {}) {
    return safe(modelTree) || (await crawlTree({ restore }));
  }

  /** The element that scrolls Studio's tree view (it is virtualized: only rows in view exist in the DOM). */
  function treeScroller() {
    const first = treeItems()[0];
    for (let p = first && first.parentElement; p && p !== document.body; p = p.parentElement) {
      const st = getComputedStyle(p);
      if (p.scrollHeight > p.clientHeight + 4 && /(auto|scroll)/.test(st.overflowY)) return p;
    }
    return null;
  }

  const atBottom = (s) => !s || s.scrollTop + s.clientHeight >= s.scrollHeight - 2;
  const pageDown = (s) => (s.scrollTop += Math.max(40, s.clientHeight - 60));

  function toggleItem(item, open) {
    const re = open ? /expand|développer|chevron/i : /collapse|réduire|chevron/i;
    const own = [...item.querySelectorAll('[class*="expandIcon" i], [class*="chevron" i], [aria-label]')]
      .find((e) => e.closest('[role="treeitem"]') === item && e !== item && isVisible(e) &&
        (re.test(e.getAttribute('aria-label') || '') || /expandIcon|chevron/i.test(typeof e.className === 'string' ? e.className : '')));
    if (own) return realClick(own);
    const key = open ? ['ArrowRight', 39] : ['ArrowLeft', 37];
    const ev = new KeyboardEvent('keydown', { key: key[0], code: key[0], bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'keyCode', { get: () => key[1] });
    item.dispatchEvent(ev);
  }

  async function expandVisible(opened) {
    for (let pass = 0; pass < 10; pass++) {
      const collapsed = treeItems().filter((i) => i.getAttribute('aria-expanded') === 'false');
      if (!collapsed.length) return;
      for (const item of collapsed) {
        const name = treeLabel(item);
        if (opened && !opened.includes(name)) opened.push(name);
        toggleItem(item, true);
      }
      await sleep(200);
    }
  }

  /**
   * Full inventory of the app: walks Studio's tree view top to bottom, expanding every collapsed node and
   * scrolling through the virtualized list. With restore, the tree is then put back as it was.
   */
  async function crawlTree({ restore = true } = {}) {
    const scroller = treeScroller();
    const startTop = scroller ? scroller.scrollTop : 0;
    const opened = [];
    const order = [];
    const byName = new Map();
    const merge = (visible) => {
      let prev = -1;
      for (const e of visible) {
        if (byName.has(e.name)) {
          Object.assign(byName.get(e.name), e);
          prev = order.indexOf(e.name);
        } else {
          byName.set(e.name, e);
          order.splice(++prev, 0, e.name);
        }
      }
    };
    if (scroller) scroller.scrollTop = 0;
    await sleep(120);
    // Time budget: VS Code stops waiting after 60 s, and the crawl holds the queue of Studio actions.
    const deadline = Date.now() + 45000;
    for (let step = 0; step < 500 && Date.now() < deadline; step++) {
      await expandVisible(opened);
      merge(listControls());
      const s = treeScroller();
      if (atBottom(s)) break;
      pageDown(s);
      await sleep(150);
    }
    const all = order.map((n) => byName.get(n));
    if (restore) {
      const depth = new Map(all.map((c) => [c.name, c.level]));
      for (const name of [...opened].sort((a, b) => (depth.get(b) || 0) - (depth.get(a) || 0))) {
        const item = await findTreeItem(name);
        if (item && item.getAttribute('aria-expanded') === 'true') {
          toggleItem(item, false);
          await sleep(60);
        }
      }
      const s = treeScroller();
      if (s) s.scrollTop = startTop;
      for (const c of all) if (opened.includes(c.name)) c.expanded = false;
    }
    return all;
  }

  // Expand every node of Studio's tree view (left open) and list everything.
  function expandTree() {
    return crawlTree({ restore: false });
  }

  /** Finds a row of the tree view, scrolling the virtualized list if needed. */
  async function findTreeItem(name, { scroll = true } = {}) {
    const match = () => treeItems().find((i) => norm(treeLabel(i)) === norm(name));
    let item = match();
    if (item || !scroll) return item || null;
    const scroller = treeScroller();
    if (!scroller) return null;
    const start = scroller.scrollTop;
    scroller.scrollTop = 0;
    for (let step = 0; step < 500; step++) {
      await sleep(80);
      if ((item = match())) return item;
      if (atBottom(scroller)) break;
      pageDown(scroller);
    }
    scroller.scrollTop = start;
    return null;
  }

  /** Makes a control's row exist in the tree view by expanding its ancestors (path = [screen, …, parent]). */
  async function revealTreeItem(name, path = []) {
    let item = await findTreeItem(name, { scroll: false });
    if (item) return item;
    for (const ancestor of path || []) {
      const a = await findTreeItem(ancestor);
      if (a && a.getAttribute('aria-expanded') === 'false') {
        toggleItem(a, true);
        await waitFor(() => a.getAttribute('aria-expanded') === 'true', 1000);
        await sleep(150);
      }
    }
    item = await findTreeItem(name);
    if (!item) {
      await crawlTree({ restore: false }); // unknown path: open everything until it shows up
      item = await findTreeItem(name);
    }
    return item;
  }

  function treeItemLabelEl(item, name) {
    return [...item.querySelectorAll('*')].find((e) => e.children.length === 0 && norm(e.textContent) === norm(name)) || item;
  }

  async function selectControl(name, path) {
    const item = await revealTreeItem(name, path);
    if (!item) throw new Error(`"${name}" was not found in Studio's tree view`);
    const label = treeItemLabelEl(item, name);
    label.scrollIntoView({ block: 'nearest' });
    realClick(label);
    if (!(await waitFor(() => norm(readControl()) === norm(name), 3000))) {
      throw new Error(`Studio did not select "${name}"`);
    }
  }

  /** Renames a control with the tree view's inline editor (double-click, else the "Rename" menu entry). */
  async function renameControl(name, newName, path) {
    newName = String(newName || '').trim();
    if (!newName || /[.'"!\[\]]/.test(newName)) throw new Error(`Invalid name "${newName}"`);
    const item = await revealTreeItem(name, path);
    if (!item) throw new Error(`"${name}" was not found in Studio's tree view`);
    const label = treeItemLabelEl(item, name);
    label.scrollIntoView({ block: 'nearest' });
    realClick(label);
    await sleep(150);
    const editor = () => {
      const a = document.activeElement;
      if (a && a.tagName === 'INPUT' && (item.contains(a) || norm(a.value) === norm(name))) return a;
      return [...item.querySelectorAll('input')].find(isVisible) || null;
    };
    const r = label.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, view: window, clientX: r.left + 5, clientY: r.top + 5 };
    label.dispatchEvent(new MouseEvent('dblclick', at));
    let input = await waitFor(editor, 800);
    if (!input) {
      label.dispatchEvent(new MouseEvent('contextmenu', { ...at, button: 2 }));
      const entry = await waitFor(
        () =>
          [...document.querySelectorAll('[role="menuitem"], button')]
            .filter(isVisible)
            .find((e) => /^(rename|renommer)$/i.test(firstLine(e.innerText) || e.getAttribute('aria-label') || '')),
        1200
      );
      if (entry) {
        realClick(entry);
        input = await waitFor(editor, 1200);
      }
    }
    if (!input) {
      pressKey(document.activeElement || document.body, 'Escape');
      throw new Error('Studio did not open the rename box for this control');
    }
    input.focus();
    typeInto(input, newName);
    pressKey(input, 'Enter');
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    const ok = await waitFor(() => treeItems().some((i) => norm(treeLabel(i)) === norm(newName)), 2500);
    if (!ok) throw new Error(`Studio did not accept the name "${newName}" (already used?)`);
  }

  async function navigate(control, property, path) {
    navigating = true; // the poll loop would otherwise report half-done states (e.g. text typed in the combobox)
    try {
      if (control && control !== 'Unknown' && norm(readControl()) !== norm(control)) await selectControl(control, path);
      currentTarget = await waitFor(findFormulaTarget, 2000);
      if (property && property !== 'Unknown' && norm(safe(editorProperty)) !== norm(property)) {
        await selectProperty(property);
      }
      await sleep(100); // let Monaco load the new formula
    } finally {
      navigating = false;
    }
    tick(); // announce the new selection now, before any write (twice: see the stability check in tick)
    tick();
  }

  // ---------------------------------------------------------------------------
  // Live mirror of the current screen for the VS Code preview: the canvas is plain HTML, so the screen's
  // subtree is serialized with its computed styles (no stylesheets, no scripts) and re-rendered in VS Code.
  // Canvas controls carry data-control-name (same renderer as the player). Same-origin iframes are searched too.
  // ---------------------------------------------------------------------------
  const CONTROL_NAME_ATTR = 'data-control-name';
  const MAX_MIRROR_NODES = 8000;

  function canvasDocs() {
    const docs = [document];
    for (const f of document.querySelectorAll('iframe')) {
      try {
        if (f.contentDocument && isVisible(f)) docs.push(f.contentDocument);
      } catch {}
    }
    return docs;
  }

  // The screen = largest visible element named like a screen (or listed at level 1 of the tree view).
  function findScreen() {
    const screenNames = new Set(safe(listControls)?.filter((c) => c.level === 1).map((c) => norm(c.name)) || []);
    let best = null;
    let bestArea = 0;
    let any = 0;
    for (const doc of canvasDocs()) {
      for (const el of doc.querySelectorAll(`[${CONTROL_NAME_ATTR}]`)) {
        any++;
        const name = el.getAttribute(CONTROL_NAME_ATTR);
        if (!screenNames.has(norm(name)) && !/screen$|^scr/i.test(name)) continue;
        const r = el.getBoundingClientRect();
        if (r.width * r.height > bestArea) {
          best = el;
          bestArea = r.width * r.height;
        }
      }
    }
    return { el: best, controlsFound: any };
  }

  // Computed styles worth copying. Inherited ones are only written when they differ from the parent.
  const INHERITED_PROPS = [
    'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'text-align',
    'text-transform', 'letter-spacing', 'white-space', 'word-break', 'overflow-wrap', 'visibility',
    'text-shadow', 'fill', 'stroke', 'stroke-width',
  ];
  const OWN_PROPS = {
    // property: values to skip (defaults)
    display: ['inline'],
    position: ['static'],
    left: ['auto'], top: ['auto'], right: ['auto'], bottom: ['auto'],
    width: ['auto'], height: ['auto'], 'min-width': ['auto', '0px'], 'min-height': ['auto', '0px'],
    'max-width': ['none'], 'max-height': ['none'],
    'box-sizing': ['content-box'],
    margin: ['0px'], padding: ['0px'],
    'border-radius': ['0px'],
    'background-color': ['rgba(0, 0, 0, 0)'],
    'background-image': ['none'], 'background-size': ['auto'], 'background-position': ['0% 0%'],
    'background-repeat': ['repeat'],
    overflow: ['visible'], 'text-overflow': ['clip'],
    opacity: ['1'], 'z-index': ['auto'], transform: ['none'],
    'flex-direction': ['row'], 'flex-wrap': ['nowrap'], 'flex-grow': ['0'], 'flex-shrink': ['1'],
    'flex-basis': ['auto'], 'align-items': ['normal'], 'align-self': ['auto'], 'justify-content': ['normal'],
    gap: ['normal'], 'grid-template-columns': ['none'], 'grid-template-rows': ['none'],
    'box-shadow': ['none'], 'vertical-align': ['baseline'], 'text-decoration-line': ['none'],
    'object-fit': ['fill'], 'clip-path': ['none'], 'border-collapse': ['separate'],
  };
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'OBJECT', 'EMBED']);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeUrl = (u) => /^(https:|data:image\/)/i.test(u || '');
  const imageCache = new Map(); // blob:/same-origin src -> data URL

  function inlineImage(img) {
    const src = img.currentSrc || img.src || '';
    if (safeUrl(src) && !src.startsWith(location.origin)) return src;
    if (imageCache.has(src)) return imageCache.get(src);
    let out = '';
    try {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      if (c.width && c.height && c.width * c.height <= 4e6) {
        c.getContext('2d').drawImage(img, 0, 0);
        out = c.toDataURL('image/png');
      }
    } catch {} // cross-origin without CORS: left blank
    imageCache.set(src, out);
    return out;
  }

  function styleOf(cs, parentCs, isRoot) {
    let s = '';
    for (const p of INHERITED_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v && (isRoot || !parentCs || parentCs.getPropertyValue(p) !== v)) s += `${p}:${v};`;
    }
    for (const p in OWN_PROPS) {
      let v = cs.getPropertyValue(p);
      if (!v || OWN_PROPS[p].includes(v)) continue;
      if (p === 'background-image' && /url\((?!["']?(https:|data:image\/))/i.test(v)) continue; // blob: etc.
      s += `${p}:${v};`;
      if (p === 'transform') s += `transform-origin:${cs.getPropertyValue('transform-origin')};`;
    }
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const st = cs.getPropertyValue(`border-${side}-style`);
      if (st && st !== 'none' && st !== 'hidden') {
        s += `border-${side}:${cs.getPropertyValue(`border-${side}-width`)} ${st} ${cs.getPropertyValue(`border-${side}-color`)};`;
      }
    }
    if (cs.getPropertyValue('overflow') === 'visible') {
      const ox = cs.getPropertyValue('overflow-x');
      const oy = cs.getPropertyValue('overflow-y');
      if (ox !== 'visible') s += `overflow-x:${ox};`;
      if (oy !== 'visible') s += `overflow-y:${oy};`;
    }
    return s;
  }

  function serializeSvg(el) {
    const clone = el.cloneNode(true);
    // Position and size are carried by the wrapping span.
    clone.setAttribute('style', 'display:block;width:100%;height:100%');
    for (const n of [clone, ...clone.querySelectorAll('*')]) {
      if (n.tagName && n.tagName.toLowerCase() === 'script') {
        n.remove();
        continue;
      }
      for (const a of [...(n.attributes || [])]) {
        if (/^on/i.test(a.name) || (/href$/i.test(a.name) && !/^#/.test(a.value))) n.removeAttribute(a.name);
      }
    }
    return clone.outerHTML;
  }

  function mirror() {
    const { el: screen, controlsFound } = findScreen();
    const base = { selected: last.control };
    if (!screen) return { ...base, screen: null, controlsFound };
    const names = new Set();
    let budget = MAX_MIRROR_NODES;
    const win = screen.ownerDocument.defaultView;

    function ser(el, parentCs, isRoot) {
      if (--budget < 0 || SKIP_TAGS.has(el.tagName)) return '';
      const cs = win.getComputedStyle(el);
      if (cs.display === 'none') return '';
      const name = el.getAttribute(CONTROL_NAME_ATTR);
      if (name) names.add(name);
      const nameAttr = name ? ` ${CONTROL_NAME_ATTR}="${esc(name)}"` : '';
      let style = styleOf(cs, parentCs, isRoot);
      if (isRoot) {
        style += `position:relative;left:0;top:0;margin:0;transform:none;width:${el.offsetWidth}px;height:${el.offsetHeight}px;`;
      }
      const st = esc(style);
      const tag = el.tagName.toLowerCase();
      if (tag === 'svg') return `<span${nameAttr} style="display:inline-block;${st}">${serializeSvg(el)}</span>`;
      if (tag === 'img') {
        const src = inlineImage(el);
        return `<img${nameAttr} alt="" style="${st}"${src ? ` src="${esc(src)}"` : ''}>`;
      }
      if (tag === 'canvas') {
        let src = '';
        try {
          src = el.toDataURL();
        } catch {}
        return `<img${nameAttr} alt="" style="${st}"${src ? ` src="${src}"` : ''}>`;
      }
      if (tag === 'iframe' || tag === 'video' || tag === 'audio') return `<div${nameAttr} style="${st}"></div>`;
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        const text = tag === 'select' ? el.options[el.selectedIndex]?.text || '' : el.type === 'password' ? '••••' : el.value || el.placeholder || '';
        const ph = !el.value && el.placeholder ? 'opacity:.6;' : '';
        if (el.type === 'checkbox' || el.type === 'radio') {
          return `<input${nameAttr} type="${el.type}" disabled${el.checked ? ' checked' : ''} style="${st}">`;
        }
        return `<div${nameAttr} style="${st}overflow:hidden;white-space:${tag === 'textarea' ? 'pre-wrap' : 'pre'};${ph}">${esc(text)}</div>`;
      }
      const safeTag = /^[a-z][a-z0-9-]*$/.test(tag) && !tag.includes('-') ? tag : 'div';
      let inner = '';
      for (const child of el.childNodes) {
        if (child.nodeType === 3) inner += esc(child.nodeValue);
        else if (child.nodeType === 1) inner += ser(child, cs, false);
      }
      return `<${safeTag}${nameAttr} style="${st}">${inner}</${safeTag}>`;
    }

    const html = ser(screen, null, true);
    const screenName = screen.getAttribute(CONTROL_NAME_ATTR);
    names.delete(screenName);
    return {
      ...base,
      screen: screenName,
      width: screen.offsetWidth,
      height: screen.offsetHeight,
      html,
      controls: [...names],
      truncated: budget < 0,
    };
  }
  // ---------------------------------------------------------------------------
  // Formula errors: Monaco markers if reachable, else squiggly decorations, plus Studio's screen-reader summary.
  // ---------------------------------------------------------------------------
  const SEVERITY = { 8: 'error', 4: 'warning', 2: 'info', 1: 'hint' };

  function readDiagnostics(t) {
    const summary = (document.getElementById('screen-reader-formula-error-notifier')?.textContent || '').trim();
    const items = [];
    if (t.kind === 'monaco') {
      const model = t.editor.getModel();
      const ctl = safe(() => t.editor.getContribution('editor.contrib.markerController'));
      const markers = safe(() => ctl._markerNavigationService._markerService.read({ resource: model.uri }));
      if (Array.isArray(markers)) {
        for (const m of markers) {
          items.push({
            severity: SEVERITY[m.severity] || 'error',
            range: [m.startLineNumber, m.startColumn, m.endLineNumber, m.endColumn],
            message: m.message,
          });
        }
      } else if (model) {
        for (const d of model.getAllDecorations()) {
          const m = /squiggly-(error|warning|info)/.exec((d.options && d.options.className) || '');
          if (!m) continue;
          const hm = d.options.hoverMessage;
          const msg = (Array.isArray(hm) ? hm : [hm]).map((h) => h && h.value).filter(Boolean).join('\n');
          const r = d.range;
          items.push({
            severity: m[1],
            range: [r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn],
            message: msg || undefined,
          });
        }
      }
    }
    return { items, summary };
  }

  // ---------------------------------------------------------------------------
  // Main loop + messaging
  // ---------------------------------------------------------------------------
  let last = { control: undefined, property: undefined, formula: undefined };
  let lastDiagKey = '';
  let navigating = false;
  let candidateSel = null;
  let currentTarget = null;

  function post(msg) {
    window.postMessage({ channel: OUT, msg }, '*');
  }

  function tick() {
    if (navigating) return;
    const target = safe(findFormulaTarget);
    if (!target) return;
    const formula = safe(() => readFormula(target));
    if (formula == null) return;
    currentTarget = target;
    const control = safe(readControl) || 'Unknown';
    const property = safe(editorProperty) || 'Unknown';
    const base = { control, property, formula, mode: target.kind };
    const moved = control !== last.control || property !== last.property;
    // Studio re-renders often: only trust a new selection once it has been read twice in a row.
    if (moved && last.control !== undefined) {
      const key = control + '\u0000' + property;
      if (candidateSel !== key) {
        candidateSel = key;
        return;
      }
    }
    candidateSel = null;
    if (moved) post({ type: 'selection', ...base });
    else if (formula !== last.formula) post({ type: 'formula', ...base });
    last = { control, property, formula };

    const diag = safe(() => readDiagnostics(target));
    if (diag) {
      const key = JSON.stringify([control, property, diag]);
      if (moved || key !== lastDiagKey) post({ type: 'diagnostics', control, property, ...diag });
      lastDiagKey = key;
    }
  }

  async function onSetFormula(m) {
    const reply = (ok, error) => post({ type: 'result', ok, error, control: m.control, property: m.property });
    if (m.control !== last.control || m.property !== last.property) {
      if (!m.navigate) {
        return reply(false, `Studio is on ${last.control}.${last.property}, not ${m.control}.${m.property}: edit ignored`);
      }
      try {
        await navigate(m.control, m.property);
      } catch (e) {
        return reply(false, String(e && e.message ? e.message : e));
      }
      if (m.control !== last.control || m.property !== last.property) {
        return reply(false, `Could not switch Studio to ${m.control}.${m.property}`);
      }
    }
    const t = currentTarget || safe(findFormulaTarget);
    if (!t) return reply(false, 'Formula bar not found in Studio');
    let r;
    try {
      r = writeFormula(t, m.formula);
    } catch (e) {
      r = { ok: false, error: String(e && e.message ? e.message : e) };
    }
    if (r.ok) last.formula = safe(() => readFormula(t)) ?? m.formula;
    reply(r.ok, r.error);
  }

  // --- Diagnostics helpers (read-only exploration of Studio's model through VS Code) ---
  const diagVars = {};
  const resolvePath = (p) => String(p || '').split('.').reduce((o, k) => (o == null ? o : o[k]), window);
  const entityName = (e) => safe(() => e.displayName ?? e._prop_DisplayName ?? e.name);
  function resolveArg(a) {
    if (!a || typeof a !== 'object' || !('$var' in a || '$path' in a)) return a;
    let v = '$var' in a ? diagVars[a.$var] : resolvePath(a.$path);
    if (a.index != null && v) v = v[a.index];
    if (a.pick && v && typeof v.filter === 'function') v = v.filter((e) => a.pick.includes(entityName(e)));
    return v;
  }
  function describeValue(v, full) {
    if (v == null || typeof v !== 'object') return typeof v === 'string' && !full ? v.slice(0, 200000) : v;
    if (Array.isArray(v)) {
      return {
        type: `Array(${v.length})`,
        items: v.slice(0, full ? 5000 : 40).map((e) =>
          e && typeof e === 'object' ? { name: entityName(e), type: safe(() => e.typeId ?? e._prop_TypeId), keys: Object.keys(e).slice(0, 12) } : e
        ),
      };
    }
    const plain = safe(() => JSON.stringify(v));
    if (plain && plain.length < 200000) return JSON.parse(plain);
    return { type: v.constructor && v.constructor.name, name: entityName(v), keys: Object.keys(v).slice(0, 40) };
  }

  async function onRequest(m) {
    const respond = (ok, data, error) => post({ type: 'response', id: m.id, ok, data, error });
    try {
      switch (m.type) {
        case 'navigate':
          await navigate(m.control, m.property, m.path);
          return respond(true, { control: last.control, property: last.property });
        case 'crawlTree':
          return respond(true, await allControls());
        case 'probeModel':
          if (!document.querySelector('[role="tree"], [role="treegrid"]')) return; // another frame answers
          return respond(true, probeModel());
        case 'exportApp':
          if (!document.querySelector('[role="tree"], [role="treegrid"]')) return; // another frame answers
          return respond(true, await exportApp());
        case 'appErrors':
          if (!document.querySelector('[role="tree"], [role="treegrid"]')) return;
          return respond(true, await appErrors());
        case 'fnSource': {
          if (!document.querySelector('[role="tree"], [role="treegrid"]')) return;
          const fn = resolvePath(m.path);
          return respond(true, typeof fn === 'function' ? String(fn).slice(0, 4000) : `not a function (${typeof fn})`);
        }
        case 'call': {
          // Diagnostics: calls a READ-ONLY method (get…/serialize…/has…, nothing that creates or changes)
          // on an object of Studio's model; results can be kept in named vars for the next call.
          if (!document.querySelector('[role="tree"], [role="treegrid"]')) return;
          if (!/^(get|serialize|has)/.test(m.method) || /create|set|add|remove|update|delete|save|rename|refresh/i.test(m.method)) {
            return respond(false, null, `Method "${m.method}" is not allowed (read-only methods only)`);
          }
          const target = typeof m.target === 'string' ? resolvePath(m.target) : diagVars[m.target && m.target.$var];
          if (!target || typeof target[m.method] !== 'function') return respond(false, null, `No method ${m.method} on target`);
          const args = (m.args || []).map(resolveArg);
          let result = target[m.method](...args);
          if (result && typeof result.then === 'function') result = await result;
          if (m.store) diagVars[m.store] = result;
          return respond(true, describeValue(result, m.full));
        }
        case 'evalPath': {
          // Read-only inspection of a property path from window (e.g. "AppMagic.AuthoringTool"): keys + shapes.
          if (!document.querySelector('[role="tree"], [role="treegrid"]')) return;
          const v = m.path.split('.').reduce((o, k) => (o == null ? o : o[k]), window);
          const out = { type: Array.isArray(v) ? `Array(${v.length})` : typeof v };
          if (v && (typeof v === 'object' || typeof v === 'function')) {
            out.keys = {};
            for (const k of Object.getOwnPropertyNames(v).slice(0, 200)) {
              const d = safe(() => Object.getOwnPropertyDescriptor(v, k));
              const x = d && 'value' in d ? d.value : undefined;
              out.keys[k] = !d ? '?' : !('value' in d) ? 'getter'
                : x === null ? 'null'
                : Array.isArray(x) ? `Array(${x.length})`
                : typeof x === 'string' ? JSON.stringify(x.slice(0, 80))
                : typeof x === 'object' ? `{${safe(() => Object.keys(x).slice(0, 12).join(','))}}`
                : typeof x;
            }
            const proto = Object.getPrototypeOf(v);
            if (proto && proto !== Object.prototype) out.protoMethods = Object.getOwnPropertyNames(proto).slice(0, 80);
          }
          return respond(true, out);
        }
        case 'renameControl':
          // Studio's own rename (updates every formula that refers to the control); the tree view UI as fallback.
          if (!(await safeAsync(() => renameViaModel(m.control, m.newName)))) await renameControl(m.control, m.newName, m.path);
          await sleep(300); // let Studio re-render the tree view with the new name
          return respond(true, await allControls());
        case 'listProperties':
          return respond(true, await listProperties());
        case 'listControls':
          return respond(true, safe(modelTree) || listControls());
        case 'expandTree':
          return respond(true, await expandTree());
        case 'mirror':
          return respond(true, mirror());
        default:
          return respond(false, null, `Unknown request ${m.type}`);
      }
    } catch (e) {
      respond(false, null, String(e && e.message ? e.message : e));
    }
  }

  // Studio actions must not interleave (a navigation in progress would be broken by another one).
  let queue = Promise.resolve();
  const enqueue = (fn) => (queue = queue.then(fn, fn));

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.channel !== IN) return;
    const m = e.data.msg || {};
    if (m.type === 'setFormula') enqueue(() => onSetFormula(m));
    else if (m.type === 'mirror' || ['probeModel', 'exportApp', 'appErrors', 'evalPath', 'fnSource', 'call'].includes(m.type)) onRequest(m); // read-only: no need to wait behind a navigation
    else if (['navigate', 'listProperties', 'listControls', 'expandTree', 'crawlTree', 'renameControl'].includes(m.type)) enqueue(() => onRequest(m));
    else if (m.type === 'resync') {
      last = { control: undefined, property: undefined, formula: undefined };
      lastDiagKey = '';
    }
  });

  setInterval(tick, POLL_MS);

  // ---------------------------------------------------------------------------
  // Diagnostics (called from the popup) — send the output to tune selectors.
  // ---------------------------------------------------------------------------
  function describe(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      class: typeof el.className === 'string' ? el.className.slice(0, 200) || undefined : undefined,
      role: el.getAttribute('role') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      testId: el.getAttribute('data-testid') || el.getAttribute('data-automation-id') || undefined,
      text: (el.value || el.innerText || '').slice(0, 120) || undefined,
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    };
  }

  /**
   * Looks for Studio's in-memory model of the app, to list every control without expanding the tree view:
   * (1) suspicious globals, (2) the React props/state above the tree view, searched for structures that
   * contain the screen names (the virtualized tree is usually fed the whole hierarchy, collapsed nodes included).
   */
  function probeModel() {
    const globals = Object.keys(window)
      .filter((k) => /appmagic|authoring|studio|document|canvas|powerapps|maker/i.test(k))
      .slice(0, 40)
      .map((k) => ({ key: k, type: typeof window[k], keys: safe(() => Object.keys(window[k] || {}).slice(0, 40)) }));

    const tree = document.querySelector('[role="tree"], [role="treegrid"]');
    const fiberKey = tree && Object.keys(tree).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    const screens = new Set(listControls().filter((c) => c.level === 1).map((c) => c.name));
    const hits = [];
    const fibers = [];
    if (fiberKey) {
      const seen = new WeakSet();
      let budget = 60000;
      const shape = (o) => (Array.isArray(o) ? `Array(${o.length})` : o && typeof o === 'object' ? `{${Object.keys(o).slice(0, 25).join(',')}}` : typeof o);
      // Bounded BFS: report every object that holds a screen name in a string field, with its path.
      const search = (root, rootPath) => {
        const queue = [[root, rootPath, 0]];
        while (queue.length && budget-- > 0 && hits.length < 25) {
          const [o, path, depth] = queue.shift();
          if (!o || typeof o !== 'object' || seen.has(o) || depth > 8) continue;
          if (o instanceof Node || o === window) continue;
          seen.add(o);
          let keys;
          try { keys = Object.keys(o); } catch { continue; }
          for (const k of keys.slice(0, 200)) {
            let v;
            try { v = o[k]; } catch { continue; }
            if (typeof v === 'string' && screens.has(v)) {
              hits.push({ path: `${path}.${k}`, value: v, holder: shape(o), childKeys: keys.filter((x) => Array.isArray(o[x]) || (o[x] && typeof o[x] === 'object')).slice(0, 15) });
            } else if (v && typeof v === 'object' && k !== '_owner' && k !== 'return' && k !== 'stateNode') {
              queue.push([v, `${path}.${k}`, depth + 1]);
            }
          }
        }
      };
      let f = tree[fiberKey];
      for (let i = 0; f && i < 40; i++, f = f.return) {
        const name = typeof f.type === 'string' ? f.type : (f.type && (f.type.displayName || f.type.name)) || '?';
        fibers.push({ i, name, props: Object.keys(f.memoizedProps || {}).slice(0, 25) });
        search(f.memoizedProps, `fiber[${i}:${name}].props`);
        search(f.memoizedState, `fiber[${i}:${name}].state`);
        if (f.stateNode && !(f.stateNode instanceof Node)) search(f.stateNode, `fiber[${i}:${name}].instance`);
      }
    }
    return { globals, treeFound: !!tree, reactFiber: !!fiberKey, screens: [...screens], fibers, hits };
  }

  /** Studio's document (a proxy to the authoring service): every control, rule and error lives there. */
  function studioDocument() {
    const doc = safe(() => window.AppMagic.context.document);
    if (!doc || typeof doc.getControlsAsync !== 'function' || typeof doc.serializeControlsForClipboardAsYaml !== 'function') {
      throw new Error("Studio's document model is not available (Studio version not supported)");
    }
    return doc;
  }
  const entityDisplayName = (e) => safe(() => e.displayName ?? e._prop_DisplayName);

  /**
   * Whole app as pa.yaml, one document per screen (+ App), with every formula: the same text as Studio's
   * "Copy code". Read-only, no UI involved.
   */
  async function exportApp() {
    const doc = studioDocument();
    const all = await doc.getControlsAsync();
    const top = (safe(modelTree) || []).filter((c) => c.level === 1).map((c) => c.name);
    // Without the screen list the export would hold App alone, and VS Code would take it as the whole app
    // (deleting every other formula file): refuse until Studio has rendered its tree.
    if (!top.length) throw new Error('Studio is not ready yet (tree view not loaded)');
    const names = top;
    const out = [];
    for (const name of names) {
      const ctrl = all.find((e) => entityDisplayName(e) === name);
      if (!ctrl) continue;
      try {
        out.push({ name, yaml: await doc.serializeControlsForClipboardAsYaml([ctrl]) });
      } catch (e) {
        out.push({ name, error: String(e && e.message ? e.message : e) });
      }
    }
    return { controls: all.length, documents: out };
  }

  const safeAsync = async (fn) => {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  };

  /** Renames a control through Studio's document (no UI). Resolves true when Studio reports success. */
  async function renameViaModel(name, newName) {
    const doc = studioDocument();
    if (typeof doc.tryRenameAsync !== 'function') return false;
    const ctrl = (await doc.getControlsAsync()).find((e) => entityDisplayName(e) === name);
    if (!ctrl) throw new Error(`"${name}" not found in the app`);
    const id = safe(() => ctrl.uniqueId ?? ctrl._prop_UniqueId);
    const r = await doc.tryRenameAsync(id, newName);
    if (r === false) throw new Error(`Studio refused the name "${newName}"`);
    return true;
  }

  /** Every formula error of the app (what Studio's App checker lists). */
  async function appErrors() {
    const doc = studioDocument();
    const errs = await doc.getErrorsAsync();
    // Errors carry the control's unique id: map it to the control name.
    const names = new Map();
    for (const c of (await safeAsync(() => doc.getControlsAsync())) || []) {
      const id = safe(() => c.uniqueId ?? c._prop_UniqueId);
      if (id != null) names.set(String(id), entityDisplayName(c));
    }
    return (errs || []).map((e) => {
      const span = safe(() => e.textSpan) || null;
      const id = safe(() => e.entityId ?? (e.entity && (e.entity.uniqueId ?? e.entity._prop_UniqueId)));
      return {
        control: names.get(String(id)) || safe(() => entityDisplayName(e.entity)) || id,
        property: safe(() => e.propertyName),
        message: safe(() => e.shortMessage || e.longMessage),
        severity: safe(() => e.severity),
        span: span && typeof span === 'object' ? safe(() => JSON.parse(JSON.stringify(span))) : span,
      };
    });
  }

  function diagnose() {
    const target = safe(findFormulaTarget);
    const all = (sel, n = 20) => [...document.querySelectorAll(sel)].filter(isVisible).slice(0, n).map(describe);
    return {
      version: VERSION,
      url: location.href,
      isTop: window === window.top,
      monacoGlobal: !!monacoApi(),
      apiEditors: apiEditors().length,
      monacoNodes: [...document.querySelectorAll('.monaco-editor')].slice(0, 10).map((n) => ({
        ...describe(n),
        editorFound: !!safe(() => findEditorForNode(n)),
      })),
      formulaBar: describe(queryFirst(FORMULA_BAR_SELECTORS)),
      target: target ? target.kind : null,
      control: safe(readControl),
      property: safe(() => readProperty(target)),
      formulaPreview: target ? String(safe(() => readFormula(target))).slice(0, 300) : null,
      candidates: {
        ariaLabels: [...document.querySelectorAll('[aria-label]')]
          .filter((e) => isVisible(e) && /formul|propert|propriét/i.test(e.getAttribute('aria-label')))
          .slice(0, 30)
          .map(describe),
        comboboxes: all('[role="combobox"], select, button[aria-haspopup="listbox"]'),
        selected: all('[aria-selected="true"]'),
        treeItems: all('[role="treeitem"]', 15),
        trees: all('[role="tree"], [role="treegrid"]', 5),
        options: all('[role="option"]', 15),
        controls: safe(listControls),
        model: safe(probeModel),
        diagnostics: target ? safe(() => readDiagnostics(target)) : null,
        canvas: safe(() => {
          const s = mirror();
          return { screen: s.screen, controlsFound: s.controlsFound, controls: (s.controls || []).slice(0, 15), htmlKB: s.html ? Math.round(s.html.length / 1024) : 0, truncated: s.truncated };
        }),
        formulaClassOrId: all('[class*="formula" i], [id*="formula" i]'),
      },
    };
  }

  window.__paBridge = { version: VERSION, diagnose, probeModel };
})();
