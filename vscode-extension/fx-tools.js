'use strict';

/**
 * Productivity tools built on an index of every formula of the app (after an export, the whole app):
 * references, go to definition, rename (F2), hovers, workspace symbols, pa.yaml outline, clean-up hints,
 * naming suggestions for controls, search in formulas and a Power Fx formatter.
 *
 * Everything here reads the formulas through `api` (see extension.js) and writes only through it:
 * - formula edits are applied to the powerfx: documents, which the bridge sends to Studio;
 * - control renames go through Studio's own rename (which updates the formulas that refer to it).
 */

const vscode = require('vscode');

// ---------------------------------------------------------------------------
// Tokenizer (Power Fx subset: enough for names, strings, comments and brackets)
// ---------------------------------------------------------------------------

const NAME_START = /[A-Za-z_À-￿]/;
const NAME_PART = /[\wÀ-￿]/;
const OPS2 = new Set(['<=', '>=', '<>', '&&', '||', '=>']);

/** @returns {{t: string, v: string, s: number, e: number, quoted?: boolean, inner?: boolean}[]} */
function tokenize(text, offset = 0, inner = false) {
  const toks = [];
  const n = text.length;
  let i = 0;
  const push = (t, v, s, e, extra) => toks.push({ t, v, s: s + offset, e: e + offset, inner, ...extra });
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      let j = i;
      while (j < n && /\s/.test(text[j])) j++;
      push('ws', text.slice(i, j), i, j);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = n;
      push('comment', text.slice(i, j), i, j);
      i = j;
    } else if (c === '/' && text[i + 1] === '*') {
      let j = text.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      push('comment', text.slice(i, j), i, j);
      i = j;
    } else if (c === '"' || (c === '$' && text[i + 1] === '"')) {
      const interp = c === '$';
      let j = interp ? i + 2 : i + 1;
      const holes = [];
      while (j < n) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        if (interp && text[j] === '{') {
          if (text[j + 1] === '{') {
            j += 2;
            continue;
          }
          let depth = 1;
          let k = j + 1;
          while (k < n && depth) {
            if (text[k] === '{') depth++;
            else if (text[k] === '}') depth--;
            k++;
          }
          holes.push([j + 1, k - 1]);
          j = k;
          continue;
        }
        j++;
      }
      push('string', text.slice(i, j), i, j);
      for (const [a, b] of holes) toks.push(...tokenize(text.slice(a, b), offset + a, true));
      i = j;
    } else if (c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== '\n') {
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      push('name', text.slice(i + 1, j - 1).replace(/''/g, "'"), i, j, { quoted: true });
      i = j;
    } else if (NAME_START.test(c)) {
      let j = i + 1;
      while (j < n && NAME_PART.test(text[j])) j++;
      push('name', text.slice(i, j), i, j);
      i = j;
    } else if (/\d/.test(c) || (c === '.' && /\d/.test(text[i + 1] || ''))) {
      let j = i + 1;
      while (j < n && /[\d.eE]/.test(text[j])) j++;
      push('num', text.slice(i, j), i, j);
      i = j;
    } else if (OPS2.has(text.slice(i, i + 2))) {
      push('op', text.slice(i, i + 2), i, i + 2);
      i += 2;
    } else {
      push('op', c, i, i + 1);
      i++;
    }
  }
  return toks;
}

const code = (toks) => toks.filter((t) => t.t !== 'ws' && t.t !== 'comment');

// Functions whose first argument is written, not read.
const WRITES_FIRST = new Set(['Collect', 'ClearCollect', 'Clear', 'Remove', 'RemoveIf', 'Patch', 'UpdateIf', 'Update']);
const KEYWORDS = new Set(['true', 'false', 'And', 'Or', 'Not', 'in', 'exactin', 'As', 'ThisItem', 'ThisRecord', 'Self', 'Parent', 'App', 'Host']);

/**
 * Names defined, written and read by one formula.
 * defs: Set(x…) → global, UpdateContext({x:…}) / Navigate(…, {x:…}) → context, Collect/ClearCollect(c…) → collection.
 */
