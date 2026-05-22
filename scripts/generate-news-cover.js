#!/usr/bin/env node
/* eslint-disable no-console */
// Generates docs/news.png — a portrait cover (1080x1350) for the
// "Aurora Pulse Website is live" news post.
//
// Design notes (revision 2):
// - Strong, green-only palette derived from Aurora Green #1ee49a:
//     deep:    #001b14
//     mid:     #073527
//     base:    #0e8a5b
//     primary: #1ee49a
//     soft:    #6ff5c2
//     mint:    #b3fbe1
// - "AURORA PULSE" and "Vibe" are stacked on two separate lines
//   (one above the other) so they no longer overlap visually, with
//   their own colored dot markers.
// - Headline + URL pill stay in green tones, no orange.
const path = require('path');
const fs = require('fs');

const sharpPath = path.resolve(__dirname, '..', 'src', 'node_modules', 'sharp');
const sharp = require(sharpPath);

const W = 1080;
const H = 1350;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <!-- Background: deep emerald → near-black, all green family -->
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0%"   stop-color="#001b14"/>
      <stop offset="55%"  stop-color="#03241a"/>
      <stop offset="100%" stop-color="#000604"/>
    </linearGradient>

    <!-- Two green glows in different shades, both centered toward the
         top-left and bottom-right to add depth without leaving the
         green family. -->
    <radialGradient id="glow1" cx="22%" cy="20%" r="60%">
      <stop offset="0%"  stop-color="#1ee49a" stop-opacity="0.55"/>
      <stop offset="55%" stop-color="#1ee49a" stop-opacity="0.0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="80%" cy="82%" r="55%">
      <stop offset="0%"  stop-color="#0e8a5b" stop-opacity="0.55"/>
      <stop offset="60%" stop-color="#0e8a5b" stop-opacity="0.0"/>
    </radialGradient>
    <radialGradient id="glow3" cx="50%" cy="60%" r="40%">
      <stop offset="0%"  stop-color="#6ff5c2" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#6ff5c2" stop-opacity="0"/>
    </radialGradient>

    <!-- Headline gradient — only green tones (mint → primary → deep) -->
    <linearGradient id="grad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#b3fbe1"/>
      <stop offset="50%"  stop-color="#1ee49a"/>
      <stop offset="100%" stop-color="#0e8a5b"/>
    </linearGradient>

    <!-- Pill border gradient -->
    <linearGradient id="grad2" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#1ee49a"/>
      <stop offset="100%" stop-color="#6ff5c2"/>
    </linearGradient>
  </defs>

  <!-- Background stack -->
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#glow1)"/>
  <rect width="100%" height="100%" fill="url(#glow2)"/>
  <rect width="100%" height="100%" fill="url(#glow3)"/>

  <!-- Subtle 1px green grid hint at the very edge to feel "audio
       interface"-ish without being noisy -->
  <rect x="40" y="40" width="${W - 80}" height="${H - 80}" rx="32" ry="32"
        fill="none" stroke="#1ee49a" stroke-opacity="0.12" stroke-width="1.5"/>

  <!-- Top brand block: TWO STACKED LINES (so they don't collide) -->
  <g transform="translate(540, 175)" text-anchor="middle"
     font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
     fill="#e7faf1">

    <!-- Frame around both rows -->
    <rect x="-300" y="-60" width="600" height="170" rx="28" ry="28"
          fill="#001b14" fill-opacity="0.55"
          stroke="#1ee49a" stroke-opacity="0.55" stroke-width="2"/>

    <!-- Row 1: AURORA PULSE -->
    <g transform="translate(0, 0)">
      <circle cx="-150" cy="-2" r="9" fill="#1ee49a"/>
      <text x="-130" y="0" font-size="34" font-weight="700" letter-spacing="3"
            fill="#e7faf1" dominant-baseline="middle" text-anchor="start">
        AURORA  PULSE
      </text>
    </g>

    <!-- Row 2: VIBE — Music & Podcast Launcher -->
    <g transform="translate(0, 70)">
      <circle cx="-260" cy="-2" r="7" fill="#6ff5c2"/>
      <text x="-242" y="0" font-size="26" font-weight="500" letter-spacing="3"
            fill="#b3fbe1" dominant-baseline="middle" text-anchor="start">
        VIBE  ·  MUSIC  &amp;  PODCAST  LAUNCHER
      </text>
    </g>
  </g>

  <!-- Main headline -->
  <g transform="translate(540, 510)" text-anchor="middle"
     font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
     fill="#ffffff">
    <text y="0"   font-size="92" font-weight="800" letter-spacing="-2">The website</text>
    <text y="110" font-size="92" font-weight="800" letter-spacing="-2">
      is <tspan fill="url(#grad)">live</tspan>.
    </text>
  </g>

  <!-- Divider -->
  <rect x="380" y="730" width="320" height="3" rx="2" ry="2" fill="url(#grad)"/>

  <!-- Subline -->
  <g transform="translate(540, 790)" text-anchor="middle"
     font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
     fill="#cdf3e2">
    <text y="0"  font-size="38" font-weight="500" opacity="0.95">One library · Two surfaces</text>
    <text y="60" font-size="38" font-weight="500" opacity="0.95">Desktop &amp; Android. Zero lock-in.</text>
  </g>

  <!-- URL pill -->
  <g transform="translate(540, 1010)" text-anchor="middle"
     font-family="ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace"
     fill="#e7faf1">
    <rect x="-380" y="-50" width="760" height="100" rx="50" ry="50"
          fill="#001b14" fill-opacity="0.65"
          stroke="url(#grad2)" stroke-width="3"/>
    <text y="14" font-size="38" font-weight="700" letter-spacing="1">galdo.github.io/aurora</text>
  </g>

  <!-- Footer tag -->
  <g transform="translate(540, 1220)" text-anchor="middle"
     font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
     fill="#7ad9b3">
    <text y="0"  font-size="26" font-weight="600" letter-spacing="3">LOCAL-FIRST · AUDIOPHILE · MULTI-PLATFORM</text>
    <text y="50" font-size="22" font-weight="400" opacity="0.75">macOS · Windows · Linux · Android</text>
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