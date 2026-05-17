/**
 * P2-5 Aurora-side pairing service unit tests.
 *
 * Covers the parts that don't need a real renderer:
 *   • token persistence + retrieval
 *   • HMAC body signing matches the Vibe-side verification
 *   • forget / clearAll behaviour
 *
 * The actual SOAP X_PairWithAurora call is mocked via a global fetch stub.
 */

import crypto from 'crypto';
import { DlnaPairingService } from '../dlna/dlna-pairing.service';

describe('DlnaPairingService', () => {
  beforeEach(() => {
    DlnaPairingService.clearAll();
  });

  it('returns no token before pairing', () => {
    expect(DlnaPairingService.hasToken('uuid:abc')).toBe(false);
    expect(DlnaPairingService.getToken('uuid:abc')).toBeUndefined();
    expect(DlnaPairingService.signBody('uuid:abc', '{}')).toBeUndefined();
  });

  it('signs body with HMAC-SHA256 in `sha256=<hex>` form once paired', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 } as any);
    (globalThis as any).fetch = fetchMock;

    const token = await DlnaPairingService.pairWithRenderer({
      rendererId: 'uuid:test-renderer',
      avTransportControlUrl: 'http://192.0.2.10:1234/AVTransport/control.xml',
      avTransportServiceType: 'urn:schemas-upnp-org:service:AVTransport:1',
    });

    expect(typeof token).toBe('string');
    expect(token).toHaveLength(64); // 32 bytes hex
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(DlnaPairingService.hasToken('uuid:test-renderer')).toBe(true);
    expect(DlnaPairingService.hasToken('test-renderer')).toBe(true); // normalized

    const body = '{"hello":"world"}';
    const signature = DlnaPairingService.signBody('uuid:test-renderer', body);
    expect(signature).toBeDefined();
    expect(signature?.startsWith('sha256=')).toBe(true);

    // Independently compute the expected MAC (mirrors the Vibe verifier).
    const expected = crypto.createHmac('sha256', Buffer.from(token, 'utf8')).update(body, 'utf8').digest('hex');
    expect(signature).toBe(`sha256=${expected}`);
  });

  it('drops the cached token on forget()', async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 } as any);
    await DlnaPairingService.pairWithRenderer({
      rendererId: 'uuid:r1',
      avTransportControlUrl: 'http://x/y',
      avTransportServiceType: 'urn:schemas-upnp-org:service:AVTransport:1',
    });
    expect(DlnaPairingService.hasToken('r1')).toBe(true);
    DlnaPairingService.forgetToken('r1');
    expect(DlnaPairingService.hasToken('r1')).toBe(false);
    expect(DlnaPairingService.signBody('r1', 'x')).toBeUndefined();
  });

  it('still records the token locally if the renderer replies with HTTP 500', async () => {
    // Some Vibe builds reply 500 to unknown SOAP actions; the helper still
    // stores the token locally so the next /aurora/queue can attempt a
    // signed request, prompting the user to re-pair if the renderer truly
    // doesn't accept the token.
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 } as any);
    const token = await DlnaPairingService.pairWithRenderer({
      rendererId: 'uuid:legacy',
      avTransportControlUrl: 'http://x/y',
      avTransportServiceType: 'urn:schemas-upnp-org:service:AVTransport:1',
    });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(DlnaPairingService.hasToken('legacy')).toBe(true);
  });
});