function analyze(text, { namedFormulas = false } = {}) {
  const toks = code(tokenize(text));
  const defs = [];
  const writes = [];
  const refs = [];
  const calls = []; // stack: { fn, arg } for each open "(" ; "{" pushes { record: true, ctx }
  const aliases = new Set();
  let statementStart = true;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (t.t === 'op') {
      if (t.v === '(') calls.push({ fn: prev && prev.t === 'name' && !prev.quoted ? prev.v : null, arg: 0 });
      else if (t.v === '{') {
        const top = calls[calls.length - 1];
        const ctx = top && !top.record && (top.fn === 'UpdateContext' || (top.fn === 'Navigate' && top.arg >= 2));
        calls.push({ record: true, ctx });
      } else if (t.v === ')' || t.v === '}') calls.pop();
      else if (t.v === ',' && calls.length) calls[calls.length - 1].arg++;
      statementStart = t.v === ';' && calls.length === 0;
      continue;
    }
    if (t.t !== 'name') {
      statementStart = false;
      continue;
    }
    const top = calls[calls.length - 1];
    if (namedFormulas && statementStart && calls.length === 0 && next && (next.v === '=' || next.v === '(' || next.v === ':')) {
      defs.push({ name: t.v, kind: 'named', s: t.s, e: t.e });
      statementStart = false;
      continue;
    }
    statementStart = false;
    if (prev && prev.t === 'op' && (prev.v === '.' || prev.v === '@')) continue; // member access / disambiguation
    if (prev && prev.t === 'name' && prev.v === 'As') {
      aliases.add(t.v);
      continue;
    }
    if (next && next.t === 'op' && next.v === '(' && !t.quoted) continue; // function call
    if (next && next.t === 'op' && next.v === ':' && top && top.record) {
      if (top.ctx) defs.push({ name: t.v, kind: 'context', s: t.s, e: t.e });
      continue; // record field name
    }
    if (!t.quoted && KEYWORDS.has(t.v)) continue;
    if (aliases.has(t.v)) continue;
    if (top && !top.record && top.arg === 0 && prev && prev.v === '(') {
      if (top.fn === 'Set') {
        defs.push({ name: t.v, kind: 'global', s: t.s, e: t.e });
        continue;
      }
      if (top.fn === 'Collect' || top.fn === 'ClearCollect') {
        defs.push({ name: t.v, kind: 'collection', s: t.s, e: t.e });
        continue;
      }
      if (WRITES_FIRST.has(top.fn)) {
        writes.push({ name: t.v, s: t.s, e: t.e });
        continue;
      }
    }
    refs.push({ name: t.v, s: t.s, e: t.e });
  }
  return { defs, writes, refs };
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

const NO_SPACE_BEFORE = new Set([')', ']', '}', ',', ';', '.', ':', '%', '@']);
const NO_SPACE_AFTER = new Set(['(', '[', '{', '.', '@', '!']);
const OPEN = { '(': ')', '[': ']', '{': '}' };

function isUnary(prev) {
  return !prev || (prev.t === 'op' && !(prev.v === ')' || prev.v === ']' || prev.v === '}' || prev.v === '%'));
}

