/**
 * App icons and splash screens for the Android and iOS projects, generated
 * from public/icons/icon.svg (the same artwork as the website icon).
 *
 *   npm run mobile:assets
 *
 * Every image the native templates contain is regenerated at its existing size,
 * so the projects stay valid if Capacitor changes the set of densities.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const BRAND = '#1d4ed8';
const root = path.resolve(import.meta.dirname, '..');
const svg = fs.readFileSync(path.join(root, 'public/icons/icon.svg'), 'utf8');

// The artwork without its rounded blue square (white "W" on transparent).
const glyph = svg.replace(/<rect[^>]*\/>/, '');
// Variants of the full icon.
const square = svg.replace(/rx="\d+"/, 'rx="0"');
const circle = svg.replace(/rx="\d+"/, 'rx="256"');

async function render(source, size) {
  return sharp(Buffer.from(source), { density: Math.max(72, Math.ceil((size / 512) * 72 * 2)) }).resize(size, size).png().toBuffer();
}

/** Artwork centred on a canvas, occupying `scale` of the shorter side. */
async function centred(width, height, scale, background) {
  const size = Math.round(Math.min(width, height) * scale);
  const art = await render(glyph, size);
  return sharp({ create: { width, height, channels: 4, background } })
    .composite([{ input: art, left: Math.round((width - size) / 2), top: Math.round((height - size) / 2) }])
    .png()
    .toBuffer();
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.png')) out.push(full);
  }
  return out;
}

async function regenerate(file, make) {
  const { width, height } = await sharp(file).metadata();
  fs.writeFileSync(file, await make(width, height));
  return `${path.relative(root, file)} ${width}x${height}`;
}

const done = [];

// ---------------------------------------------------------------- Android
const res = path.join(root, 'android/app/src/main/res');
for (const file of walk(res)) {
  const name = path.basename(file);
  if (name === 'ic_launcher.png') done.push(await regenerate(file, (w) => render(svg, w)));
  else if (name === 'ic_launcher_round.png') done.push(await regenerate(file, (w) => render(circle, w)));
  // Adaptive icon foreground: 108dp canvas, artwork inside the 66dp safe zone.
  else if (name === 'ic_launcher_foreground.png') done.push(await regenerate(file, (w, h) => centred(w, h, 0.5, { r: 0, g: 0, b: 0, alpha: 0 })));
  else if (name === 'splash.png') done.push(await regenerate(file, (w, h) => centred(w, h, 0.28, BRAND)));
}
const bgXml = path.join(res, 'values/ic_launcher_background.xml');
if (fs.existsSync(bgXml)) {
  fs.writeFileSync(bgXml, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BRAND.toUpperCase()}</color>\n</resources>\n`);
}

// -------------------------------------------------------------------- iOS
const assets = path.join(root, 'ios/App/App/Assets.xcassets');
for (const file of walk(path.join(assets, 'AppIcon.appiconset'))) {
  // iOS applies its own corner mask and rejects transparency.
  done.push(await regenerate(file, async (w) => sharp(await render(square, w)).flatten({ background: BRAND }).png().toBuffer()));
}
for (const file of walk(path.join(assets, 'Splash.imageset'))) {
  done.push(await regenerate(file, (w, h) => centred(w, h, 0.18, BRAND)));
}

console.log(`[assets] ${done.length} images:\n  ${done.join('\n  ')}`);
