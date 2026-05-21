#!/usr/bin/env node
/* eslint-disable no-console */
// Updates locale files: removes deprecated settings_info_* keys, adds new ones.
// For non-DE/EN locales, English copy is used as a temporary fallback.
const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.resolve(__dirname, '..', 'assets', 'locales');

const DEPRECATED = ['settings_info_fork_title','settings_info_fork_desc_1','settings_info_fork_desc_2','settings_info_fork_desc_3','settings_info_feature_list_title','settings_info_feature_cd_import','settings_info_feature_album_sorting','settings_info_feature_podcasts','settings_info_feature_playlists','settings_info_feature_dap_sync','settings_info_feature_multilanguage','settings_info_feature_equalizer','settings_info_feature_ui','settings_info_ai_title','settings_info_ai_desc','settings_info_ai_source_trae','settings_info_ai_source_gpt_codex','settings_info_ai_source_gemini_pro'];

const EN = require('./locale-data/en.js');
const PER_LOCALE = require('./locale-data/per-locale.js');

const locales = fs.readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json'));
locales.forEach((file) => {
  const code = file.replace('.json','');
  if (code === 'de') {
    console.log(`[skip] ${code} (already updated manually)`);
    return;
  }
  const filePath = path.join(LOCALES_DIR, file);
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  DEPRECATED.forEach((k) => { delete json[k]; });
  const translations = Object.assign({}, EN, PER_LOCALE[code] || {});
  Object.keys(translations).forEach((k) => {
    json[k] = translations[k];
  });
  fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n', 'utf8');
  console.log(`[ok] ${code} updated (${Object.keys(translations).length} keys)`);
});