/** Pretty-prints a formula (Studio-like): short groups stay on one line, long ones get one argument per line. */
function formatFormula(text, { width = 80, indent = '    ' } = {}) {
  const all = tokenize(text);
  if (all.some((t) => t.t === 'comment')) return reindent(text, indent); // keep comments where they are
  const toks = code(all).filter((t) => !t.inner);
  if (!toks.length) return text;

  const join = (a, b) => {
    if (!a) return '';
    if (NO_SPACE_BEFORE.has(b.v) && b.t === 'op') return '';
    if (a.t === 'op' && NO_SPACE_AFTER.has(a.v)) return '';
    if (b.t === 'op' && b.v === '(' && a.t === 'name') return '';
    if (a.t === 'op' && a.v === '-' && a.unary) return '';
    return ' ';
  };
  // mark unary minus
  toks.forEach((t, i) => {
    if (t.t === 'op' && t.v === '-' && isUnary(toks[i - 1])) t.unary = true;
  });

  const flat = (from, to) => {
    let s = '';
    for (let i = from; i < to; i++) s += join(toks[i - 1 >= from ? i - 1 : -1] && i > from ? toks[i - 1] : null, toks[i]) + text.slice(toks[i].s, toks[i].e);
    return s;
  };
  const matching = (i) => {
    let depth = 0;
    for (let j = i; j < toks.length; j++) {
      if (toks[j].t !== 'op') continue;
      if (OPEN[toks[j].v]) depth++;
      else if (toks[j].v === ')' || toks[j].v === ']' || toks[j].v === '}') {
        depth--;
        if (!depth) return j;
      }
    }
    return toks.length - 1;
  };
  /** Splits [from, to) at top-level separators. */
  const split = (from, to, seps) => {
    const parts = [];
    let depth = 0;
    let start = from;
    for (let i = from; i < to; i++) {
      const t = toks[i];
      if (t.t === 'op' && OPEN[t.v]) depth++;
      else if (t.t === 'op' && (t.v === ')' || t.v === ']' || t.v === '}')) depth--;
      else if (!depth && t.t === 'op' && seps.includes(t.v)) {
        parts.push([start, i, t.v]);
        start = i + 1;
      }
    }
    if (start < to) parts.push([start, to, null]);
    return parts;
  };

  const render = (from, to, level) => {
    const pad = indent.repeat(level);
    const one = flat(from, to);
    if (pad.length + one.length <= width && !/\n/.test(one)) return one;
    let out = '';
    let i = from;
    while (i < to) {
      const t = toks[i];
      if (t.t === 'op' && OPEN[t.v]) {
        const j = matching(i);
        const inner = render(i + 1, j, level + 1);
        const innerFlat = flat(i + 1, j);
        const head = out.split('\n').pop();
        if (!innerFlat || (pad.length + head.length + innerFlat.length + 2 <= width && !inner.includes('\n'))) {
          out += t.v + innerFlat + toks[j].v;
        } else {
          const parts = split(i + 1, j, [',', ';']);
          out += t.v + '\n';
          parts.forEach(([a, b, sep], k) => {
            out += indent.repeat(level + 1) + render(a, b, level + 1) + (sep ? sep : '') + (k < parts.length - 1 || sep ? '\n' : '\n');
          });
          out += pad + toks[j].v;
        }
        i = j + 1;
        continue;
      }
      out += (i > from ? join(toks[i - 1], t) : '') + text.slice(t.s, t.e);
      i++;
    }
    return out;
  };

  // Top-level ";" chains (behavior formulas): one statement per line.
  const statements = split(0, toks.length, [';']);
  return statements.map(([a, b, sep]) => render(a, b, 0) + (sep || '')).join('\n');
}

