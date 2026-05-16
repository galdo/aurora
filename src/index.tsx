import React from 'react';
import { createRoot } from 'react-dom/client';
import Promise from 'bluebird';
import log from 'electron-log/renderer';

import './index.global.css';
import { App } from './app/app.component';

// ---------------------------------------------------------------------------
// Renderer startup performance marks (#12)
// Mirrors the lightweight marker scheme from main.ts so we can correlate
// timings across both processes. Output: `[STARTUP_MARK_RENDERER] +<ms> <label>`.
// ---------------------------------------------------------------------------
const startupMarksT0 = Date.now();
const startupMarksEnabled = process.env.AURORA_STARTUP_MARKS !== '0';
function startupMark(label: string, extra?: Record<string, any>) {
  if (!startupMarksEnabled) return;
  const elapsedMs = Date.now() - startupMarksT0;
  // eslint-disable-next-line no-console
  console.log(`[STARTUP_MARK_RENDERER] +${elapsedMs}ms ${label}${extra ? ` ${JSON.stringify(extra)}` : ''}`);
}
// Expose globally so other modules (services, app component) can mark too.
(window as any).auroraStartupMark = startupMark;
startupMark('renderer_module_loaded');

const isDebug = process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';
const isProd = process.env.NODE_ENV === 'production';

if (isDebug) {
  // to enable stack traces in promises
  Promise.config({
    longStackTraces: true,
    warnings: true,
    cancellation: true,
    monitoring: true,
  });
}

// @ts-ignore
global.Promise = Promise;

// configure logging for prod
if (isProd) {
  Object.assign(console, log.functions);
}

const container = document.getElementById('root');

const root = createRoot(container!);
root.render(<App/>);

// console.log generally not allowed, but this one is important
// eslint-disable-next-line no-console
console.log('[RENDERER_INIT] - %o', {
  env: process.env.NODE_ENV,
  debug: isDebug,
  prod: isProd,
  version: process.env.APP_VERSION,
  build: process.env.BUILD_VERSION,
  platform: navigator.platform,
  time: new Date().toISOString(),
});
