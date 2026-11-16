/**
 * Icon generation script for PWA
 * Run with: node scripts/generate-icons.mjs
 * Requires: npm install sharp
 */

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const ICON_SIZES = [72, 96, 128, 144, 152, 192, 384, 512, 1024];
const SOURCE_SVG = path.resolve('public/icons/icon.svg');
const OUTPUT_DIR = path.resolve('public/icons');

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

  for (const size of ICON_SIZES) {
    const outputPath = path.join(OUTPUT_DIR, `icon-${size}.png`);
    await sharp(svgBuffer)
      .resize(size, size, { fit: 'contain', background: { r: 29, g: 78, b: 216, alpha: 1 } })
      .png()
      .toFile(outputPath);
    console.log(`Generated ${outputPath}`);
  }

  // Generate badge
  if (fs.existsSync(BADGE_SOURCE)) {
    const badgeBuffer = fs.readFileSync(BADGE_SOURCE);
    for (const size of BADGE_SIZES) {
      const outputPath = path.join(OUTPUT_DIR, `badge-${size}.png`);
      await sharp(badgeBuffer)
        .resize(size, size, { fit: 'contain', background: { r: 29, g: 78, b: 216, alpha: 1 } })
        .png()
        .toFile(outputPath);
      console.log(`Generated ${outputPath}`);
    }
  }

  // Generate special icons (dashboard, attendance, tasks, chat, calls, notifications)
  const specialIcons = [
    { name: 'dashboard', color: '#1d4ed8', char: '📊' },
    { name: 'attendance', color: '#059669', char: '⏰' },
    { name: 'tasks', color: '#dc2626', char: '✅' },
    { name: 'chat', color: '#7c3aed', char: '💬' },
    { name: 'calls', color: '#16a34a', char: '📞' },
    { name: 'notifications', color: '#ea580c', char: '🔔' },
  ];

  for (const icon of specialIcons) {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192" width="192" height="192">
        <rect width="192" height="192" rx="32" fill="${icon.color}"/>
        <text x="96" y="130" font-size="80" text-anchor="middle" fill="white">${icon.char}</text>
      </svg>
    `;
    const outputPath = path.join(OUTPUT_DIR, `${icon.name}.png`);
    await sharp(Buffer.from(svg))
      .resize(192, 192)
      .png()
      .toFile(outputPath);
    console.log(`Generated ${outputPath}`);
  }

  // Generate maskable icon (with safe zone)
  const maskableSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
      <rect width="512" height="512" rx="96" fill="#1d4ed8"/>
      <path d="M108 404L156 108h8L212 304h16l56-196h8l48 296h-8l-16-64h-16l-56 196h-8l-48-296h8l16 64h16l56-196h-8z" fill="white"/>
    </svg>
  `;
  await sharp(Buffer.from(maskableSvg))
    .resize(512, 512)
    .png()
    .toFile(path.join(OUTPUT_DIR, 'icon-maskable-512.png'));
  console.log('Generated maskable icon');

  console.log('\nAll icons generated successfully!');
  console.log('Note: For production, consider using a proper icon design tool.');
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  generateIcons().catch((err) => {
    console.error('Error generating icons:', err);
    process.exit(1);
  });
}