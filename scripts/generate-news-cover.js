#!/usr/bin/env node
/* eslint-disable no-console */
// Generates docs/news.png — a portrait cover (1080x1350) for the
// "Aurora Pulse Website is live" news post.
// Renders an SVG with the brand gradient + headline + URL and converts
// it to PNG via the locally installed sharp from src/node_modules.
const path = require('path');
const fs = require('fs');

const sharpPath = path.resolve(__dirname, '..', 'src', 'node_modules', 'sharp');
const sharp = require(sharpPath);

const W = 1080;
const H = 1350;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"  stop-color="#020408"/>
      <stop offset="55%" stop-color="#0b1320"/>
      <stop offset="100%" stop-color="#000000"/>
    </linearGradient>
    <radialGradient id="glow1" cx="20%" cy="18%" r="55%">
      <stop offset="0%"  stop-color="#1ee49a" stop-opacity="0.55"/>
      <stop offset="60%" stop-color="#1ee49a" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="85%" cy="80%" r="55%">
      <stop offset="0%"  stop-color="#ff8a3d" stop-opacity="0.55"/>
      <stop offset="65%" stop-color="#ff8a3d" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="grad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"  stop-color="#1ee49a"/>
      <stop offset="100%" stop-color="#ff8a3d"/>
    </linearGradient>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="2"/>
    </filter>
  </defs>

  <!-- background -->
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#glow1)"/>
  <rect width="100%" height="100%" fill="url(#glow2)"/>

  <!-- top brand pill -->
  <g transform="translate(540, 200)" text-anchor="middle"
     font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
     fill="#ffffff">
    <rect x="-220" y="-46" width="440" height="72" rx="36" ry="36"
          fill="#000000" fill-opacity="0.5" stroke="#1ee49a" stroke-opacity="0.55" stroke-width="2"/>
    <circle cx="-184" cy="-10" r="9" fill="#1ee49a"/>
    <text x="-160" y="0" font-size="30" font-weight="600" letter-spacing="2"
          fill="#e7faf1" dominant-baseline="middle" text-anchor="start">
      AURORA  PULSE
    </text>
    <circle cx="64" cy="-10" r="6" fill="#ffffff" fill-opacity="0.5"/>
    <text x="84" y="0" font-size="30" font-weight="600" letter-spacing="2"
          fill="#ffd5b3" dominant-baseline="middle" text-anchor="start">
      VIBE
    </text>
  </g>

  <!-- main headline -->
  <g transform="translate(540, 480)" text-anchor="middle"
     font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
     fill="#ffffff">
    <text y="0"   font-size="92" font-weight="800" letter-spacing="-2">The website</text>
    <text y="110" font-size="92" font-weight="800" letter-spacing="-2">
      is <tspan fill="url(#grad)">live</tspan>.
    </text>
  </g>

  <!-- divider -->
  <rect x="380" y="700" width="320" height="3" rx="2" ry="2" fill="url(#grad)"/>

  <!-- subline -->
  <g transform="translate(540, 760)" text-anchor="middle"
     font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
     fill="#cdd9e8">
    <text y="0"  font-size="38" font-weight="500" opacity="0.95">Aurora Pulse · Desktop</text>
    <text y="60" font-size="38" font-weight="500" opacity="0.95">Vibe · Music &amp; Podcast Launcher</text>
  </g>

  <!-- url badge -->
  <g transform="translate(540, 980)" text-anchor="middle"
     font-family="ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace"
     fill="#ffffff">
    <rect x="-380" y="-50" width="760" height="100" rx="50" ry="50"
          fill="#000000" fill-opacity="0.6"
          stroke="url(#grad)" stroke-width="3"/>
    <text y="14" font-size="38" font-weight="700" letter-spacing="1">galdo.github.io/aurora</text>
  </g>

  <!-- footer tag -->
  <g transform="translate(540, 1200)" text-anchor="middle"
     font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
     fill="#7e8aa0">
    <text y="0"  font-size="26" font-weight="500" letter-spacing="3">LOCAL-FIRST · AUDIOPHILE · MULTI-PLATFORM</text>
    <text y="50" font-size="22" font-weight="400" opacity="0.7">macOS · Windows · Linux · Android</text>
  </g>
</svg>
`;

(async () => {
  const out = path.resolve(__dirname, '..', 'docs', 'news.png');
  await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toFile(out);
  const size = fs.statSync(out).size;
  console.log(`[ok] ${out} (${(size / 1024).toFixed(1)} KB)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});