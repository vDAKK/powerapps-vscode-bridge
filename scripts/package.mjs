// Builds both store packages into dist/:
//   dist/powerapps-bridge-<version>.vsix              VS Code Marketplace / Open VSX
//   dist/powerapps-x-vscode-browser-<version>.zip     Chrome Web Store / Edge Add-ons / Firefox AMO
// Usage: node scripts/package.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

const vsPkg = JSON.parse(fs.readFileSync(path.join(root, 'vscode-extension/package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'browser-extension/manifest.json'), 'utf8'));
if (vsPkg.version !== manifest.version) {
  console.warn(`Warning: version mismatch (VS Code ${vsPkg.version}, browser ${manifest.version})`);
}

// 1. VS Code extension
const vsix = path.join(dist, `${vsPkg.name}-${vsPkg.version}.vsix`);
execSync(`npx --yes @vscode/vsce package --out "${vsix}"`, {
  cwd: path.join(root, 'vscode-extension'),
  stdio: 'inherit',
});

// 2. Browser extension (manifest.json at the root of the zip)
const srcDir = path.join(root, 'browser-extension');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) walk(full);
    else files.push(full);
  }
})(srcDir);

const zipPath = path.join(dist, `powerapps-x-vscode-browser-${manifest.version}.zip`);
fs.writeFileSync(
  zipPath,
  makeZip(files.map((f) => ({ name: path.relative(srcDir, f).split(path.sep).join('/'), data: fs.readFileSync(f) })))
);
console.log(`Packaged: ${zipPath} (${files.length} files)`);

// Minimal zip writer (deflate), no dependencies.
function makeZip(entries) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}
