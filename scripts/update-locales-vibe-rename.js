#!/usr/bin/env node
/* eslint-disable no-console */
// Renames "Aurora Pulse Launcher" → "Vibe – Music & Podcast Launcher" in all
// locale files and adds the new `link_open_play_store` key.
const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.resolve(__dirname, '..', 'assets', 'locales');

const NAME_OLD = 'Aurora Pulse Launcher';
const NAME_NEW = 'Vibe – Music & Podcast Launcher';

// Per-locale "Open in Play Store" translations.
const PLAY_STORE_LINKS = {
  de: 'Im Google Play Store öffnen',
  en: 'Open in Google Play Store',
  fr: 'Ouvrir dans le Google Play Store',
  it: 'Apri nel Google Play Store',
  es: 'Abrir en Google Play Store',
  pt: 'Abrir na Google Play Store',
  pl: 'Otwórz w Google Play Store',
  tr: 'Google Play Store\'da aç',
  ru: 'Открыть в Google Play',
  zh: '在 Google Play 商店中打开',
  ja: 'Google Play ストアで開く',
  hi: 'Google Play Store में खोलें',
};

const locales = fs.readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json'));
locales.forEach((file) => {
  const code = file.replace('.json', '');
  const filePath = path.join(LOCALES_DIR, file);
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  // Rename launcher name across the launcher copy.
  Object.keys(json).forEach((key) => {
    if (typeof json[key] === 'string' && json[key].includes(NAME_OLD)) {
      json[key] = json[key].split(NAME_OLD).join(NAME_NEW);
    }
  });

  // Add Play Store link label.
  json.link_open_play_store = PLAY_STORE_LINKS[code] || PLAY_STORE_LINKS.en;

  fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n', 'utf8');
  console.log(`[ok] ${code} updated`);
});