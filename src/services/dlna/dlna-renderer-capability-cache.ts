/**
 * Per-renderer capability matrix (P3-2).
 *
 * Persists what we have learned about each renderer (by stable UDN) so the
 * controller doesn't have to re-discover them on every Aurora launch. The
 * cache complements — but does NOT replace — the existing live-runtime maps in
 * DlnaService:
 *   • rendererQueueContextSupportedByRendererId      (X_SetPlaylist support)
 *   • preferredTransportMetadataModeByRendererId     (full/compatibility/empty)
 *   • rendererMuteControlUnsupportedIds              (RenderingControl mute)
 *
 * Storage backend: localStorage in the Electron renderer process. Records are
 * keyed by UDN (stable across IP/port changes — Eversolo randomizes ports per
 * reboot, so IP/port-keyed caches would invalidate themselves).
 *
 * Schema versioning: the persisted JSON has a `schemaVersion` field. On
 * version mismatch the cache is dropped silently — readers always fall back to
 * "unknown" capability values, which makes upgrades safe.
 */

export type DlnaRendererMetadataMode = 'full' | 'compatibility' | 'empty';

export type DlnaRendererCapabilityRecord = {
  /** Last `friendlyName` we saw — purely informational, for logs/UI. */
  lastFriendlyName?: string;
  /** Last `modelName` we saw — purely informational, for logs/UI. */
  lastModelName?: string;
  /** Did description.xml include `<X_AuroraPulseLauncher>`? (P2-6) */
  hasAuroraTag?: boolean;
  /** Does the renderer accept HTTP Range on /stream? (Eversolo OP=01 needs it.) */
  supportsRange?: boolean;
  /** Does SetNextAVTransportURI take effect (vs. accepted-but-NO-OP)? (P2-1) */
  supportsSetNext?: boolean;
  /** Does the renderer accept Aurora's X_SetPlaylist extension? */
  supportsXSetPlaylist?: boolean;
  /** Last metadata mode that worked for SetAVTransportURI on this renderer. */
  preferredMetadataMode?: DlnaRendererMetadataMode;
  /** Has GetMute / SetMute returned HTTP 500/501 here? */
  muteControlUnsupported?: boolean;
  /** Last successful HTTP description.xml URL — useful for cross-reboot recovery. */
  lastDescriptionUrl?: string;
  /** Hash of the last fetched description.xml — invalidate downstream caches on change. */
  lastDescriptionHash?: string;
  /** Unix ms — when this record was last updated. */
  updatedAt: number;
};

const STORAGE_KEY = 'aurora:dlna-renderer-capabilities';
const SCHEMA_VERSION = 1;

type PersistedShape = {
  schemaVersion: number;
  records: Record<string, DlnaRendererCapabilityRecord>;
};

/**
 * Returns true when running inside a window with localStorage (Electron renderer).
 * In the main-process context (no DOM) the cache becomes a memory-only no-op.
 */
function hasLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export class DlnaRendererCapabilityCache {
  private static readonly memoryFallback: Map<string, DlnaRendererCapabilityRecord> = new Map();

  private static loadAll(): Record<string, DlnaRendererCapabilityRecord> {
    if (!hasLocalStorage()) {
      const out: Record<string, DlnaRendererCapabilityRecord> = {};
      this.memoryFallback.forEach((value, key) => {
        out[key] = value;
      });
      return out;
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as PersistedShape;
      if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) {
        return {};
      }
      return parsed.records || {};
    } catch (_error) {
      return {};
    }
  }

  private static persistAll(records: Record<string, DlnaRendererCapabilityRecord>): void {
    if (!hasLocalStorage()) {
      this.memoryFallback.clear();
      Object.entries(records).forEach(([key, value]) => {
        this.memoryFallback.set(key, value);
      });
      return;
    }
    try {
      const payload: PersistedShape = {
        schemaVersion: SCHEMA_VERSION,
        records,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_error) {
      // QuotaExceeded or serialization issue — degrade silently.
    }
  }

  private static normalizeUdn(rendererIdOrUdn: string): string {
    return String(rendererIdOrUdn || '').trim().replace(/^uuid:/i, '');
  }

  /** Read the full record for a renderer, or `undefined` if we have nothing cached. */
  static get(rendererIdOrUdn: string): DlnaRendererCapabilityRecord | undefined {
    const key = this.normalizeUdn(rendererIdOrUdn);
    if (!key) return undefined;
    const all = this.loadAll();
    return all[key];
  }

  /** Merge `patch` into the existing record (or create a new one). */
  static update(rendererIdOrUdn: string, patch: Partial<DlnaRendererCapabilityRecord>): void {
    const key = this.normalizeUdn(rendererIdOrUdn);
    if (!key) return;
    const all = this.loadAll();
    const existing = all[key] || { updatedAt: Date.now() };
    all[key] = {
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    };
    this.persistAll(all);
  }

  /** Drop the record for a single renderer (e.g. user removed it from the list). */
  static forget(rendererIdOrUdn: string): void {
    const key = this.normalizeUdn(rendererIdOrUdn);
    if (!key) return;
    const all = this.loadAll();
    if (all[key]) {
      delete all[key];
      this.persistAll(all);
    }
  }

  /** Drop everything — useful for the in-app diagnostics "Reset" button. */
  static clearAll(): void {
    this.persistAll({});
  }

  /** Snapshot of the entire matrix — used by the diagnostics panel. */
  static snapshot(): Array<{ udn: string } & DlnaRendererCapabilityRecord> {
    const all = this.loadAll();
    return Object.entries(all).map(([udn, record]) => ({ udn, ...record }));
  }
}
