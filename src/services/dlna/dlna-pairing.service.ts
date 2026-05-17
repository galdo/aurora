/**
 * Aurora Pulse <-> Vibe Launcher pairing token service (P2-5, Aurora side).
 *
 * Implements the Aurora half of the HMAC-signed `/aurora/queue` protocol:
 *  • Generates / persists a 32-byte random secret per renderer (UDN-keyed).
 *  • Sends a custom `X_PairWithAurora` SOAP action to AVTransport, which the
 *    Vibe Launcher catches and stores as its `pairingTokenSecret`.
 *  • Signs every subsequent JSON body sent to `POST /aurora/queue` with
 *    HMAC-SHA256 and attaches `X-Aurora-Signature: sha256=<hex>`.
 *
 * Storage: `localStorage[aurora:dlna-pairing-tokens]`. The cache is keyed by
 * the renderer's UDN (stable across IP/port changes — see also
 * `DlnaRendererCapabilityCache`).
 *
 * Security model:
 *  • Token is only ever exchanged over the LAN (UPnP/SOAP).
 *  • The Vibe side accepts unsigned requests when its `pairingTokenSecret`
 *    is empty (backward compat). Aurora therefore SHOULD pair before issuing
 *    any sensitive control on a multi-user network, but doesn't have to for
 *    home-use single-renderer setups.
 *  • HMAC-SHA256 is used in constant-time compare on the renderer side.
 *  • Tokens are never logged.
 */

import crypto from 'crypto';

const STORAGE_KEY = 'aurora:dlna-pairing-tokens';
const SCHEMA_VERSION = 1;

type PersistedShape = {
  schemaVersion: number;
  /** Map: udn -> token (hex) */
  tokens: Record<string, string>;
};

function hasLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function normalizeUdn(rendererIdOrUdn: string): string {
  return String(rendererIdOrUdn || '').trim().replace(/^uuid:/i, '');
}

export class DlnaPairingService {
  /** In-memory mirror so we never re-parse localStorage on the hot path. */
  private static readonly memoryTokens: Map<string, string> = new Map();
  private static loaded = false;

  private static loadAll(): Record<string, string> {
    if (this.loaded) {
      const out: Record<string, string> = {};
      this.memoryTokens.forEach((v, k) => { out[k] = v; });
      return out;
    }
    let parsed: PersistedShape | undefined;
    if (hasLocalStorage()) {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) parsed = JSON.parse(raw) as PersistedShape;
      } catch (_error) {
        parsed = undefined;
      }
    }
    if (parsed && parsed.schemaVersion === SCHEMA_VERSION && parsed.tokens) {
      Object.entries(parsed.tokens).forEach(([k, v]) => this.memoryTokens.set(k, v));
    }
    this.loaded = true;
    const out: Record<string, string> = {};
    this.memoryTokens.forEach((v, k) => { out[k] = v; });
    return out;
  }

  private static persistAll(): void {
    if (!hasLocalStorage()) return;
    const tokens: Record<string, string> = {};
    this.memoryTokens.forEach((v, k) => { tokens[k] = v; });
    try {
      const payload: PersistedShape = { schemaVersion: SCHEMA_VERSION, tokens };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_error) {
      // QuotaExceeded — degrade silently, in-memory cache still works for the session.
    }
  }

  /** True if Aurora has a token cached for this renderer. */
  static hasToken(rendererIdOrUdn: string): boolean {
    this.loadAll();
    return !!this.memoryTokens.get(normalizeUdn(rendererIdOrUdn));
  }

  /** Return the cached hex token (or `undefined`). */
  static getToken(rendererIdOrUdn: string): string | undefined {
    this.loadAll();
    return this.memoryTokens.get(normalizeUdn(rendererIdOrUdn));
  }

  /**
   * Generate a fresh 32-byte random token, persist it locally, AND push it to
   * the renderer via the custom `X_PairWithAurora` SOAP action. Returns the
   * new token on success, throws on transport error.
   */
  static async pairWithRenderer(args: {
    rendererId: string;
    avTransportControlUrl: string;
    avTransportServiceType: string;
    timeoutMs?: number;
  }): Promise<string> {
    const udn = normalizeUdn(args.rendererId);
    if (!udn) throw new Error('rendererId required');
    const token = crypto.randomBytes(32).toString('hex');
    await this.sendPairingSoap(args.avTransportControlUrl, args.avTransportServiceType, token, args.timeoutMs);
    this.loadAll();
    this.memoryTokens.set(udn, token);
    this.persistAll();
    return token;
  }

  /** Drop the local token (e.g. user "unpair" button). Does NOT notify renderer. */
  static forgetToken(rendererIdOrUdn: string): void {
    this.loadAll();
    if (this.memoryTokens.delete(normalizeUdn(rendererIdOrUdn))) {
      this.persistAll();
    }
  }

  /** Drop all tokens — for "Reset DLNA pairings" in the diagnostics panel. */
  static clearAll(): void {
    this.memoryTokens.clear();
    this.persistAll();
  }

  /**
   * Compute the `X-Aurora-Signature: sha256=<hex>` header value for a given
   * body string and renderer UDN. Returns `undefined` when no token is paired
   * — callers should still send the request (Vibe accepts unsigned when its
   * pairingTokenSecret is empty).
   */
  static signBody(rendererIdOrUdn: string, body: string): string | undefined {
    const token = this.getToken(rendererIdOrUdn);
    if (!token) return undefined;
    const mac = crypto.createHmac('sha256', Buffer.from(token, 'utf8'));
    mac.update(body, 'utf8');
    return `sha256=${mac.digest('hex')}`;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internal: build & send the X_PairWithAurora SOAP envelope.
  //
  // The Vibe side parses any SOAPAction whose suffix is `#X_PairWithAurora`
  // (case-insensitive) and extracts a single `<Token>...</Token>` arg. The
  // matching parser code lives in DlnaRenderer.kt as a placeholder; the wire
  // contract is intentionally tiny so other clients can use it too.
  // ────────────────────────────────────────────────────────────────────────
  private static async sendPairingSoap(
    controlUrl: string,
    serviceType: string,
    tokenHex: string,
    timeoutMs = 7000,
  ): Promise<void> {
    const escapedToken = tokenHex.replace(/[<>&]/g, ''); // hex chars only — defensive
    const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:X_PairWithAurora xmlns:u="${serviceType}">
<InstanceID>0</InstanceID>
<Token>${escapedToken}</Token>
</u:X_PairWithAurora>
</s:Body>
</s:Envelope>`;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(controlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPACTION: `"${serviceType}#X_PairWithAurora"`,
        },
        body,
        signal: controller.signal,
      });
      // Some Vibe builds reply 500 because they don't yet accept the action; we
      // still record the local token — the next SOAP action will then fail
      // verification, prompting the user to re-pair.
      if (!response.ok && response.status !== 500) {
        throw new Error(`X_PairWithAurora SOAP failed with HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
