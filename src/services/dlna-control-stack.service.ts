export type DlnaStackMetadata = {
  title: string;
  artist: string;
  album?: string;
  albumArtUri?: string;
  mimeType: string;
  protocolInfo?: string;
};

export type DlnaStackPlaylistItem = {
  uri: string;
  metadata: DlnaStackMetadata;
};

type DlnaStackUrls = {
  avTransport: string;
  renderingControl: string;
  connectionManager?: string;
};

export class DlnaControlStackService {
  private parser = new DOMParser();
  private timeoutMs: number;

  constructor(
    private urls: DlnaStackUrls,
    options?: {
      timeout?: number;
    },
  ) {
    this.timeoutMs = Math.max(1000, Number(options?.timeout || 5000));
  }

  private async soapRequest(
    url: string,
    serviceType: string,
    action: string,
    args: Record<string, string>,
    rawValueKeys?: Set<string>,
  ): Promise<Document> {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${serviceType}">
      ${Object.entries(args).map(([key, value]) => `<${key}>${rawValueKeys?.has(key) ? value : this.escape(value)}</${key}>`).join('')}
    </u:${action}>
  </s:Body>
</s:Envelope>`;
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPACTION: `"${serviceType}#${action}"`,
        },
        body,
        signal: abortController.signal,
      });
      const responseText = await response.text();
      const xml = this.parser.parseFromString(responseText, 'text/xml');
      if (!response.ok) {
        throw new Error(`SOAP ${action} failed with HTTP ${response.status}`);
      }
      return xml;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private escape(value: string): string {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private buildDidlItem(item: DlnaStackPlaylistItem, id: string): string {
    const audioProtocolInfo = item.metadata.protocolInfo || `http-get:*:${item.metadata.mimeType}:*`;
    return `<item id="${this.escape(id)}" parentID="-1" restricted="1">
  <dc:title>${this.escape(item.metadata.title)}</dc:title>
  <dc:creator>${this.escape(item.metadata.artist)}</dc:creator>
  ${item.metadata.album ? `<upnp:album>${this.escape(item.metadata.album)}</upnp:album>` : ''}
  <upnp:class>object.item.audioItem.musicTrack</upnp:class>
  ${item.metadata.albumArtUri ? `<upnp:albumArtURI>${this.escape(item.metadata.albumArtUri)}</upnp:albumArtURI>` : ''}
  <res protocolInfo="${this.escape(audioProtocolInfo)}">${this.escape(item.uri)}</res>
</item>`;
  }

  private toEscapedDidl(items: DlnaStackPlaylistItem[]): string {
    const didl = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
${items.map((item, index) => this.buildDidlItem(item, `${Date.now()}-${index}`)).join('\n')}
</DIDL-Lite>`;
    return this.escape(didl);
  }

  async clearPlaylist(): Promise<void> {
    await this.soapRequest(
      this.urls.avTransport,
      'urn:schemas-upnp-org:service:AVTransport:1',
      'X_ClearPlaylist',
      {
        InstanceID: '0',
      },
    );
  }

  async setPlaylist(items: DlnaStackPlaylistItem[]): Promise<void> {
    const escapedPlaylistData = this.toEscapedDidl(items);
    await this.soapRequest(
      this.urls.avTransport,
      'urn:schemas-upnp-org:service:AVTransport:1',
      'X_SetPlaylist',
      {
        InstanceID: '0',
        PlaylistData: escapedPlaylistData,
        PlaylistLength: String(items.length),
        X_ReplaceMode: '1',
      },
      new Set(['PlaylistData']),
    );
  }
}