/** Re-indents lines by bracket depth, leaving everything else (comments included) untouched. */
function reindent(text, indent = '    ') {
  const toks = tokenize(text);
  const lines = text.split('\n');
  const depthAt = new Array(lines.length).fill(0);
  let depth = 0;
  let line = 0;
  let lineStart = 0;
  const closesFirst = new Array(lines.length).fill(false);
  const firstTok = new Array(lines.length).fill(null);
  for (const t of toks) {
    while (line < lines.length - 1 && t.s >= lineStart + lines[line].length + 1) {
      lineStart += lines[line].length + 1;
      line++;
      depthAt[line] = depth;
    }
    if (t.t === 'ws') continue;
    if (firstTok[line] === null) {
      firstTok[line] = t;
      closesFirst[line] = t.t === 'op' && (t.v === ')' || t.v === ']' || t.v === '}');
    }
    if (t.t === 'op' && OPEN[t.v]) depth++;
    else if (t.t === 'op' && (t.v === ')' || t.v === ']' || t.v === '}')) depth = Math.max(0, depth - 1);
  }
  return lines
    .map((l, i) => {
      if (!l.trim()) return '';
      const ft = firstTok[i];
      if (ft && ft.t !== 'op' && ft.t !== 'name' && ft.t !== 'num' && ft.t !== 'string') return l; // inside a block comment / string
      const d = Math.max(0, depthAt[i] - (closesFirst[i] ? 1 : 0));
      return indent.repeat(d) + l.trimStart();
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Naming conventions
// ---------------------------------------------------------------------------

const DEFAULT_NAME = /^(Label|Button|Container|HorizontalContainer|VerticalContainer|ScreenContainer|Gallery|Icon|Image|Rectangle|Circle|Triangle|TextInput|TextBox|Dropdown|ComboBox|Combobox|Checkbox|Toggle|Radio|DatePicker|Form|EditForm|DisplayForm|DataCard|DataCardValue|DataCardKey|ErrorMessage|StarVisible|Timer|HtmlText|Text|Group|Slider|Rating|Spinner|InfoButton|TabList|Toolbar|Table|Header|Avatar|Badge|Link|Progress|ProgressBar|Shape|Separator|Video|Audio|Camera|PenInput|Attachments|Chart|ColumnChart|LineChart|PieChart|Legend|NumberInput|Accordion|Card)\d+$/;

const DEFAULT_PREFIX = {
  label: 'lbl', button: 'btn', input: 'txt', gallery: 'gal', container: 'ctn', icon: 'ico', image: 'img',
  shape: 'rect', dropdown: 'drp', check: 'chk', date: 'dte', form: 'frm', datacard: 'dc', html: 'htm',
  timer: 'tmr', chart: 'chr', slider: 'sld', group: 'grp', media: 'med', pen: 'pen', screen: '', app: '',
};

const compact = (s) => String(s).replace(/[^A-Za-z0-9]/g, '');
const pascal = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join('');

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function register(context, api) {
  let cache = null;

  /** Index of every known formula: who defines/writes/reads which name. Rebuilt when formulas change. */
  function index() {
    const v = api.version();
    if (cache && cache.version === v) return cache;
    const formulas = [];
    const symbols = new Map(); // name -> { kinds:Set, defs:[], writes:[], refs:[] }
    const sym = (name) => {
      if (!symbols.has(name)) symbols.set(name, { name, kinds: new Set(), defs: [], writes: [], refs: [] });
      return symbols.get(name);
    };
    for (const f of api.formulas()) {
      const a = analyze(f.text, { namedFormulas: f.control === 'App' && f.property === 'Formulas' });
      const entry = { ...f, a };
      formulas.push(entry);
      for (const d of a.defs) {
        const s = sym(d.name);
        s.kinds.add(d.kind);
        s.defs.push({ f: entry, ...d });
      }
      for (const w of a.writes) sym(w.name).writes.push({ f: entry, ...w });
      for (const r of a.refs) sym(r.name).refs.push({ f: entry, ...r });
    }
    const controls = api.controls();
    for (const name of controls.keys()) sym(name).kinds.add('control');
    cache = { version: v, formulas, symbols };
    return cache;
  }

  const kindLabel = (s) =>
    s.kinds.has('named') ? 'Formule nommée'
      : s.kinds.has('collection') ? 'Collection'
      : s.kinds.has('global') ? 'Variable globale'
      : s.kinds.has('context') ? 'Variable de contexte'
      : s.kinds.has('control') ? 'Contrôle'
      : null;

  const posAt = (text, off) => {
    const before = text.slice(0, off);
    const nl = before.lastIndexOf('\n');
    return new vscode.Position(before.split('\n').length - 1, off - nl - 1);
  };
  const loc = (o) => new vscode.Location(o.f.uri, new vscode.Range(posAt(o.f.text, o.s), posAt(o.f.text, o.e)));

  function nameAt(document, position) {
    const toks = tokenize(document.getText());
    const off = document.offsetAt(position);
    const t = toks.find((x) => x.t === 'name' && off >= x.s && off <= x.e);
    return t ? { name: t.v, range: new vscode.Range(document.positionAt(t.s), document.positionAt(t.e)), tok: t } : null;
  }

  const sel = [{ language: 'powerfx' }];

  // --- references / definition -------------------------------------------------
  context.subscriptions.push(
    vscode.languages.registerReferenceProvider(sel, {
      provideReferences(document, position) {
        const at = nameAt(document, position);
        const s = at && index().symbols.get(at.name);
        if (!s) return [];
        return [...s.defs, ...s.writes, ...s.refs].map(loc);
      },
    }),
    vscode.languages.registerDefinitionProvider(sel, {
      provideDefinition(document, position) {
        const at = nameAt(document, position);
        const s = at && index().symbols.get(at.name);
        if (!s) return null;
        if (s.defs.length) return s.defs.map(loc);
        if (s.kinds.has('control')) {
          api.selectControl(at.name); // controls are defined in Studio: select it there
          return null;
        }
        return null;
      },
    })
  );

  // --- hovers ------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(sel, {
      provideHover(document, position) {
        const at = nameAt(document, position);
        const s = at && index().symbols.get(at.name);
        if (!s) return null;
        const label = kindLabel(s);
        if (!label || label === 'Contrôle') {
          if (!s.refs.length) return null;
          const where = new Set(s.refs.map((r) => r.f.control));
          return new vscode.Hover(`Référencé dans ${s.refs.length} formule(s) de ${where.size} contrôle(s)`, at.range);
        }
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${s.name}** · ${label}\n\n`);
        if (s.kinds.has('named') && s.defs[0]) {
          const d = s.defs[0];
          const body = d.f.text.slice(d.s, d.f.text.indexOf(';', d.e) > 0 ? d.f.text.indexOf(';', d.e) : undefined);
          md.appendCodeblock(body.length > 600 ? body.slice(0, 600) + '…' : body, 'powerfx');
        } else {
          const sites = [...s.defs, ...s.writes];
          md.appendMarkdown(`Défini/modifié dans ${sites.length} endroit(s) :\n\n`);
          for (const d of sites.slice(0, 8)) {
            const line = d.f.text.split('\n')[posAt(d.f.text, d.s).line].trim();
            md.appendMarkdown(`- \`${d.f.control}.${d.f.property}\` — ${line.length > 70 ? line.slice(0, 70) + '…' : line}\n`);
          }
          if (sites.length > 8) md.appendMarkdown(`- … et ${sites.length - 8} autre(s)\n`);
        }
        md.appendMarkdown(`\nLu dans ${s.refs.length} formule(s).`);
        return new vscode.Hover(md, at.range);
      },
    })
  );

  // --- rename (F2) -------------------------------------------------------------------
  const validName = (v) => /^[A-Za-z_À-￿][\wÀ-￿]*$/.test(v);
  context.subscriptions.push(
    vscode.languages.registerRenameProvider(sel, {
      prepareRename(document, position) {
        const at = nameAt(document, position);
        const s = at && index().symbols.get(at.name);
        if (!s || !kindLabel(s)) throw new Error('Seuls les contrôles, variables, collections et formules nommées se renomment ici.');
        return { range: at.range, placeholder: at.name };
      },
      async provideRenameEdits(document, position, newName) {
        const at = nameAt(document, position);
        const s = at && index().symbols.get(at.name);
        if (!s) return null;
        newName = newName.trim();
        if (!newName || newName === s.name) return null;
        if (index().symbols.has(newName) && kindLabel(index().symbols.get(newName))) {
          throw new Error(`"${newName}" est déjà utilisé.`);
        }
        if (s.kinds.has('control')) {
          await api.renameControl(s.name, newName); // Studio updates every reference itself
          return new vscode.WorkspaceEdit();
        }
        if (!validName(newName)) throw new Error('Nom invalide (lettres, chiffres, _).');
        const sites = [...s.defs, ...s.writes, ...s.refs];
        const files = new Set(sites.map((x) => x.f.uri.toString()));
        if (files.size > 1) {
          const ok = await vscode.window.showWarningMessage(
            `Renommer « ${s.name} » modifie ${files.size} formules dans Studio (Studio va les ouvrir une par une).`,
            { modal: true },
            'Renommer'
          );
          if (ok !== 'Renommer') return null;
        }
        const edit = new vscode.WorkspaceEdit();
        for (const x of sites) edit.replace(x.f.uri, loc(x).range, newName);
        return edit;
      },
    })
  );

  // --- workspace symbols (Ctrl+T) ----------------------------------------------------
  context.subscriptions.push(
    vscode.languages.registerWorkspaceSymbolProvider({
      provideWorkspaceSymbols(query) {
        const q = query.toLowerCase();
        const out = [];
        const controls = api.controls();
        for (const s of index().symbols.values()) {
          if (q && !s.name.toLowerCase().includes(q)) continue;
          const label = kindLabel(s);
          if (!label) continue;
          let at = s.defs[0] || s.writes[0];
          let kind = vscode.SymbolKind.Variable;
          let container = label;
          if (label === 'Collection') kind = vscode.SymbolKind.Array;
          if (label === 'Formule nommée') kind = vscode.SymbolKind.Constant;
          if (label === 'Contrôle') {
            const node = controls.get(s.name);
            kind = node && node.level === 1 ? vscode.SymbolKind.Module : vscode.SymbolKind.Field;
            container = (node && api.pathOf(s.name)[0]) || 'Contrôle';
            const f = index().formulas.find((x) => x.control === s.name);
            if (!f) continue;
            at = { f, s: 0, e: 0 };
          }
          if (!at) continue;
          out.push(new vscode.SymbolInformation(s.name, kind, container, loc(at)));
          if (out.length > 500) break;
        }
        return out;
      },
    })
  );

  // --- outline of src/*.pa.yaml --------------------------------------------------------
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider({ pattern: '**/*.pa.yaml' }, {
      provideDocumentSymbols(document) {
        const roots = [];
        const stack = [];
        for (let i = 0; i < document.lineCount; i++) {
          const line = document.lineAt(i).text;
          const m = /^(\s*)(?:-\s+)?([^\s:#][^:]*?):\s*$/.exec(line);
          if (!m) continue;
          const name = m[2].replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
          if (['Screens', 'Properties', 'Children', 'App', 'ComponentDefinitions'].includes(name) && name !== 'App') continue;
          const indent = m[1].length + (line.trimStart().startsWith('- ') ? 2 : 0);
          // Control: X@… on the next lines gives the type
          let detail = '';
          for (let j = i + 1; j < Math.min(document.lineCount, i + 4); j++) {
            const c = /^\s*Control:\s*(.+)$/.exec(document.lineAt(j).text);
            if (c) detail = c[1];
          }
          while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
          const range = new vscode.Range(i, 0, i, line.length);
          const sym = new vscode.DocumentSymbol(name, detail, detail ? vscode.SymbolKind.Field : vscode.SymbolKind.Module, range, range);
          (stack.length ? stack[stack.length - 1].sym.children : roots).push(sym);
          stack.push({ indent, sym });
        }
        // extend ranges to cover children
        const extend = (s) => {
          s.children.forEach(extend);
          const last = s.children.length ? s.children[s.children.length - 1].range.end : s.range.end;
          s.range = new vscode.Range(s.range.start, last);
        };
        roots.forEach(extend);
        return roots;
      },
    })
  );

  // --- formatter -------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(sel, {
      provideDocumentFormattingEdits(document, options) {
        const text = document.getText();
        const indent = options.insertSpaces ? ' '.repeat(options.tabSize || 4) : '\t';
        const out = formatFormula(text, { indent, width: api.config().get('formatWidth', 80) });
        if (out === text) return [];
        return [vscode.TextEdit.replace(new vscode.Range(document.positionAt(0), document.positionAt(text.length)), out)];
      },
    })
  );

  // --- clean-up hints (Problems view + _lint.json) -----------------------------------------
  const lint = vscode.languages.createDiagnosticCollection('powerfx-lint');
  context.subscriptions.push(lint);
  let lintTimer = null;
  let lastLint = [];

  function runLint() {
    lint.clear();
    if (!api.config().get('lint', true)) return;
    const { symbols, formulas } = index();
    if (!formulas.length) return;
    const byUri = new Map();
    const findings = [];
    const add = (o, message, kind) => {
      const l = loc(o);
      const d = new vscode.Diagnostic(l.range, message, vscode.DiagnosticSeverity.Information);
      d.source = 'Power Apps (nettoyage)';
      d.tags = [vscode.DiagnosticTag.Unnecessary];
      d.code = kind;
      const key = l.uri.toString();
      if (!byUri.has(key)) byUri.set(key, { uri: l.uri, list: [] });
      byUri.get(key).list.push(d);
      findings.push({ kind, message, control: o.f.control, property: o.f.property });
    };
    for (const s of symbols.values()) {
      const label = kindLabel(s);
      if (!label || label === 'Contrôle' || s.refs.length) continue;
      const msg =
        label === 'Collection' ? `Collection « ${s.name} » remplie mais jamais lue`
          : label === 'Formule nommée' ? `Formule nommée « ${s.name} » jamais utilisée`
          : `${label} « ${s.name} » définie mais jamais lue`;
      for (const d of s.defs) add(d, msg, 'unused');
    }
    // Hidden controls that nothing refers to (Visible = false).
    for (const f of formulas) {
      if (f.property !== 'Visible' || f.text.trim().toLowerCase() !== 'false') continue;
      const s = symbols.get(f.control);
      if (s && s.refs.length) continue;
      add({ f, s: 0, e: f.text.length }, `« ${f.control} » est masqué (Visible = false) et jamais référencé`, 'hidden');
    }
    for (const { uri, list } of byUri.values()) lint.set(uri, list);
    lastLint = findings;
    api.writeWorkspaceFile('_lint.json', JSON.stringify({ updated: new Date().toISOString(), findings, naming: namingIssues() }, null, 2) + '\n');
  }

  const scheduleLint = () => {
    clearTimeout(lintTimer);
    lintTimer = setTimeout(() => {
      try {
        runLint();
      } catch (e) {
        api.log(`Lint failed: ${e.message}`);
      }
    }, 1500);
  };

  // --- naming --------------------------------------------------------------------------------
  /** Prefix most used by the app for a control type ("lbl", "btn"…), else a default. */
  function conventionPrefix(typeKey) {
    const counts = new Map();
    for (const [name, node] of api.controls()) {
      if (api.typeOf(node).key !== typeKey || DEFAULT_NAME.test(name)) continue;
      const m = /^([a-z]{2,5})(?=[A-Z0-9_])/.exec(name);
      if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
    const best = [...counts].sort((a, b) => b[1] - a[1])[0];
    return best && best[1] >= 2 ? best[0] : DEFAULT_PREFIX[typeKey] ?? 'ctl';
  }

  /** Does the app suffix control names with their screen ("…_HomeScreen")? */
  function usesScreenSuffix() {
    let yes = 0;
    let total = 0;
    for (const [name, node] of api.controls()) {
      if (node.level <= 1) continue;
      const screen = api.pathOf(name)[0];
      if (!screen) continue;
      total++;
      if (name.toLowerCase().endsWith('_' + compact(screen).toLowerCase())) yes++;
    }
    return total > 0 && yes / total > 0.4;
  }

  const NOT_DESCRIPTIVE = new Set([...KEYWORDS, 'Parent', 'Self', 'ThisItem', 'ThisRecord', 'Blank', 'true', 'false']);

  function describe(name, depth = 0) {
    const formula = (p) => api.formula(name, p);
    const lit = /^\s*"((?:[^"]|"")*)"\s*$/;
    for (const p of ['Text', 'Default', 'HintText', 'Placeholder', 'Label', 'DisplayName', 'AccessibleLabel', 'Tooltip']) {
      const m = lit.exec(formula(p) || '');
      if (m && m[1].trim()) return pascal(m[1].replace(/""/g, '"'));
    }
    const icon = /^\s*(?:Icon\.(\w+)|"(\w+)")\s*$/.exec(formula('Icon') || '');
    if (icon) return icon[1] || icon[2];
    const field = /^\s*"([^"]+)"\s*$/.exec(formula('DataField') || '');
    if (field) return pascal(field[1]);
    // Items: first data source / variable (not a function, not Parent/Self…)
    const toks = code(tokenize(formula('Items') || ''));
    const src = toks.find((t, i) => t.t === 'name' && !(toks[i + 1] && toks[i + 1].v === '(') && !NOT_DESCRIPTIVE.has(t.v) && !(toks[i - 1] && toks[i - 1].v === '.'));
    if (src) return pascal(src.v.replace(/^(col|var|loc|ctx)(?=[A-Z])/, ''));
    // Inside a data card (DataCardValue12, DataCardKey3…): the card's field.
    const parent = api.pathOf(name).slice(-1)[0];
    const pnode = parent && api.controls().get(parent);
    if (depth === 0 && pnode && api.typeOf(pnode).key === 'datacard') {
      const d = describe(parent, 1);
      if (d) return d + (/Key\d+$/.test(name) ? 'Label' : /ErrorMessage\d+$/.test(name) ? 'Error' : '');
    }
    return null;
  }

  /** Suggested name for a control, following the app's own convention; null when nothing meaningful. */
  function suggestName(name) {
    const controls = api.controls();
    const node = controls.get(name);
    if (!node) return null;
    const type = api.typeOf(node);
    if (type.key === 'screen' || type.key === 'app' || type.key === 'other' || type.key === 'group') return null;
    const desc = describe(name);
    if (!desc) return null;
    const screen = api.pathOf(name)[0];
    const suffix = usesScreenSuffix() && screen ? '_' + compact(screen) : '';
    const base = `${conventionPrefix(type.key)}${desc}${suffix}`;
    const taken = new Set([...controls.keys()].map((n) => n.toLowerCase()));
    let candidate = base;
    for (let i = 2; taken.has(candidate.toLowerCase()) && candidate !== name; i++) candidate = `${conventionPrefix(type.key)}${desc}${i}${suffix}`;
    return candidate === name ? null : candidate;
  }

  /** Controls with Studio's default names (Label3, Button12…), with a suggestion when one can be made. */
  function namingIssues() {
    const out = [];
    for (const [name, node] of api.controls()) {
      if (node.level <= 1 || !DEFAULT_NAME.test(name)) continue;
      out.push({ name, screen: api.pathOf(name)[0], type: api.typeOf(node).label, suggestion: suggestName(name) });
    }
    return out;
  }

  async function cmdSuggestNames() {
    const issues = namingIssues();
    if (!issues.length) return vscode.window.showInformationMessage('Power Apps : aucun contrôle avec un nom par défaut.');
    const items = issues.map((i) => ({
      label: i.suggestion ? `${i.name}  →  ${i.suggestion}` : i.name,
      description: [i.type, i.screen].filter(Boolean).join(' · '),
      detail: i.suggestion ? undefined : 'Pas de suggestion (aucun texte/icône/donnée pour le décrire) : choisir pour saisir un nom',
      picked: !!i.suggestion,
      issue: i,
    }));
    const picks = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: `${issues.length} contrôle(s) au nom par défaut — cochez ceux à renommer (Studio met à jour les références)`,
      matchOnDescription: true,
    });
    if (!picks || !picks.length) return;
    const plan = [];
    for (const p of picks) {
      let target = p.issue.suggestion;
      if (!target || picks.length <= 5) {
        target = await vscode.window.showInputBox({
          title: `Renommer ${p.issue.name}`,
          value: target || p.issue.name,
          prompt: `${p.issue.type}${p.issue.screen ? ' · ' + p.issue.screen : ''}`,
        });
      }
      if (target && target.trim() && target.trim() !== p.issue.name) plan.push([p.issue.name, target.trim()]);
    }
    if (!plan.length) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Power Apps : renommage', cancellable: true },
      async (progress, token) => {
        let done = 0;
        for (const [from, to] of plan) {
          if (token.isCancellationRequested) break;
          progress.report({ message: `${from} → ${to}`, increment: 100 / plan.length });
          try {
            await api.renameControl(from, to, { refresh: false });
            done++;
          } catch (e) {
            vscode.window.showWarningMessage(`Power Apps : ${from} → ${to} : ${e.message}`);
          }
        }
        await api.afterRenames();
        vscode.window.setStatusBarMessage(`$(check) ${done} contrôle(s) renommé(s)`, 5000);
      }
    );
  }

  // --- search in formulas --------------------------------------------------------------------
  async function cmdSearchFormulas() {
    const qp = vscode.window.createQuickPick();
    qp.placeholder = 'Rechercher dans toutes les formules (texte, nom de variable, de contrôle…)';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    const update = (q) => {
      const query = q.trim().toLowerCase();
      if (query.length < 2) {
        qp.items = [];
        return;
      }
      const items = [];
      for (const f of index().formulas) {
        const lines = f.text.split('\n');
        for (let i = 0; i < lines.length && items.length < 300; i++) {
          if (!lines[i].toLowerCase().includes(query)) continue;
          items.push({ label: `${f.control}.${f.property}`, description: `ligne ${i + 1}`, detail: lines[i].trim().slice(0, 160), f, line: i, alwaysShow: true });
        }
      }
      qp.items = items;
    };
    qp.onDidChangeValue(update);
    qp.onDidAccept(async () => {
      const it = qp.selectedItems[0];
      qp.hide();
      if (!it) return;
      await api.openFormula(it.f.control, it.f.property);
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document.uri.toString() === it.f.uri.toString()) {
        const p = new vscode.Position(it.line, 0);
        ed.selection = new vscode.Selection(p, p);
        ed.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenter);
      }
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  async function cmdFindUsages(node) {
    const name = (node && node.name) || node;
    if (!name) return;
    const s = index().symbols.get(name);
    const locations = s ? [...s.defs, ...s.writes, ...s.refs].map(loc) : [];
    if (!locations.length) return vscode.window.showInformationMessage(`Power Apps : « ${name} » n'est référencé dans aucune formule connue.`);
    await vscode.commands.executeCommand('editor.action.showReferences', locations[0].uri, locations[0].range.start, locations);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('powerappsBridge.suggestNames', cmdSuggestNames),
    vscode.commands.registerCommand('powerappsBridge.searchFormulas', cmdSearchFormulas),
    vscode.commands.registerCommand('powerappsBridge.findUsages', cmdFindUsages),
    vscode.commands.registerCommand('powerappsBridge.runLint', () => {
      runLint();
      vscode.commands.executeCommand('workbench.actions.view.problems');
    })
  );

  return {
    onFormulasChanged: scheduleLint,
    suggestName,
    isDefaultName: (n) => DEFAULT_NAME.test(n),
    references: (name) => {
      const s = index().symbols.get(name);
      return s ? s.refs.length : 0;
    },
    lintFindings: () => lastLint,
  };
}

module.exports = { register, tokenize, analyze, formatFormula, reindent };
