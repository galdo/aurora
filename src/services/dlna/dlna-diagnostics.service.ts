/**
 * In-app DLNA diagnostics aggregator (P3-1).
 *
 * Exposes a tiny, stable API the React/Settings layer can call without having
 * to read `dlna.log` or poke into DlnaService internals. Three responsibilities:
 *
 *   1. **Snapshot health & capabilities** — combines `DlnaService.getState()`
 *      with `DlnaRendererCapabilityCache.snapshot()` and the latest
 *      `media_server_self_test_*` event from `dlna.log`.
 *   2. **Tail dlna.log** — provides a synchronous + a streaming API that reads
 *      the last N lines from disk via `DlnaService.getDlnaLogPath()` (works
 *      from the renderer process — no IPC bridge needed because the path is
 *      a regular file on the local FS). The stream uses `fs.watch` to push
 *      new entries as they're appended.
 *   3. **Diagnostics bundle** — single `buildBundle()` call returns a
 *      pretty-printed JSON string that the user can paste into a bug report.
 *
 * The service is intentionally renderer-process-friendly: it never imports
 * Electron's IPC, so unit tests that don't have a `BrowserWindow` can call
 * `getSnapshot()` and `buildBundle()` directly.
 */

import fs from 'fs';
import { Buffer } from 'buffer';
import type { FSWatcher } from 'fs';
import { DlnaService, DlnaState } from '../dlna.service';
import { DlnaRendererCapabilityCache, DlnaRendererCapabilityRecord } from './dlna-renderer-capability-cache';
import { DlnaPairingService } from './dlna-pairing.service';

export type DlnaLogEntry = {
  timestamp?: string;
  level?: 'info' | 'warn' | 'error';
  event?: string;
  outputMode?: 'local' | 'remote';
  selectedRendererId?: string;
  details?: Record<string, any>;
  raw: string;
};

export type DlnaDiagnosticsSnapshot = {
  /** Direct mirror of `DlnaService.getState()`. */
  state: DlnaState;
  /** All cached capability records (P3-2). */
  capabilities: Array<{ udn: string } & DlnaRendererCapabilityRecord>;
  /** Last self-test result from dlna.log, or `undefined` if Aurora is too young. */
  lastSelfTest?: {
    ok: boolean;
    timestamp?: string;
    details?: Record<string, any>;
  };
  /** Renderers that Aurora has paired with (HMAC token cached locally). */
  pairedRendererIds: string[];
  /** Wall-clock timestamp when this snapshot was captured. */
  capturedAt: number;
};

export type DlnaLogTailHandle = {
  dispose: () => void;
};

const SELF_TEST_OK_EVENT = 'media_server_self_test_ok';
const SELF_TEST_FAILED_EVENT = 'media_server_self_test_failed';

function safeParseLogLine(rawLine: string): DlnaLogEntry | undefined {
  const trimmed = rawLine.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Partial<DlnaLogEntry>;
    return {
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
      level: parsed.level === 'warn' || parsed.level === 'error' ? parsed.level : 'info',
      event: typeof parsed.event === 'string' ? parsed.event : undefined,
      outputMode: parsed.outputMode === 'remote' ? 'remote' : 'local',
      selectedRendererId: typeof parsed.selectedRendererId === 'string' ? parsed.selectedRendererId : undefined,
      details: typeof parsed.details === 'object' && parsed.details ? parsed.details as Record<string, any> : undefined,
      raw: trimmed,
    };
  } catch (_error) {
    // dlna.log is JSON-per-line, but a partial flush could still leave a half-written
    // last line. Surface it raw so the diagnostics view can still show context.
    return { raw: trimmed };
  }
}

