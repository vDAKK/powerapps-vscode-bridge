'use strict';

// SVG glyphs shared by the side bar webviews (16×16, stroked like VS Code's codicons). Injected into each page
// as data: the webviews have no access to the codicon font.

const TYPE_ICONS = {
  screen: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 5.5h12"/>',
  button: '<rect x="1.5" y="4.5" width="13" height="7" rx="3.5"/><path d="M6 8h4"/>',
  label: '<path d="M3 4h10M8 4v9M6 13h4"/>',
  input: '<rect x="1.5" y="4.5" width="13" height="7" rx="1.5"/><path d="M4.5 6.5v3"/>',
  gallery: '<rect x="2" y="2" width="12" height="3.5" rx="1"/><rect x="2" y="6.5" width="12" height="3.5" rx="1"/><path d="M2 12.5h12"/>',
  container: '<rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M2 6.5h12M6.5 6.5V14"/>',
  form: '<path d="M3 3.5h10M3 7h6M3 10.5h8"/><rect x="11" y="9" width="3" height="3" rx=".5"/>',
  image: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="6" cy="6.5" r="1.3"/><path d="m2.5 12 4-4 3 3 2-2 2.5 2.5"/>',
  app: '<path d="M8 1.5l5.5 3.2v6.6L8 14.5l-5.5-3.2V4.7z"/><path d="M8 8v6.5M8 8l5.5-3.3M8 8 2.5 4.7"/>',
  hidden: '<path d="M2 2l12 12M6.5 6.6a2 2 0 0 0 2.9 2.8M4 4.6C2.5 5.8 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1.3 0 2.4-.4 3.3-1M7 3.6c.3 0 .7-.1 1-.1 4 0 6.5 4.5 6.5 4.5s-.5 1-1.5 2"/>',
  other: '<rect x="3" y="3" width="10" height="10" rx="2"/>',
};
const TYPE_ALIASES = { group: 'container', datacard: 'form', dropdown: 'input', component: 'container' };

/** JS source defining typeIcon(key) -> '<svg>…</svg>' inside a webview script. */
function typeIconScript() {
  return (
    `const TYPE_ICONS = ${JSON.stringify(TYPE_ICONS)};\n` +
    `const TYPE_ALIASES = ${JSON.stringify(TYPE_ALIASES)};\n` +
    "const typeIcon = (k) => '<svg viewBox=\"0 0 16 16\">' + (TYPE_ICONS[k] || TYPE_ICONS[TYPE_ALIASES[k]] || TYPE_ICONS.other) + '</svg>';\n"
  );
}

module.exports = { typeIconScript };
