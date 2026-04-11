/* eslint-disable import/first -- jest.mock must run before importing the module under test */
jest.mock('sharp', () => jest.fn());
jest.mock('../../datastores', () => ({
  MediaAlbumDatastore: {},
  MediaArtistDatastore: {},
  MediaTrackDatastore: {},
}));
jest.mock('../media-album.service', () => ({ MediaAlbumService: {} }));
jest.mock('../app.service', () => ({ AppService: {} }));
jest.mock('../media-artist.service', () => ({ MediaArtistService: {}, ArtistViewMode: 'artists' }));
jest.mock('../media-liked-track.service', () => ({ MediaLikedTrackService: {} }));
jest.mock('../podcast.service', () => ({ PodcastService: {} }));
jest.mock('../dlna-control-stack.service', () => ({ DlnaControlStackService: {} }));

import { DlnaService } from '../dlna.service';

describe('DLNA GENA SUBSCRIBE recovery', () => {
  beforeAll(() => {
    (global as unknown as { window: { dispatchEvent: () => void } }).window = {
      dispatchEvent: jest.fn(),
    };
  });

  beforeEach(() => {
    jest.resetAllMocks();
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn();
    (DlnaService as unknown as { httpServer: object }).httpServer = {};
    (DlnaService as unknown as { port: number }).port = 42809;
  });

  test('HTTP 412 on renew clears SID and succeeds on fresh SUBSCRIBE', async () => {
    const renderer = {
      id: 'r1',
      location: 'http://192.168.1.10:49152/description.xml',
      friendlyName: 'Test',
      avTransportControlUrl: 'http://192.168.1.10/ctl',
      avTransportEventUrl: 'http://192.168.1.10/event/AVTransport',
      avTransportServiceType: 'urn:schemas-upnp-org:service:AVTransport:1',
      renderingControlUrl: 'http://192.168.1.10/rc',
      renderingControlServiceType: 'urn:schemas-upnp-org:service:RenderingControl:1',
      modelName: 'x',
      lastSeenAt: Date.now(),
    };
    (DlnaService as unknown as {
      rendererEventSubscriptionSidByRendererId: Map<string, string>;
    }).rendererEventSubscriptionSidByRendererId.set('r1', 'uuid:stale');

    const res412 = {
      ok: false,
      status: 412,
      headers: new Headers(),
    };
    const res200 = {
      ok: true,
      status: 200,
      headers: new Headers({ sid: 'uuid:new-sid', timeout: 'Second-300' }),
    };

    (global as unknown as { fetch: jest.Mock }).fetch
      .mockResolvedValueOnce(res412)
      .mockResolvedValueOnce(res200);

    await (DlnaService as unknown as {
      performEventSubscription: (r: typeof renderer) => Promise<void>;
    }).performEventSubscription(renderer);

    expect((global as unknown as { fetch: jest.Mock }).fetch).toHaveBeenCalledTimes(2);
    const secondCall = (global as unknown as { fetch: jest.Mock }).fetch.mock.calls[1];
    expect(secondCall[1].headers.NT).toBe('upnp:event');
    expect(
      (DlnaService as unknown as { rendererEventSubscriptionSidByRendererId: Map<string, string> })
        .rendererEventSubscriptionSidByRendererId.get('r1'),
    ).toBe('uuid:new-sid');
  });

  test('repeated failures apply exponential backoff', async () => {
    const renderer = {
      id: 'r2',
      location: 'http://192.168.1.11:49152/description.xml',
      friendlyName: 'Test2',
      avTransportControlUrl: 'http://192.168.1.11/ctl',
      avTransportEventUrl: 'http://192.168.1.11/event/AVTransport',
      avTransportServiceType: 'urn:schemas-upnp-org:service:AVTransport:1',
      renderingControlUrl: 'http://192.168.1.11/rc',
      renderingControlServiceType: 'urn:schemas-upnp-org:service:RenderingControl:1',
      modelName: 'x',
      lastSeenAt: Date.now(),
    };
    const fail = { ok: false, status: 500, headers: new Headers() };
    (global as unknown as { fetch: jest.Mock }).fetch.mockResolvedValue(fail);

    const svc = DlnaService as unknown as {
      performEventSubscription: (r: typeof renderer) => Promise<void>;
      rendererAvEventSubscriptionBackoffUntilByRendererId: Map<string, number>;
    };

    await svc.performEventSubscription(renderer);
    const until1 = svc.rendererAvEventSubscriptionBackoffUntilByRendererId.get('r2') || 0;
    expect(until1).toBeGreaterThan(Date.now());

    await svc.performEventSubscription(renderer);
    const until2 = svc.rendererAvEventSubscriptionBackoffUntilByRendererId.get('r2') || 0;
    expect(until2).toBeGreaterThanOrEqual(until1);
  });
});
