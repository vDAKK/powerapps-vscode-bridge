// Runs in the page's MAIN world (needs access to Monaco / React internals of Power Apps Studio).
// Detects the selected control + property + formula, reports changes, and applies formulas sent by VS Code.
(() => {
  'use strict';
  if (window.__paBridge) return;

  const VERSION = '0.1.0';
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
  function readControl() {
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
  // Main loop + messaging
  // ---------------------------------------------------------------------------
  let last = { control: undefined, property: undefined, formula: undefined };
  let currentTarget = null;

  function post(msg) {
    window.postMessage({ channel: OUT, msg }, '*');
  }

  function tick() {
    const target = safe(findFormulaTarget);
    if (!target) return;
    const formula = safe(() => readFormula(target));
    if (formula == null) return;
    currentTarget = target;
    const control = safe(readControl) || 'Unknown';
    const property = safe(() => readProperty(target)) || 'Unknown';
    const base = { control, property, formula, mode: target.kind };
    if (control !== last.control || property !== last.property) post({ type: 'selection', ...base });
    else if (formula !== last.formula) post({ type: 'formula', ...base });
    last = { control, property, formula };
  }

  function onSetFormula(m) {
    const reply = (ok, error) => post({ type: 'result', ok, error, control: m.control, property: m.property });
    const t = currentTarget || safe(findFormulaTarget);
    if (!t) return reply(false, 'Formula bar not found in Studio');
    if (m.control !== last.control || m.property !== last.property) {
      return reply(false, `Studio is on ${last.control}.${last.property}, not ${m.control}.${m.property}: edit ignored`);
    }
    let r;
    try {
      r = writeFormula(t, m.formula);
    } catch (e) {
      r = { ok: false, error: String(e && e.message ? e.message : e) };
    }
    if (r.ok) last.formula = safe(() => readFormula(t)) ?? m.formula;
    reply(r.ok, r.error);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.channel !== IN) return;
    const m = e.data.msg || {};
    if (m.type === 'setFormula') onSetFormula(m);
    else if (m.type === 'resync') last = { control: undefined, property: undefined, formula: undefined };
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
        formulaClassOrId: all('[class*="formula" i], [id*="formula" i]'),
      },
    };
  }

  window.__paBridge = { version: VERSION, diagnose };
})();
