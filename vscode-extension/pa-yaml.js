'use strict';

/**
 * Minimal reader for the pa.yaml that Power Apps Studio emits ("Copy code"): extracts, for every control,
 * its name, its "Control:" template and its "Properties:" formulas. Not a general YAML parser: it handles
 * the shapes Studio writes (plain "=…" scalars, quoted scalars and literal blocks "|", "|-", "|+").
 *
 * @returns {{ name: string, control?: string, properties: Record<string, string> }[]}
 *          formulas without their leading "=", in document order.
 */
function parsePaYaml(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const indentOf = (l) => l.length - l.trimStart().length;
  const isBlank = (l) => !l.trim();
  const out = [];

  /** Name of the mapping that owns the line at index i (first non-blank line above with a smaller indent). */
  const ownerAbove = (i, indent) => {
    for (let j = i - 1; j >= 0; j--) {
      const l = lines[j];
      if (isBlank(l) || indentOf(l) >= indent) continue;
      const m = /^\s*(?:-\s+)?(.+?):\s*$/.exec(l);
      return m ? unquoteKey(m[1]) : null;
    }
    return null;
  };

  const controlOf = (i, indent) => {
    // "Control: X@1.2.3" sits at the same indent as "Properties:", above or below it, within the owner block.
    for (let j = i - 1; j >= 0 && (isBlank(lines[j]) || indentOf(lines[j]) >= indent); j--) {
      const m = indentOf(lines[j]) === indent && /^\s*Control:\s*(.+?)\s*$/.exec(lines[j]);
      if (m) return m[1];
    }
    for (let j = i + 1; j < lines.length && (isBlank(lines[j]) || indentOf(lines[j]) >= indent); j++) {
      const m = indentOf(lines[j]) === indent && /^\s*Control:\s*(.+?)\s*$/.exec(lines[j]);
      if (m) return m[1];
    }
    return undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*Properties:\s*$/.test(line)) continue;
    const pIndent = indentOf(line);
    const name = ownerAbove(i, pIndent);
    if (!name) continue;
    const properties = {};
    let k = i + 1;
    let keyIndent = null;
    while (k < lines.length) {
      const l = lines[k];
      if (isBlank(l)) {
        k++;
        continue;
      }
      const ind = indentOf(l);
      if (ind <= pIndent) break;
      if (keyIndent === null) keyIndent = ind;
      if (ind !== keyIndent) {
        k++;
        continue;
      }
      const m = /^\s*([^:]+?|"[^"]*"|'[^']*'):(?:\s+(.*))?$/.exec(l);
      if (!m) {
        k++;
        continue;
      }
      const key = unquoteKey(m[1]);
      const rest = (m[2] || '').trim();
      const block = /^([|>])([+-]?)(\d*)([+-]?)$/.exec(rest);
      if (block) {
        const chomp = block[2] || block[4];
        const body = [];
        let j = k + 1;
        let contentIndent = block[3] ? keyIndent + Number(block[3]) : null;
        while (j < lines.length) {
          const b = lines[j];
          if (!isBlank(b)) {
            const bi = indentOf(b);
            if (bi <= keyIndent) break;
            if (contentIndent === null) contentIndent = bi;
          }
          body.push(b);
          j++;
        }
        // Trailing blank lines belong to the block only for chomping purposes.
        let end = body.length;
        while (end > 0 && isBlank(body[end - 1])) end--;
        const content = body.slice(0, end).map((b) => (isBlank(b) ? '' : b.slice(contentIndent ?? 0)));
        let value = content.join('\n');
        if (block[1] === '>') value = content.join(' ');
        if (chomp === '+') value += '\n'.repeat(body.length - end + 1);
        else if (chomp !== '-' && content.length) value += '\n';
        properties[key] = stripEquals(value);
        k = j;
        continue;
      }
      properties[key] = stripEquals(unquoteScalar(rest));
      k++;
    }
    out.push({ name, control: controlOf(i, pIndent), properties });
    i = k - 1;
  }
  return out;
}

function stripEquals(v) {
  return v.startsWith('=') ? v.slice(1) : v;
}

function unquoteKey(k) {
  return unquoteScalar(k.trim());
}

function unquoteScalar(s) {
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

module.exports = { parsePaYaml };
