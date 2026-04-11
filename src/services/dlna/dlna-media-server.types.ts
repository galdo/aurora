import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'http';
import type dgram from 'dgram';

/**
 * Dependencies injected from {@link DlnaService} so the media-server layer stays testable
 * and free of renderer/control state.
 */
export type DlnaMediaServerDeps = {
  readonly multicastIp: string;
  readonly multicastPort: number;
  readonly ssdpMaxAgeSeconds: number;
  readonly notifyIntervalMs: number;
  readonly ssdpRestartDelayMs: number;
  readonly bufferBytes: number;
  readonly rootDeviceUdn: string;
  readonly serviceType: string;
  readonly upnpMediaServerV2ServiceType: string;
  readonly contentDirectoryServiceType: string;
  readonly connectionManagerServiceType: string;
  readonly usn: string;
  readonly upnpMediaServerV2Usn: string;

  get port(): number;
  get enabled(): boolean;
  setLastError(message: string | undefined): void;

  getHttpServer(): HttpServer | undefined;
  setHttpServer(server: HttpServer | undefined): void;
  getSsdpSocket(): dgram.Socket | undefined;
  setSsdpSocket(socket: dgram.Socket | undefined): void;
  getSsdpInterval(): ReturnType<typeof setInterval> | undefined;
  setSsdpInterval(handle: ReturnType<typeof setInterval> | undefined): void;
  getSsdpRestartTimeout(): ReturnType<typeof setTimeout> | undefined;
  setSsdpRestartTimeout(handle: ReturnType<typeof setTimeout> | undefined): void;

  getIconCache(): Map<number, Buffer>;

  emitState(): void;
  refreshBrowseLibrary(): Promise<void>;
  getIpAddresses(): string[];

  writeDlnaLog(level: 'info' | 'warn' | 'error', event: string, details?: Record<string, unknown>): void;

  getDescriptionXml(profile: 'v1' | 'v2', clientBaseUrl?: string): string;
  getContentXml(): string;
  getContentDirectoryScpdXml(): string;
  getConnectionManagerScpdXml(): string;

  getServerStateJson(): Record<string, unknown>;

  getCurrentTrackId(): string | undefined;

  handleContentDirectoryControlRequest(request: IncomingMessage, response: ServerResponse): void;
  handleConnectionManagerControlRequest(request: IncomingMessage, response: ServerResponse): void;
  handleRendererEventCallbackRequest(request: IncomingMessage, response: ServerResponse): void;
  handleRenderingControlEventCallbackRequest(request: IncomingMessage, response: ServerResponse): void;

  resolveStreamTrack(trackId: string): Promise<{
    id: string;
    filePath: string;
    mimeType: string;
    fileSize: number;
    coverPath?: string;
  } | undefined>;

  getDlnaContentFeaturesForMimeType(mimeType: string): string;
  getDlnaImageProfileForMimeType(): string;
  getImageMimeType(filePath: string): string;
};