export class DlnaDiagnosticsService {
  /**
   * Read the last `maxLines` parsed JSON entries from dlna.log. Returns an
   * empty array when no log path is known (e.g. running outside Aurora) or
   * when the file does not yet exist.
   */
  static readRecentLog(maxLines = 200): DlnaLogEntry[] {
    const logPath = (DlnaService as any).getDlnaLogPath?.() as string | undefined;
    if (!logPath) return [];
    if (!fs.existsSync(logPath)) return [];
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(logPath);
    } catch (_error) {
      return [];
    }
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    const tail = lines.slice(-Math.max(1, maxLines));
    const entries: DlnaLogEntry[] = [];
    tail.forEach((line) => {
      const entry = safeParseLogLine(line);
      if (entry) entries.push(entry);
    });
    return entries;
  }

  /**
   * Find the most recent `media_server_self_test_*` event so the panel can
   * render a green/red banner without requiring a fresh self-test run.
   */
  static lastSelfTest(): DlnaDiagnosticsSnapshot['lastSelfTest'] | undefined {
    const entries = this.readRecentLog(500);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry.event === SELF_TEST_OK_EVENT) {
        return { ok: true, timestamp: entry.timestamp, details: entry.details };
      }
      if (entry.event === SELF_TEST_FAILED_EVENT) {
        return { ok: false, timestamp: entry.timestamp, details: entry.details };
      }
    }
    return undefined;
  }

  /** Compose all the diagnostic bits the UI needs into one snapshot. */
  static getSnapshot(): DlnaDiagnosticsSnapshot {
    const state = DlnaService.getState();
    const capabilities = DlnaRendererCapabilityCache.snapshot();
    const pairedRendererIds = capabilities
      .map(record => record.udn)
      .filter(udn => DlnaPairingService.hasToken(udn));
    return {
      state,
      capabilities,
      lastSelfTest: this.lastSelfTest(),
      pairedRendererIds,
      capturedAt: Date.now(),
    };
  }

  /**
   * Pretty-print a diagnostics bundle for issue reports. Includes the snapshot
   * + a tail of the log. Sensitive values (HMAC tokens) are NEVER serialized
   * — `pairedRendererIds` is just a list of UDNs.
   */
  static buildBundle(maxLogLines = 200): string {
    const snapshot = this.getSnapshot();
    const recentLog = this.readRecentLog(maxLogLines);
    return JSON.stringify({
      generatedAt: new Date().toISOString(),
      version: '1.3',
      snapshot,
      recentLog,
    }, null, 2);
  }

  /**
   * Stream new lines as they're appended to dlna.log. The optional filter
   * receives the parsed entry and may return `false` to skip the call to
   * `onEntry`. Returns a handle whose `.dispose()` stops watching.
   */
  static tailLog(args: {
    onEntry: (entry: DlnaLogEntry) => void;
    filter?: (entry: DlnaLogEntry) => boolean;
    initialMaxLines?: number;
  }): DlnaLogTailHandle {
    const logPath = (DlnaService as any).getDlnaLogPath?.() as string | undefined;
    if (!logPath) {
      return { dispose: () => undefined };
    }
    // Replay the existing tail synchronously so the UI can render immediately.
    const initial = this.readRecentLog(args.initialMaxLines || 200);
    initial.forEach((entry) => {
      if (!args.filter || args.filter(entry)) args.onEntry(entry);
    });
    let watcher: FSWatcher | undefined;
    let lastSize = 0;
    try {
      lastSize = fs.statSync(logPath).size;
    } catch (_error) {
      lastSize = 0;
    }
    let pendingChunk = '';
    try {
      watcher = fs.watch(logPath, { persistent: false }, () => {
        try {
          const { size } = fs.statSync(logPath);
          if (size <= lastSize) {
            // File was truncated/rotated — restart from the beginning.
            lastSize = 0;
            pendingChunk = '';
            return;
          }
          const fd = fs.openSync(logPath, 'r');
          const length = size - lastSize;
          const buffer = Buffer.alloc(length);
          fs.readSync(fd, buffer, 0, length, lastSize);
          fs.closeSync(fd);
          lastSize = size;
          const text = pendingChunk + buffer.toString('utf8');
          const lines = text.split('\n');
          // Keep the last (potentially incomplete) line in `pendingChunk`.
          pendingChunk = lines.pop() ?? '';
          lines.forEach((line) => {
            const entry = safeParseLogLine(line);
            if (!entry) return;
            if (args.filter && !args.filter(entry)) return;
            args.onEntry(entry);
          });
        } catch (_error) {
          // Watcher fires on a wide range of FS events; transient read errors
          // (e.g. truncation race) are safe to ignore.
        }
      });
    } catch (_error) {
      // fs.watch isn't supported on every FS (NFS, Docker mounts) — fall back
      // to a no-op handle so the panel still shows the initial replay.
      return { dispose: () => undefined };
    }
    return {
      dispose: () => {
        try { watcher?.close(); } catch (_error) { /* ignored */ }
      },
    };
  }
}
