/**
 * Comprehensive Icon Generation Script for Web, PWA, and Android App
 * Run with: node scripts/generate-icons.mjs
 */

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const ICON_SIZES = [72, 96, 128, 144, 152, 192, 384, 512, 1024];
const FAVICON_SIZES = [16, 32, 48, 64, 128, 256];
const SOURCE_SVG = path.resolve('public/icon.svg');
const PUBLIC_DIR = path.resolve('public');
const OUTPUT_DIR = path.resolve('public/icons');
const ANDROID_RES_DIR = path.resolve('android/app/src/main/res');

// Badge sizes
const BADGE_SIZES = [72];
const BADGE_SOURCE = path.resolve('public/icons/badge.svg');

export async function generateIcons() {
  if (!fs.existsSync(SOURCE_SVG)) {
    console.error('Source SVG not found:', SOURCE_SVG);
    process.exit(1);
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const svgBuffer = fs.readFileSync(SOURCE_SVG);

  // 1. Generate Favicons in public/
  for (const size of FAVICON_SIZES) {
    const faviconPath = path.join(PUBLIC_DIR, `favicon-${size}.png`);
    await sharp(svgBuffer)
      .resize(size, size, { fit: 'contain' })
      .png()
      .toFile(faviconPath);
    console.log(`Generated ${faviconPath}`);
  }

  // Generate favicon.ico from 32x32 and 16x16
  const png32 = fs.readFileSync(path.join(PUBLIC_DIR, 'favicon-32.png'));
  const png16 = fs.readFileSync(path.join(PUBLIC_DIR, 'favicon-16.png'));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // ICO type
  header.writeUInt16LE(2, 4); // 2 images
  const entry1 = Buffer.alloc(16);
  entry1.writeUInt8(32, 0); // width
  entry1.writeUInt8(32, 1); // height
  entry1.writeUInt8(0, 2);  // color count
  entry1.writeUInt8(0, 3);  // reserved
  entry1.writeUInt16LE(1, 4); // color planes
  entry1.writeUInt16LE(32, 6); // bpp
  entry1.writeUInt32LE(png32.length, 8); // size
  entry1.writeUInt32LE(6 + 32, 12); // offset
  const entry2 = Buffer.alloc(16);
  entry2.writeUInt8(16, 0);
  entry2.writeUInt8(16, 1);
  entry2.writeUInt8(0, 2);
  entry2.writeUInt8(0, 3);
  entry2.writeUInt16LE(1, 4);
  entry2.writeUInt16LE(32, 6);
  entry2.writeUInt32LE(png16.length, 8);
  entry2.writeUInt32LE(6 + 32 + png32.length, 12);
  fs.writeFileSync(path.join(PUBLIC_DIR, 'favicon.ico'), Buffer.concat([header, entry1, entry2, png32, png16]));
  console.log('Generated public/favicon.ico');

  // 2. Generate PWA Icons in public/icons/
  for (const size of ICON_SIZES) {
    const outputPath = path.join(OUTPUT_DIR, `icon-${size}.png`);
    await sharp(svgBuffer)
      .resize(size, size, { fit: 'contain' })
      .png()
      .toFile(outputPath);
    console.log(`Generated ${outputPath}`);
  }

  // Generate badge if badge.svg exists
  if (fs.existsSync(BADGE_SOURCE)) {
    const badgeBuffer = fs.readFileSync(BADGE_SOURCE);
    for (const size of BADGE_SIZES) {
      const outputPath = path.join(OUTPUT_DIR, `badge-${size}.png`);
      await sharp(badgeBuffer)
        .resize(size, size, { fit: 'contain' })
        .png()
        .toFile(outputPath);
      console.log(`Generated ${outputPath}`);
    }
  }

  // Generate maskable icon
  await sharp(svgBuffer)
    .resize(512, 512, { fit: 'contain' })
    .png()
    .toFile(path.join(OUTPUT_DIR, 'icon-maskable-512.png'));
  console.log('Generated maskable icon');

  // 3. Generate Android Mipmap Icons
  if (fs.existsSync(ANDROID_RES_DIR)) {
    const mipmaps = [
      { folder: 'mipmap-mdpi', iconSize: 48, fgSize: 108 },
      { folder: 'mipmap-hdpi', iconSize: 72, fgSize: 162 },
      { folder: 'mipmap-xhdpi', iconSize: 96, fgSize: 216 },
      { folder: 'mipmap-xxhdpi', iconSize: 144, fgSize: 324 },
      { folder: 'mipmap-xxxhdpi', iconSize: 192, fgSize: 432 },
    ];

    for (const m of mipmaps) {
      const targetDir = path.join(ANDROID_RES_DIR, m.folder);
      if (fs.existsSync(targetDir)) {
        // ic_launcher.png
        await sharp(svgBuffer)
          .resize(m.iconSize, m.iconSize, { fit: 'contain' })
          .png()
          .toFile(path.join(targetDir, 'ic_launcher.png'));

        // ic_launcher_round.png
        await sharp(svgBuffer)
          .resize(m.iconSize, m.iconSize, { fit: 'contain' })
          .png()
          .toFile(path.join(targetDir, 'ic_launcher_round.png'));

        // ic_launcher_foreground.png
        await sharp(svgBuffer)
          .resize(m.fgSize, m.fgSize, { fit: 'contain' })
          .png()
          .toFile(path.join(targetDir, 'ic_launcher_foreground.png'));

        console.log(`Updated Android ${m.folder} icons (${m.iconSize}px, ${m.fgSize}px)`);
      }
    }
  }

  console.log('\nAll web, PWA and Android branding icons generated successfully!');
}

await generateIcons();
