import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import http, { IncomingMessage, ServerResponse } from 'http';
import dgram from 'dgram';
import sharp from 'sharp';

import {
  MediaTrackCoverPictureImageDataType,
} from '../enums';
import {
  IMediaAlbum,
  IMediaArtist,
  IMediaTrackData,
  IPodcastEpisode,
  IMediaTrack,
  IPodcastSubscription,
} from '../interfaces';
import {
  MediaAlbumDatastore,
  MediaArtistDatastore,
  MediaPlaylistDatastore,
  MediaTrackDatastore,
} from '../datastores';
import { MediaAlbumService } from './media-album.service';
import { AppService } from './app.service';
import { ArtistViewMode, MediaArtistService } from './media-artist.service';
import { MediaLikedTrackService } from './media-liked-track.service';
import { PodcastService } from './podcast.service';

type DlnaTrack = {
  id: string;
  providerId: string;
  title: string;
  artist: string;
  artistIds: string[];
  album: string;
  albumId: string;
  duration: number;
  filePath: string;
  mimeType: string;
  fileSize: number;
  coverPath?: string;
  coverMimeType?: string;
};

type DlnaRendererDevice = {
  id: string;
  location: string;
  friendlyName: string;
  modelName: string;
  avTransportControlUrl: string;
  avTransportServiceType: string;
  renderingControlUrl: string;
  renderingControlServiceType: string;
  lastSeenAt: number;
};

type DlnaBrowseLibrary = {
  tracks: DlnaTrack[];
  trackById: Map<string, DlnaTrack>;
  albums: IMediaAlbum[];
  artists: IMediaArtist[];
  playlists: Array<{
    id: string;
    name: string;
    trackProviderIds: string[];
  }>;
  podcasts: IPodcastSubscription[];
  artistViewMode: ArtistViewMode;
  updatedAt: number;
};

export type DlnaState = {
  enabled: boolean;
  running: boolean;
  friendlyName: string;
  hostname: string;
  port: number;
  ipAddresses: string[];
  descriptionUrl: string;
  contentUrl: string;
  currentStreamUrl: string;
  serviceType: string;
  usn: string;
  bufferBytes: number;
  suggestedClientPrebufferSeconds: number;
  suggestedServerPrebufferSeconds: number;
  tracksShared: number;
  currentTrackTitle?: string;
  lastError?: string;
  outputMode: 'local' | 'remote';
  selectedRendererId?: string;
  selectedRendererName?: string;
  rendererDevices: Array<{
    id: string;
    name: string;
    modelName: string;
  }>;
};

export type DlnaRendererSnapshot = {
  transportState?: string;
  positionSeconds?: number;
  volumePercent?: number;
  muted?: boolean;
};

const debug = require('debug')('aurora:service:dlna');

export class DlnaService {
  private static readonly storageKey = 'aurora:dlna-settings';
  private static readonly uiSettingsStorageKey = 'aurora:ui-settings';
  private static readonly uiSettingsChangedEventName = 'aurora:settings-changed';
  private static readonly eventName = 'aurora:dlna-state-changed';
  private static readonly multicastIp = '239.255.255.250';
  private static readonly multicastPort = 1900;
  private static readonly serviceType = 'urn:schemas-upnp-org:device:MediaServer:1';
  private static readonly rootDeviceUdn = 'uuid:aurora-pulse-media-server';
  private static readonly contentDirectoryServiceType = 'urn:schemas-upnp-org:service:ContentDirectory:1';
  private static readonly connectionManagerServiceType = 'urn:schemas-upnp-org:service:ConnectionManager:1';
  private static readonly usn = `${this.rootDeviceUdn}::${this.serviceType}`;
  private static readonly defaultPort = 58200;
  private static readonly bufferBytes = 512 * 1024;
  private static readonly suggestedClientPrebufferSeconds = 3;
  private static readonly suggestedServerPrebufferSeconds = 2;
  private static readonly notifyIntervalMs = 20000;
  private static readonly trackLimit = 200;
  private static readonly ssdpMaxAgeSeconds = 1800;
  private static readonly controlSettingsStorageKey = 'aurora:dlna-control-settings';
  private static readonly rendererDiscoveryNoDeviceIntervalMs = 8000;
  private static readonly rendererDiscoveryWithDeviceIntervalMs = 12000;
  private static readonly rendererDiscoverySelectedRemoteIntervalMs = 4000;
  private static readonly rendererDiscoveryStartupProbeDelaysMs = [1500, 4000, 9000];
  private static readonly rendererMaxAgeMs = 15000;
  private static readonly avTransportServiceType = 'urn:schemas-upnp-org:service:AVTransport:1';
  private static readonly renderingControlServiceType = 'urn:schemas-upnp-org:service:RenderingControl:1';
  private static readonly soapRequestTimeoutMs = 4000;
  private static readonly transportSetupSoapRequestTimeoutMs = 5000;
  private static readonly snapshotTransportSoapRequestTimeoutMs = 1800;
  private static readonly snapshotPositionSoapRequestTimeoutMs = 2200;
  private static readonly snapshotOutputSoapRequestTimeoutMs = 1400;
  private static readonly snapshotOutputRefreshIntervalMs = 8000;
  private static readonly dlnaLogFileName = 'dlna.log';
  private static readonly dlnaArtworkCacheDirName = 'dlna-artwork-cache';

  private static enabled = false;
  private static port = this.defaultPort;
  private static httpServer?: http.Server;
  private static ssdpSocket?: dgram.Socket;
  private static ssdpInterval?: ReturnType<typeof setInterval>;
  private static trackOrder: string[] = [];
  private static trackMap: Map<string, DlnaTrack> = new Map();
  private static currentTrackId?: string;
  private static systemUpdateId = 1;
  private static lastError?: string;
  private static initialized = false;
  private static browseLibraryCache?: DlnaBrowseLibrary;
  private static browseLibraryLoadingPromise?: Promise<DlnaBrowseLibrary>;
  private static readonly browseLibraryCacheTtlMs = 120000;
  private static uiSettingsListenerRegistered = false;
  private static outputMode: 'local' | 'remote' = 'local';
  private static selectedRendererId?: string;
  private static rendererDevices: Map<string, DlnaRendererDevice> = new Map();
  private static rendererOutputStateByRendererId: Map<string, { volumePercent?: number; muted?: boolean }> = new Map();
  private static rendererOutputStateLastRefreshAtByRendererId: Map<string, number> = new Map();
  private static rendererMuteControlUnsupportedIds: Set<string> = new Set();
  private static selectedRendererSnapshotFailureCount = 0;
  private static selectedRendererSnapshotFailureRendererId?: string;
  private static rendererDiscoverySocket?: dgram.Socket;
  private static rendererDiscoveryInterval?: ReturnType<typeof setTimeout>;
  private static rendererDiscoveryStartupProbes: Array<ReturnType<typeof setTimeout>> = [];
  private static dlnaLogPathCache?: string;
  private static dlnaArtworkCachePath?: string;

  static initialize() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.loadSettings();
    this.loadControlSettings();
    this.registerUiSettingsListener();
    this.startRendererDiscovery();
    if (this.enabled) {
      this.startServer();
    } else {
      this.emitState();
    }
  }

  static subscribe(listener: (state: DlnaState) => void): () => void {
    const eventListener = () => listener(this.getState());
    window.addEventListener(this.eventName, eventListener);
    return () => {
      window.removeEventListener(this.eventName, eventListener);
    };
  }

  static getState(): DlnaState {
    const hostname = os.hostname();
    const ipAddresses = this.getIpAddresses();
    const primaryIp = ipAddresses[0] || '127.0.0.1';
    const baseUrl = `http://${primaryIp}:${this.port}`;
    const currentTrack = this.currentTrackId ? this.trackMap.get(this.currentTrackId) : undefined;
    const selectedRenderer = this.selectedRendererId
      ? this.rendererDevices.get(this.selectedRendererId)
      : undefined;
    return {
      enabled: this.enabled,
      running: !!this.httpServer,
      friendlyName: `Aurora Pulse DLNA (${hostname})`,
      hostname,
      port: this.port,
      ipAddresses,
      descriptionUrl: `${baseUrl}/description.xml`,
      contentUrl: `${baseUrl}/content.xml`,
      currentStreamUrl: `${baseUrl}/stream/current`,
      serviceType: this.serviceType,
      usn: this.usn,
      bufferBytes: this.bufferBytes,
      suggestedClientPrebufferSeconds: this.suggestedClientPrebufferSeconds,
      suggestedServerPrebufferSeconds: this.suggestedServerPrebufferSeconds,
      tracksShared: this.trackOrder.length,
      currentTrackTitle: currentTrack?.title,
      lastError: this.lastError,
      outputMode: this.outputMode,
      selectedRendererId: this.selectedRendererId,
      selectedRendererName: selectedRenderer?.friendlyName,
      rendererDevices: Array.from(this.rendererDevices.values())
        .sort((left, right) => left.friendlyName.localeCompare(right.friendlyName))
        .map(renderer => ({
          id: renderer.id,
          name: renderer.friendlyName,
          modelName: renderer.modelName,
        })),
    };
  }

  static getSelectedRendererOutputState(): { volumePercent?: number; muted?: boolean } | undefined {
    const renderer = this.getSelectedRenderer();
    if (!renderer) {
      return undefined;
    }
    const outputState = this.rendererOutputStateByRendererId.get(renderer.id);
    if (!outputState) {
      return undefined;
    }
    return {
      volumePercent: outputState.volumePercent,
      muted: outputState.muted,
    };
  }

  static async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    this.persistSettings();
    if (enabled) {
      await this.startServer();
      await this.refreshBrowseLibrary();
      return;
    }
    await this.stopServer();
    this.emitState();
  }

  static async refreshRendererDevices(): Promise<void> {
    await this.startRendererDiscovery();
    this.sendRendererDiscoveryProbe();
    this.pruneInactiveRenderers();
    this.emitState();
  }

  static isRemoteOutputSelected(): boolean {
    return this.outputMode === 'remote'
      && !!this.selectedRendererId
      && this.rendererDevices.has(this.selectedRendererId);
  }

  static isRemoteOutputRequested(): boolean {
    return this.outputMode === 'remote' && !!this.selectedRendererId;
  }

  static async setOutputDevice(outputDeviceId: string): Promise<void> {
    const normalizedOutputDeviceId = String(outputDeviceId || '').trim();
    const previousRenderer = this.getSelectedRenderer();
    const shouldStopPreviousRenderer = !!previousRenderer
      && (
        !normalizedOutputDeviceId
        || normalizedOutputDeviceId === 'local'
        || normalizedOutputDeviceId !== previousRenderer.id
      );
    if (shouldStopPreviousRenderer && previousRenderer) {
      await this.stopRenderer(previousRenderer).catch((error) => {
        debug('setOutputDevice - failed to stop previous renderer %s - %o', previousRenderer.id, error);
      });
    }
    if (!normalizedOutputDeviceId || normalizedOutputDeviceId === 'local') {
      this.outputMode = 'local';
      this.selectedRendererId = undefined;
      this.selectedRendererSnapshotFailureCount = 0;
      this.selectedRendererSnapshotFailureRendererId = undefined;
      this.persistControlSettings();
      this.emitState();
      return;
    }

    const renderer = this.rendererDevices.get(normalizedOutputDeviceId);
    if (!renderer) {
      throw new Error(`DLNA renderer not found: ${normalizedOutputDeviceId}`);
    }

    await this.startServer();
    this.outputMode = 'remote';
    this.selectedRendererId = renderer.id;
    this.selectedRendererSnapshotFailureCount = 0;
    this.selectedRendererSnapshotFailureRendererId = renderer.id;
    this.persistControlSettings();
    this.emitState();
  }

  static async playMediaTrackOnSelectedRenderer(
    mediaTrack: IMediaTrack,
    seekPositionSeconds = 0,
    options?: {
      mediaPlaybackVolume?: number;
      mediaPlaybackMaxVolume?: number;
      muted?: boolean;
    },
  ): Promise<boolean> {
    if (!this.isRemoteOutputSelected()) {
      return false;
    }

    const renderer = this.getSelectedRenderer();
    if (!renderer) {
      return false;
    }

    await this.startServer();
    const filePath = String((mediaTrack.extra as any)?.file_path || '').trim();
    if (filePath && fs.existsSync(filePath)) {
      this.registerTrackFromMediaTrack(mediaTrack, filePath);
    }

    const mediaTrackId = String(mediaTrack.id || mediaTrack.provider_id || '');
    if (!mediaTrackId) {
      return false;
    }

    const streamUrl = this.getTrackStreamUrlForRenderer(renderer, mediaTrackId);
    const metadata = this.buildRendererTrackMetadata(mediaTrack, streamUrl, 'full');
    const compatibilityMetadata = this.buildRendererTrackMetadata(mediaTrack, streamUrl, 'compatibility');
    this.writeDlnaLog('info', 'play_track_requested', {
      rendererId: renderer.id,
      rendererName: renderer.friendlyName,
      mediaTrackId,
      streamUrl,
    });

    const transportUriWasSet = await this.setRendererTransportUri(
      renderer,
      streamUrl,
      metadata,
      compatibilityMetadata,
      'primary',
    )
      .then(() => true)
      .catch(() => false);
    if (!transportUriWasSet) {
      await this.sendSoapRequest(
        renderer.avTransportControlUrl,
        renderer.avTransportServiceType,
        'Stop',
        {
          InstanceID: '0',
        },
      ).catch(() => undefined);
      await this.setRendererTransportUri(
        renderer,
        streamUrl,
        metadata,
        compatibilityMetadata,
        'retry',
      );
    }

    const playbackStarted = await this.startRendererPlayback(renderer, seekPositionSeconds);
    this.applyRendererOutputState(renderer, options).catch((error: any) => {
      this.writeDlnaLog('warn', 'apply_output_state_failed', {
        rendererId: renderer.id,
        rendererName: renderer.friendlyName,
        error: String(error?.message || error || ''),
      });
    });
    if (playbackStarted) {
      return true;
    }
    await this.sendSoapRequest(
      renderer.avTransportControlUrl,
      renderer.avTransportServiceType,
      'Stop',
      {
        InstanceID: '0',
      },
    ).catch(() => undefined);
    await this.setRendererTransportUri(renderer, streamUrl, metadata, compatibilityMetadata, 'retry');
    return this.startRendererPlayback(renderer, seekPositionSeconds);
  }

  static async setNextMediaTrackOnSelectedRenderer(mediaTrack?: IMediaTrack): Promise<boolean> {
    const renderer = this.getSelectedRenderer();
    if (!renderer) {
      return false;
    }
    await this.startServer();
    if (!mediaTrack) {
      return this.sendSoapRequest(
        renderer.avTransportControlUrl,
        renderer.avTransportServiceType,
        'SetNextAVTransportURI',
        {
          InstanceID: '0',
          NextURI: '',
          NextURIMetaData: '',
        },
      )
        .then(() => true)
        .catch(() => false);
    }
    const filePath = String((mediaTrack.extra as any)?.file_path || '').trim();
    if (filePath && fs.existsSync(filePath)) {
      this.registerTrackFromMediaTrack(mediaTrack, filePath);
    }
    const mediaTrackId = String(mediaTrack.id || mediaTrack.provider_id || '').trim();
    if (!mediaTrackId) {
      return false;
    }
    const streamUrl = this.getTrackStreamUrlForRenderer(renderer, mediaTrackId);
    const metadata = this.buildRendererTrackMetadata(mediaTrack, streamUrl, 'full');
    const compatibilityMetadata = this.buildRendererTrackMetadata(mediaTrack, streamUrl, 'compatibility');
    return this.setRendererNextTransportUri(renderer, streamUrl, metadata, compatibilityMetadata);
  }

  static async pauseSelectedRenderer(): Promise<boolean> {
    const renderer = this.getSelectedRenderer();
    if (!renderer) {
      return false;
    }
    this.writeDlnaLog('info', 'pause_requested', {
      rendererId: renderer.id,
      rendererName: renderer.friendlyName,
    });
    const paused = await this.sendSoapRequest(
      renderer.avTransportControlUrl,
      renderer.avTransportServiceType,
      'Pause',
      {
        InstanceID: '0',
      },
    )
      .then(() => true)
      .catch(() => false);
    if (paused) {
      this.writeDlnaLog('info', 'pause_acknowledged', {
        rendererId: renderer.id,
        rendererName: renderer.friendlyName,
        source: 'soap_response',
      });
      return true;
    }
    const snapshot = await this.getSelectedRendererSnapshot().catch(() => undefined);
    const transportState = String(snapshot?.transportState || '').toUpperCase();
    if (transportState === 'TRANSITIONING') {
      const stableState = await this.waitForSelectedRendererTransportState({
        allowedStates: ['PAUSED_PLAYBACK', 'PAUSED', 'STOPPED', 'NO_MEDIA_PRESENT', 'PLAYING'],
        timeoutMs: 2400,
      });
      if (stableState === 'PAUSED_PLAYBACK'
        || stableState === 'PAUSED'
        || stableState === 'STOPPED'
        || stableState === 'NO_MEDIA_PRESENT') {
        this.writeDlnaLog('info', 'pause_delayed_acknowledged', {
          rendererId: renderer.id,
          rendererName: renderer.friendlyName,
          transportState: stableState,
        });
        return true;
      }
      if (stableState === 'PLAYING') {
        const retriedPause = await this.sendSoapRequest(
          renderer.avTransportControlUrl,
          renderer.avTransportServiceType,
          'Pause',
          {
            InstanceID: '0',
          },
        )
          .then(() => true)
          .catch(() => false);
        if (retriedPause) {
          this.writeDlnaLog('info', 'pause_acknowledged', {
            rendererId: renderer.id,
            rendererName: renderer.friendlyName,
            source: 'soap_retry_after_transition',
          });
          return true;
        }
      }
    }
    this.writeDlnaLog('info', 'pause_snapshot_check', {
      rendererId: renderer.id,
      rendererName: renderer.friendlyName,
      transportState,
    });
    return transportState === 'PAUSED_PLAYBACK'
      || transportState === 'PAUSED'
      || transportState === 'STOPPED'
      || transportState === 'NO_MEDIA_PRESENT';
  }

  static async resumeSelectedRenderer(): Promise<boolean> {
    const renderer = this.getSelectedRenderer();
    if (!renderer) {
      return false;
    }
    this.writeDlnaLog('info', 'resume_requested', {
      rendererId: renderer.id,
      rendererName: renderer.friendlyName,
    });
    const resumed = await this.sendSoapRequest(
      renderer.avTransportControlUrl,
      renderer.avTransportServiceType,
      'Play',
      {
        InstanceID: '0',
        Speed: '1',
      },
    )
      .then(() => true)
      .catch(() => false);
    if (resumed) {
      this.writeDlnaLog('info', 'resume_acknowledged', {
        rendererId: renderer.id,
        rendererName: renderer.friendlyName,
        source: 'soap_response',
      });
      return true;
    }
    const snapshot = await this.getSelectedRendererSnapshot().catch(() => undefined);
    const transportState = String(snapshot?.transportState || '').toUpperCase();
    if (transportState === 'TRANSITIONING') {
      const stableState = await this.waitForSelectedRendererTransportState({
        allowedStates: ['PLAYING', 'PAUSED_PLAYBACK', 'PAUSED', 'STOPPED', 'NO_MEDIA_PRESENT'],
        timeoutMs: 2400,
      });
      if (stableState === 'PLAYING') {
        this.writeDlnaLog('info', 'resume_delayed_acknowledged', {
          rendererId: renderer.id,
          rendererName: renderer.friendlyName,
          transportState: stableState,
        });
        return true;
      }
      if (stableState === 'PAUSED_PLAYBACK'
        || stableState === 'PAUSED'
        || stableState === 'STOPPED'
        || stableState === 'NO_MEDIA_PRESENT') {
        const retriedPlay = await this.sendSoapRequest(
          renderer.avTransportControlUrl,
          renderer.avTransportServiceType,
          'Play',
          {
            InstanceID: '0',
            Speed: '1',
          },
        )
          .then(() => true)
          .catch(() => false);
        if (retriedPlay) {
          this.writeDlnaLog('info', 'resume_acknowledged', {
            rendererId: renderer.id,
            rendererName: renderer.friendlyName,
            source: 'soap_retry_after_transition',
          });
          return true;
        }
      }
    }
    this.writeDlnaLog('info', 'resume_snapshot_check', {
      rendererId: renderer.id,
      rendererName: renderer.friendlyName,
      transportState,
    });
    return transportState === 'PLAYING';
  }

  static async stopSelectedRenderer(): Promise<boolean> {
    const renderer = this.getSelectedRenderer();
    if (!renderer) {
      return false;
    }
    this.writeDlnaLog('info', 'stop_requested', {
      rendererId: renderer.id,
      rendererName: renderer.friendlyName,
    });
    await this.stopRenderer(renderer);
    const snapshot = await this.getSelectedRendererSnapshot().catch(() => undefined);
    const transportState = String(snapshot?.transportState || '').toUpperCase();
    if (transportState === 'TRANSITIONING') {
      const stableState = await this.waitForSelectedRendererTransportState({
        allowedStates: ['STOPPED', 'NO_MEDIA_PRESENT', 'PAUSED_PLAYBACK', 'PAUSED', 'PLAYING'],
        timeoutMs: 2400,
      });
      this.writeDlnaLog('info', 'stop_delayed_snapshot_check', {
        rendererId: renderer.id,
        rendererName: renderer.friendlyName,
        transportState: stableState || transportState,
      });
    }
    this.writeDlnaLog('info', 'stop_snapshot_check', {
      rendererId: renderer.id,
      rendererName: renderer.friendlyName,
      transportState,
    });
    return true;
  }

  static async getSelectedRendererSnapshot(): Promise<DlnaRendererSnapshot | undefined> {
    const renderer = this.getSelectedRenderer();
    if (!renderer) {
      return undefined;
    }

    const [transportInfoResponse, positionInfoResponse] = await Promise.all([
      this.sendSoapRequest(
        renderer.avTransportControlUrl,
        renderer.avTransportServiceType,
        'GetTransportInfo',
        {
          InstanceID: '0',
        },
        this.snapshotTransportSoapRequestTimeoutMs,
      ).catch(() => ''),
      this.sendSoapRequest(
        renderer.avTransportControlUrl,
        renderer.avTransportServiceType,
        'GetPositionInfo',
        {
          InstanceID: '0',
        },
        this.snapshotPositionSoapRequestTimeoutMs,
      ).catch(() => ''),
    ]);
    let volumeResponse = '';
    let muteResponse = '';
    const now = Date.now();
    const lastOutputRefreshAt = Number(this.rendererOutputStateLastRefreshAtByRendererId.get(renderer.id) || 0);
    const shouldRefreshOutputState = (now - lastOutputRefreshAt) >= this.snapshotOutputRefreshIntervalMs;
    if (shouldRefreshOutputState) {
      const [volumeStateResponse, muteStateResponse] = await Promise.all([
        this.sendSoapRequest(
          renderer.renderingControlUrl,
          renderer.renderingControlServiceType,
          'GetVolume',
          {
            InstanceID: '0',
            Channel: 'Master',
          },
          this.snapshotOutputSoapRequestTimeoutMs,
        ).catch(() => ''),
        (this.rendererMuteControlUnsupportedIds.has(renderer.id)
          ? Promise.resolve('')
          : this.sendSoapRequest(
            renderer.renderingControlUrl,
            renderer.renderingControlServiceType,
            'GetMute',
            {
              InstanceID: '0',
              Channel: 'Master',
            },
            this.snapshotOutputSoapRequestTimeoutMs,
          ).catch((error: any) => {
            if (this.isSoapHttp500Error(error)) {
              this.rendererMuteControlUnsupportedIds.add(renderer.id);
              this.writeDlnaLog('warn', 'renderer_mute_control_unsupported', {
                rendererId: renderer.id,
                rendererName: renderer.friendlyName,
                actionName: 'GetMute',
              });
            }
            return '';
          })),
      ]);
      volumeResponse = volumeStateResponse;
      muteResponse = muteStateResponse;
      this.rendererOutputStateLastRefreshAtByRendererId.set(renderer.id, now);
    }
    const hasAnySnapshotPayload = [
      transportInfoResponse,
      positionInfoResponse,
      volumeResponse,
      muteResponse,
    ].some(responsePayload => String(responsePayload || '').trim().length > 0);
    if (!hasAnySnapshotPayload) {
      const currentRendererId = renderer.id;
      if (this.selectedRendererSnapshotFailureRendererId !== currentRendererId) {
        this.selectedRendererSnapshotFailureRendererId = currentRendererId;
        this.selectedRendererSnapshotFailureCount = 0;
      }
      this.selectedRendererSnapshotFailureCount += 1;
      this.writeDlnaLog('warn', 'snapshot_empty_payload', {
        rendererId: currentRendererId,
        rendererName: renderer.friendlyName,
        failureCount: this.selectedRendererSnapshotFailureCount,
      });
      return undefined;
    }
    this.selectedRendererSnapshotFailureCount = 0;
    this.selectedRendererSnapshotFailureRendererId = renderer.id;
    renderer.lastSeenAt = Date.now();
    this.rendererDevices.set(renderer.id, renderer);

    const currentTransportState = String(this.extractXmlTagValue(transportInfoResponse, 'CurrentTransportState') || '').trim();
    const relativeTimePosition = String(this.extractXmlTagValue(positionInfoResponse, 'RelTime') || '').trim();
    const currentVolume = Number(this.extractXmlTagValue(volumeResponse, 'CurrentVolume') || NaN);
    const currentMute = String(this.extractXmlTagValue(muteResponse, 'CurrentMute') || '').trim();
    if (Number.isFinite(currentVolume)) {
      this.updateRendererOutputCache(renderer.id, {
        volumePercent: Math.max(0, Math.min(100, Math.floor(currentVolume))),
      });
    }
    if (currentMute === '1' || currentMute === '0') {
      this.updateRendererOutputCache(renderer.id, {
        muted: currentMute === '1',
      });
    }

    const mutedFromCache = this.rendererOutputStateByRendererId.get(renderer.id)?.muted;
    let mutedState = mutedFromCache;
    if (currentMute === '1') {
      mutedState = true;
    } else if (currentMute === '0') {
      mutedState = false;
    }
    return {
      transportState: currentTransportState || undefined,
      positionSeconds: this.parseDlnaTimeToSeconds(relativeTimePosition),
      volumePercent: Number.isFinite(currentVolume)
        ? Math.max(0, Math.min(100, Math.floor(currentVolume)))
        : this.rendererOutputStateByRendererId.get(renderer.id)?.volumePercent,
      muted: mutedState,
    };
  }

  private static async stopRenderer(renderer: DlnaRendererDevice): Promise<void> {
    await this.sendSoapRequest(
      renderer.avTransportControlUrl,
      renderer.avTransportServiceType,
      'Stop',
      {
        InstanceID: '0',
      },
    );
  }

  static async seekSelectedRenderer(seekPositionSeconds: number): Promise<boolean> {
    const renderer = this.getSelectedRenderer();
    if (!renderer) {
      return false;
    }
    const clampedSeconds = Math.max(0, Math.floor(Number(seekPositionSeconds || 0)));
    const seekTarget = this.formatSecondsAsDlnaTime(clampedSeconds);
    await this.sendSoapRequest(
      renderer.avTransportControlUrl,
      renderer.avTransportServiceType,
      'Seek',
      {
        InstanceID: '0',
        Unit: 'REL_TIME',
        Target: seekTarget,
      },
    );
    return true;
  }

  static async setSelectedRendererVolume(mediaPlaybackVolume: number, mediaPlaybackMaxVolume: number): Promise<boolean> {
    const renderer = this.getSelectedRenderer();
    if (!renderer) {
      return false;
    }
    const maxVolume = Math.max(1, Number(mediaPlaybackMaxVolume || 100));
    const volume = Math.max(0, Math.min(100, Math.round((Number(mediaPlaybackVolume || 0) / maxVolume) * 100)));
    await this.sendSoapRequest(
      renderer.renderingControlUrl,
      renderer.renderingControlServiceType,
      'SetVolume',
      {
        InstanceID: '0',
        Channel: 'Master',
        DesiredVolume: String(volume),
      },
    );
    this.updateRendererOutputCache(renderer.id, {
      volumePercent: volume,
    });
    return true;
  }

  static async muteSelectedRenderer(): Promise<boolean> {
    const renderer = this.getSelectedRenderer();
    if (!renderer) {
      return false;
    }
    if (this.rendererMuteControlUnsupportedIds.has(renderer.id)) {
      return true;
    }
    await this.sendSoapRequest(
      renderer.renderingControlUrl,
      renderer.renderingControlServiceType,
      'SetMute',
      {
        InstanceID: '0',
        Channel: 'Master',
        DesiredMute: '1',
      },
    );
    this.updateRendererOutputCache(renderer.id, {
      muted: true,
    });
    return true;
  }

  static async unmuteSelectedRenderer(): Promise<boolean> {
    const renderer = this.getSelectedRenderer();
    if (!renderer) {
      return false;
    }
    if (this.rendererMuteControlUnsupportedIds.has(renderer.id)) {
      return true;
    }
    await this.sendSoapRequest(
      renderer.renderingControlUrl,
      renderer.renderingControlServiceType,
      'SetMute',
      {
        InstanceID: '0',
        Channel: 'Master',
        DesiredMute: '0',
      },
    );
    this.updateRendererOutputCache(renderer.id, {
      muted: false,
    });
    return true;
  }

  static registerTrackFromMediaTrack(mediaTrack: IMediaTrack, filePath: string) {
    if (!filePath || !fs.existsSync(filePath)) {
      return;
    }

    const fileStats = fs.statSync(filePath);
    const trackId = String(mediaTrack.id || mediaTrack.provider_id || filePath);
    const coverPath = this.getTrackCoverPathFromMediaTrack(mediaTrack);
    const track: DlnaTrack = {
      id: trackId,
      providerId: String(mediaTrack.provider_id || ''),
      title: String(mediaTrack.track_name || path.basename(filePath)),
      artist: String(mediaTrack.track_artists?.map(artist => artist.artist_name).join(', ') || ''),
      artistIds: (mediaTrack.track_artist_ids || []).map(artistId => String(artistId || '')).filter(Boolean),
      album: String(mediaTrack.track_album?.album_name || ''),
      albumId: String(mediaTrack.track_album_id || ''),
      duration: Number(mediaTrack.track_duration || 0),
      filePath,
      mimeType: this.getMimeType(filePath),
      fileSize: Number(fileStats.size || 0),
      coverPath: coverPath || undefined,
      coverMimeType: coverPath ? this.getImageMimeType(coverPath) : undefined,
    };
    this.trackMap.set(trackId, track);
    this.trackOrder = this.trackOrder.filter(existingId => existingId !== trackId);
    this.trackOrder.unshift(trackId);
    if (this.trackOrder.length > this.trackLimit) {
      const removedTrackId = this.trackOrder.pop();
      if (removedTrackId) {
        this.trackMap.delete(removedTrackId);
      }
    }
    this.currentTrackId = trackId;
    this.systemUpdateId += 1;
    this.emitState();
  }

  private static emitState() {
    window.dispatchEvent(new Event(this.eventName));
  }

  private static loadSettings() {
    try {
      const rawSettings = localStorage.getItem(this.storageKey);
      if (!rawSettings) {
        return;
      }
      const parsedSettings = JSON.parse(rawSettings);
      this.enabled = Boolean(parsedSettings?.enabled);
      const parsedPort = Number(parsedSettings?.port);
      if (Number.isFinite(parsedPort) && parsedPort > 1024 && parsedPort < 65535) {
        this.port = parsedPort;
      }
    } catch (_error) {
      this.enabled = false;
    }
  }

  private static persistSettings() {
    localStorage.setItem(this.storageKey, JSON.stringify({
      enabled: this.enabled,
      port: this.port,
    }));
  }

  private static loadControlSettings() {
    try {
      const rawSettings = localStorage.getItem(this.controlSettingsStorageKey);
      if (!rawSettings) {
        return;
      }
      const parsedSettings = JSON.parse(rawSettings);
      const parsedOutputMode = String(parsedSettings?.outputMode || '').trim();
      if (parsedOutputMode === 'remote') {
        this.outputMode = 'remote';
      } else {
        this.outputMode = 'local';
      }
      const parsedRendererId = String(parsedSettings?.selectedRendererId || '').trim();
      this.selectedRendererId = parsedRendererId || undefined;
    } catch (_error) {
      this.outputMode = 'local';
      this.selectedRendererId = undefined;
    }
  }

  private static persistControlSettings() {
    localStorage.setItem(this.controlSettingsStorageKey, JSON.stringify({
      outputMode: this.outputMode,
      selectedRendererId: this.selectedRendererId,
    }));
  }

  private static getSelectedRenderer(): DlnaRendererDevice | undefined {
    if (!this.selectedRendererId) {
      return undefined;
    }
    return this.rendererDevices.get(this.selectedRendererId);
  }

  private static async startRendererDiscovery() {
    if (this.rendererDiscoverySocket && this.rendererDiscoveryInterval) {
      return;
    }
    this.rendererDiscoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.rendererDiscoverySocket.on('message', (messageBuffer) => {
      const message = messageBuffer.toString('utf8');
      this.handleRendererDiscoveryMessage(message);
    });
    this.rendererDiscoverySocket.on('error', (error) => {
      debug('renderer discovery socket error - %o', error);
    });
    await new Promise<void>((resolve) => {
      this.rendererDiscoverySocket?.bind(0, () => {
        try {
          this.rendererDiscoverySocket?.addMembership(this.multicastIp);
        } catch (error) {
          debug('startRendererDiscovery addMembership failed - %o', error);
        }
        resolve();
      });
    });
    this.sendRendererDiscoveryProbe();
    this.pruneInactiveRenderers();
    this.scheduleRendererDiscoveryTick();
    this.scheduleRendererDiscoveryStartupProbes();
  }

  private static sendRendererDiscoveryProbe() {
    if (!this.rendererDiscoverySocket) {
      return;
    }
    [
      'urn:schemas-upnp-org:device:MediaRenderer:1',
      this.avTransportServiceType,
      this.renderingControlServiceType,
      'ssdp:all',
    ].forEach((searchTarget) => {
      const payload = [
        'M-SEARCH * HTTP/1.1',
        `HOST: ${this.multicastIp}:${this.multicastPort}`,
        'MAN: "ssdp:discover"',
        'MX: 2',
        `ST: ${searchTarget}`,
        '',
        '',
      ].join('\r\n');
      this.rendererDiscoverySocket?.send(payload, this.multicastPort, this.multicastIp);
    });
  }

  private static handleRendererDiscoveryMessage(message: string) {
    const normalizedMessage = message.toUpperCase();
    const isSearchResponse = normalizedMessage.startsWith('HTTP/1.1 200');
    const isAliveNotify = normalizedMessage.startsWith('NOTIFY * HTTP/1.1')
      && String(this.extractSsdpHeaderValue(message, 'NTS') || '').toLowerCase() === 'ssdp:alive';
    if (!isSearchResponse && !isAliveNotify) {
      return;
    }
    const location = this.extractSsdpHeaderValue(message, 'LOCATION');
    if (!location) {
      return;
    }
    this.fetchAndStoreRendererDescription(location).catch((error) => {
      debug('fetchAndStoreRendererDescription failed - %o', error);
    });
  }

  private static async fetchAndStoreRendererDescription(location: string) {
    const response = await fetch(location);
    if (!response.ok) {
      throw new Error(`Renderer description fetch failed with status ${response.status}`);
    }
    const xml = await response.text();
    const deviceType = String(this.extractXmlTagValue(xml, 'deviceType') || '');
    if (!deviceType.toLowerCase().includes('mediarenderer')) {
      return;
    }

    const udn = String(this.extractXmlTagValue(xml, 'UDN') || location).trim();
    const friendlyName = String(this.extractXmlTagValue(xml, 'friendlyName') || udn).trim();
    const modelName = String(this.extractXmlTagValue(xml, 'modelName') || '').trim();
    const serviceBlocks = this.extractXmlServiceBlocks(xml);
    const avTransportService = serviceBlocks.find(serviceBlock => serviceBlock.serviceType === this.avTransportServiceType);
    const renderingControlService = serviceBlocks.find(serviceBlock => serviceBlock.serviceType === this.renderingControlServiceType);

    if (!avTransportService || !renderingControlService) {
      return;
    }

    const rendererId = udn.replace(/^uuid:/i, '') || location;
    const renderer: DlnaRendererDevice = {
      id: rendererId,
      location,
      friendlyName,
      modelName,
      avTransportControlUrl: this.resolveServiceUrl(location, avTransportService.controlURL),
      avTransportServiceType: avTransportService.serviceType,
      renderingControlUrl: this.resolveServiceUrl(location, renderingControlService.controlURL),
      renderingControlServiceType: renderingControlService.serviceType,
      lastSeenAt: Date.now(),
    };
    this.rendererDevices.set(renderer.id, renderer);
    if (this.outputMode === 'remote' && this.selectedRendererId && !this.rendererDevices.has(this.selectedRendererId)) {
      this.outputMode = 'local';
      this.selectedRendererId = undefined;
      this.persistControlSettings();
    }
    this.emitState();
  }

  private static pruneInactiveRenderers() {
    const now = Date.now();
    const { selectedRendererId } = this;
    const activeRenderers = Array.from(this.rendererDevices.entries()).filter(([rendererId, renderer]) => {
      if (selectedRendererId && rendererId === selectedRendererId && this.outputMode === 'remote') {
        return true;
      }
      return (now - renderer.lastSeenAt) < this.rendererMaxAgeMs;
    });
    const selectedRendererStillActive = !!this.selectedRendererId
      && activeRenderers.some(([rendererId]) => rendererId === this.selectedRendererId);
    this.rendererDevices = new Map(activeRenderers);
    if (this.outputMode === 'remote' && this.selectedRendererId && !selectedRendererStillActive) {
      this.outputMode = 'local';
      this.selectedRendererId = undefined;
      this.persistControlSettings();
    }
    this.emitState();
  }

  private static scheduleRendererDiscoveryTick() {
    if (this.rendererDiscoveryInterval) {
      clearTimeout(this.rendererDiscoveryInterval);
    }
    const remoteRendererSelected = this.outputMode === 'remote' && !!this.selectedRendererId;
    const hasActiveRenderers = this.rendererDevices.size > 0;
    let nextProbeDelayMs = this.rendererDiscoveryNoDeviceIntervalMs;
    if (remoteRendererSelected) {
      nextProbeDelayMs = this.rendererDiscoverySelectedRemoteIntervalMs;
    } else if (hasActiveRenderers) {
      nextProbeDelayMs = this.rendererDiscoveryWithDeviceIntervalMs;
    }
    this.rendererDiscoveryInterval = setTimeout(() => {
      if (remoteRendererSelected) {
        this.getSelectedRendererSnapshot().catch(() => undefined);
      }
      this.sendRendererDiscoveryProbe();
      this.pruneInactiveRenderers();
      this.scheduleRendererDiscoveryTick();
    }, nextProbeDelayMs);
  }

  private static scheduleRendererDiscoveryStartupProbes() {
    if (this.rendererDiscoveryStartupProbes.length > 0) {
      return;
    }
    this.rendererDiscoveryStartupProbes = this.rendererDiscoveryStartupProbeDelaysMs.map(delayMs => setTimeout(() => {
      this.sendRendererDiscoveryProbe();
      this.pruneInactiveRenderers();
      this.scheduleRendererDiscoveryTick();
    }, delayMs));
  }

  private static extractXmlServiceBlocks(xml: string): Array<{ serviceType: string; controlURL: string }> {
    const services: Array<{ serviceType: string; controlURL: string }> = [];
    const serviceRegex = /<service>([\s\S]*?)<\/service>/gi;
    let serviceMatch = serviceRegex.exec(xml);
    while (serviceMatch) {
      const block = String(serviceMatch[1] || '');
      const serviceType = String(this.extractXmlTagValue(block, 'serviceType') || '').trim();
      const controlURL = String(this.extractXmlTagValue(block, 'controlURL') || '').trim();
      if (serviceType && controlURL) {
        services.push({ serviceType, controlURL });
      }
      serviceMatch = serviceRegex.exec(xml);
    }
    return services;
  }

  private static resolveServiceUrl(location: string, controlUrl: string): string {
    try {
      const baseUrl = new URL(location);
      return new URL(controlUrl, `${baseUrl.protocol}//${baseUrl.host}`).toString();
    } catch (_error) {
      return controlUrl;
    }
  }

  private static getTrackStreamUrlForRenderer(renderer: DlnaRendererDevice, mediaTrackId: string): string {
    const rendererUrl = new URL(renderer.location);
    const rendererAddress = String(rendererUrl.hostname || '').replace(/^::ffff:/, '');
    const servingIp = this.getBestServingIpForClient(rendererAddress);
    return `http://${servingIp}:${this.port}/stream/${encodeURIComponent(mediaTrackId)}`;
  }

  private static getTrackCoverUrlForRenderer(renderer: DlnaRendererDevice, mediaTrackId: string): string {
    const rendererUrl = new URL(renderer.location);
    const rendererAddress = String(rendererUrl.hostname || '').replace(/^::ffff:/, '');
    const servingIp = this.getBestServingIpForClient(rendererAddress);
    return `http://${servingIp}:${this.port}/cover/${encodeURIComponent(mediaTrackId)}`;
  }

  private static buildRendererTrackMetadata(
    mediaTrack: IMediaTrack,
    streamUrl: string,
    metadataMode: 'full' | 'compatibility' = 'full',
  ): string {
    const title = this.escapeXml(String(mediaTrack.track_name || 'Track'));
    const artist = this.escapeXml(String(mediaTrack.track_artists?.map(trackArtist => trackArtist.artist_name).join(', ') || ''));
    const album = this.escapeXml(String(mediaTrack.track_album?.album_name || ''));
    const mimeType = this.getMimeType(String((mediaTrack.extra as any)?.file_path || ''));
    const coverPath = this.getTrackCoverPathFromMediaTrack(mediaTrack);
    const coverMimeType = coverPath ? 'image/jpeg' : '';
    const coverUrl = coverPath
      ? this.getTrackCoverUrlForRenderer(this.getSelectedRenderer() as DlnaRendererDevice, String(mediaTrack.id || mediaTrack.provider_id || ''))
      : '';
    const coverProfile = this.getDlnaImageProfileForMimeType();
    const albumArtAttributes = coverProfile
      ? ` dlna:profileID="${coverProfile}"`
      : '';
    const coverProtocolInfo = coverProfile
      ? `http-get:*:${coverMimeType}:DLNA.ORG_PN=${coverProfile}`
      : `http-get:*:${coverMimeType}:*`;
    const duration = this.formatSecondsAsDlnaTime(Number(mediaTrack.track_duration || 0));
    return `<?xml version="1.0" encoding="utf-8"?>
${this.getDidlRootStart()}
<item id="${this.escapeXml(String(mediaTrack.id || mediaTrack.provider_id || 'track'))}" parentID="0" restricted="1">
<dc:title>${title}</dc:title>
<upnp:artist>${artist}</upnp:artist>
<upnp:album>${album}</upnp:album>
<upnp:class>object.item.audioItem.musicTrack</upnp:class>
${coverUrl ? `<upnp:albumArtURI${albumArtAttributes}>${this.escapeXml(coverUrl)}</upnp:albumArtURI>` : ''}
${coverUrl && coverMimeType && metadataMode === 'full' ? `<res protocolInfo="${coverProtocolInfo}">${this.escapeXml(coverUrl)}</res>` : ''}
<res protocolInfo="http-get:*:${mimeType}:*" duration="${duration}">${this.escapeXml(streamUrl)}</res>
</item>
</DIDL-Lite>`;
  }

  private static getDlnaImageProfileForMimeType(): string {
    return '';
  }

  private static formatSecondsAsDlnaTime(seconds: number): string {
    const totalSeconds = Math.max(0, Math.floor(Number(seconds || 0)));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  private static async sendSoapRequest(
    controlUrl: string,
    serviceType: string,
    actionName: string,
    params: Record<string, string>,
    timeoutMs: number = this.soapRequestTimeoutMs,
  ): Promise<string> {
    const startedAt = Date.now();
    const actionBody = Object.entries(params)
      .map(([key, value]) => `<${key}>${this.escapeXml(String(value || ''))}</${key}>`)
      .join('');
    const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:${actionName} xmlns:u="${serviceType}">
${actionBody}
</u:${actionName}>
</s:Body>
</s:Envelope>`;
    this.writeDlnaLog('info', 'soap_request', {
      actionName,
      serviceType,
      controlUrl,
      timeoutMs,
      params,
      requestBody: this.getLogSnippet(body),
    });

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);
    try {
      const response = await fetch(controlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPACTION: `"${serviceType}#${actionName}"`,
        },
        body,
        signal: abortController.signal,
      });
      const responseBody = await response.text().catch(() => '');
      this.writeDlnaLog('info', 'soap_response', {
        actionName,
        serviceType,
        controlUrl,
        elapsedMs: Date.now() - startedAt,
        status: response.status,
        ok: response.ok,
        responseBody: this.getLogSnippet(responseBody),
      });
      if (!response.ok) {
        throw new Error(`DLNA SOAP ${actionName} failed: HTTP ${response.status}`);
      }
      if (/<(?:\w+:)?Fault>/i.test(responseBody)) {
        this.writeDlnaLog('warn', 'soap_fault_response', {
          actionName,
          serviceType,
          controlUrl,
          elapsedMs: Date.now() - startedAt,
          responseBody: this.getLogSnippet(responseBody),
        });
        throw new Error(`DLNA SOAP ${actionName} fault response`);
      }
      return responseBody;
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        this.writeDlnaLog('error', 'soap_request_timeout', {
          actionName,
          serviceType,
          controlUrl,
          elapsedMs: Date.now() - startedAt,
        });
        throw new Error(`DLNA SOAP ${actionName} timeout`);
      }
      this.writeDlnaLog('error', 'soap_request_failed', {
        actionName,
        serviceType,
        controlUrl,
        elapsedMs: Date.now() - startedAt,
        error: String(error?.message || error || ''),
      });
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private static isSoapHttp500Error(error: any): boolean {
    const errorMessage = String(error?.message || error || '');
    return errorMessage.includes('HTTP 500');
  }

  private static async startRendererPlayback(renderer: DlnaRendererDevice, seekPositionSeconds: number): Promise<boolean> {
    let playSucceeded = await this.sendSoapRequest(
      renderer.avTransportControlUrl,
      renderer.avTransportServiceType,
      'Play',
      {
        InstanceID: '0',
        Speed: '1',
      },
    )
      .then(() => true)
      .catch(() => false);
    if (!playSucceeded) {
      const snapshot = await this.getSelectedRendererSnapshot().catch(() => undefined);
      const transportState = String(snapshot?.transportState || '').toUpperCase();
      playSucceeded = transportState === 'PLAYING' || transportState === 'TRANSITIONING';
    }
    if (!playSucceeded) {
      return false;
    }
    if (seekPositionSeconds > 0) {
      await this.seekSelectedRenderer(seekPositionSeconds).catch(() => false);
    }
    return this.waitForRendererPlaybackStart(seekPositionSeconds);
  }

  private static async waitForRendererPlaybackStart(seekPositionSeconds: number): Promise<boolean> {
    const minPositionSeconds = Math.max(0, Number(seekPositionSeconds || 0) - 1);
    const resolveAttempt = async (
      attempt: number,
      lastKnownPositionSeconds: number,
      consecutivePlayingSnapshots: number,
    ): Promise<boolean> => {
      if (attempt >= 4) {
        this.writeDlnaLog('warn', 'playback_start_verification_timeout', {
          seekPositionSeconds,
          selectedRendererId: this.selectedRendererId,
        });
        return true;
      }
      const snapshot = await this.getSelectedRendererSnapshot().catch(() => undefined);
      const transportState = String(snapshot?.transportState || '').toUpperCase();
      const snapshotPositionSeconds = Number(snapshot?.positionSeconds || 0);
      const hasPosition = Number.isFinite(snapshotPositionSeconds) && snapshotPositionSeconds >= 0;
      const hasForwardProgress = hasPosition && snapshotPositionSeconds > (lastKnownPositionSeconds + 0.25);
      const nextConsecutivePlayingSnapshots = transportState === 'PLAYING'
        || transportState === 'TRANSITIONING'
        ? consecutivePlayingSnapshots + 1
        : 0;
      if (transportState === 'PLAYING' || transportState === 'TRANSITIONING') {
        if (hasPosition && snapshotPositionSeconds >= minPositionSeconds) {
          return true;
        }
        if (hasForwardProgress) {
          return true;
        }
        if (!hasPosition && nextConsecutivePlayingSnapshots >= 2) {
          return true;
        }
      }
      const nextPosition = hasPosition
        ? Math.max(lastKnownPositionSeconds, snapshotPositionSeconds)
        : lastKnownPositionSeconds;
      await this.wait(250);
      return resolveAttempt(attempt + 1, nextPosition, nextConsecutivePlayingSnapshots);
    };
    return resolveAttempt(0, -1, 0);
  }

  private static async applyRendererOutputState(
    renderer: DlnaRendererDevice,
    options?: {
      mediaPlaybackVolume?: number;
      mediaPlaybackMaxVolume?: number;
      muted?: boolean;
    },
  ): Promise<void> {
    const cachedOutputState = this.rendererOutputStateByRendererId.get(renderer.id) || {};
    const nextOutputState = { ...cachedOutputState };
    if (options && Number.isFinite(options.mediaPlaybackVolume)) {
      const maxVolume = Math.max(1, Number(options.mediaPlaybackMaxVolume || 100));
      const targetVolumePercent = Math.max(0, Math.min(100, Math.round((Number(options.mediaPlaybackVolume || 0) / maxVolume) * 100)));
      if (cachedOutputState.volumePercent !== targetVolumePercent) {
        await this.setSelectedRendererVolume(Number(options.mediaPlaybackVolume), maxVolume).catch((error: any) => {
          this.writeDlnaLog('warn', 'set_volume_failed', {
            rendererId: renderer.id,
            rendererName: renderer.friendlyName,
            error: String(error?.message || error || ''),
          });
        });
      }
      nextOutputState.volumePercent = targetVolumePercent;
    }
    if (typeof options?.muted === 'boolean') {
      if (cachedOutputState.muted !== options.muted) {
        if (options.muted) {
          await this.muteSelectedRenderer().catch((error: any) => {
            this.writeDlnaLog('warn', 'mute_failed', {
              rendererId: renderer.id,
              rendererName: renderer.friendlyName,
              error: String(error?.message || error || ''),
            });
          });
        } else {
          await this.unmuteSelectedRenderer().catch((error: any) => {
            this.writeDlnaLog('warn', 'unmute_failed', {
              rendererId: renderer.id,
              rendererName: renderer.friendlyName,
              error: String(error?.message || error || ''),
            });
          });
        }
      }
      nextOutputState.muted = options.muted;
    }
    this.rendererOutputStateByRendererId.set(renderer.id, nextOutputState);
  }

  private static async setRendererTransportUri(
    renderer: DlnaRendererDevice,
    streamUrl: string,
    metadata: string,
    compatibilityMetadata: string,
    phase: 'primary' | 'retry',
  ): Promise<void> {
    const payload = {
      InstanceID: '0',
      CurrentURI: streamUrl,
      CurrentURIMetaData: metadata,
    };
    const compatibilityPayload = {
      InstanceID: '0',
      CurrentURI: streamUrl,
      CurrentURIMetaData: compatibilityMetadata,
    };
    const emptyMetadataPayload = {
      InstanceID: '0',
      CurrentURI: streamUrl,
      CurrentURIMetaData: '',
    };
    try {
      await this.sendSoapRequest(
        renderer.avTransportControlUrl,
        renderer.avTransportServiceType,
        'SetAVTransportURI',
        payload,
        this.transportSetupSoapRequestTimeoutMs,
      );
      return;
    } catch (_error) {
      this.writeDlnaLog('warn', 'set_av_transport_uri_fallback_compatibility', {
        rendererId: renderer.id,
        phase,
      });
    }
    try {
      await this.sendSoapRequest(
        renderer.avTransportControlUrl,
        renderer.avTransportServiceType,
        'SetAVTransportURI',
        compatibilityPayload,
        this.transportSetupSoapRequestTimeoutMs,
      );
      return;
    } catch (_error) {
      this.writeDlnaLog('warn', 'set_av_transport_uri_fallback_empty_metadata', {
        rendererId: renderer.id,
        phase,
      });
    }
    await this.sendSoapRequest(
      renderer.avTransportControlUrl,
      renderer.avTransportServiceType,
      'SetAVTransportURI',
      emptyMetadataPayload,
      this.transportSetupSoapRequestTimeoutMs,
    );
  }

  private static async setRendererNextTransportUri(
    renderer: DlnaRendererDevice,
    streamUrl: string,
    metadata: string,
    compatibilityMetadata: string,
  ): Promise<boolean> {
    const payload = {
      InstanceID: '0',
      NextURI: streamUrl,
      NextURIMetaData: metadata,
    };
    const compatibilityPayload = {
      InstanceID: '0',
      NextURI: streamUrl,
      NextURIMetaData: compatibilityMetadata,
    };
    const emptyMetadataPayload = {
      InstanceID: '0',
      NextURI: streamUrl,
      NextURIMetaData: '',
    };
    try {
      await this.sendSoapRequest(
        renderer.avTransportControlUrl,
        renderer.avTransportServiceType,
        'SetNextAVTransportURI',
        payload,
        this.transportSetupSoapRequestTimeoutMs,
      );
      return true;
    } catch (_error) {
      this.writeDlnaLog('warn', 'set_next_uri_fallback_compatibility', {
        rendererId: renderer.id,
      });
    }
    try {
      await this.sendSoapRequest(
        renderer.avTransportControlUrl,
        renderer.avTransportServiceType,
        'SetNextAVTransportURI',
        compatibilityPayload,
        this.transportSetupSoapRequestTimeoutMs,
      );
      return true;
    } catch (_error) {
      this.writeDlnaLog('warn', 'set_next_uri_fallback_empty_metadata', {
        rendererId: renderer.id,
      });
    }
    try {
      await this.sendSoapRequest(
        renderer.avTransportControlUrl,
        renderer.avTransportServiceType,
        'SetNextAVTransportURI',
        emptyMetadataPayload,
        this.transportSetupSoapRequestTimeoutMs,
      );
      return true;
    } catch (error: any) {
      this.writeDlnaLog('error', 'set_next_uri_failed', {
        rendererId: renderer.id,
        error: String(error?.message || error || ''),
      });
      return false;
    }
  }

  private static updateRendererOutputCache(rendererId: string, outputState: { volumePercent?: number; muted?: boolean }) {
    const cachedOutputState = this.rendererOutputStateByRendererId.get(rendererId) || {};
    this.rendererOutputStateByRendererId.set(rendererId, {
      ...cachedOutputState,
      ...outputState,
    });
  }

  private static wait(waitMs: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, waitMs);
    });
  }

  private static registerUiSettingsListener() {
    if (this.uiSettingsListenerRegistered) {
      return;
    }
    this.uiSettingsListenerRegistered = true;
    window.addEventListener(this.uiSettingsChangedEventName, () => {
      this.invalidateBrowseLibrary();
      if (this.enabled) {
        this.refreshBrowseLibrary().catch((error) => {
          debug('refreshBrowseLibrary after UI setting change failed - %o', error);
        });
      }
    });
  }

  private static async startServer() {
    if (this.httpServer) {
      this.emitState();
      return;
    }

    this.lastError = undefined;
    try {
      this.httpServer = http.createServer((request, response) => {
        this.handleHttpRequest(request, response);
      });
      await new Promise<void>((resolve, reject) => {
        this.httpServer?.once('error', reject);
        this.httpServer?.listen(this.port, '0.0.0.0', () => {
          this.httpServer?.off('error', reject);
          resolve();
        });
      });
      this.startSsdpBroadcast();
      this.refreshBrowseLibrary().catch((error) => {
        debug('refreshBrowseLibrary initial call failed - %o', error);
      });
    } catch (error: any) {
      this.lastError = String(error?.message || error);
      debug('startServer failed - %o', error);
      await this.stopServer();
    }
    this.emitState();
  }

  private static async stopServer() {
    this.sendSsdpByeBye();
    if (this.ssdpInterval) {
      clearInterval(this.ssdpInterval);
      this.ssdpInterval = undefined;
    }
    if (this.ssdpSocket) {
      try {
        this.ssdpSocket.close();
      } catch (error) {
        debug('stopServer close ssdp failed - %o', error);
      }
      this.ssdpSocket = undefined;
    }
    if (this.httpServer) {
      const serverRef = this.httpServer;
      this.httpServer = undefined;
      await new Promise<void>((resolve) => {
        serverRef.close(() => resolve());
      });
    }
  }

  private static startSsdpBroadcast() {
    if (this.ssdpSocket) {
      return;
    }

    this.ssdpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.ssdpSocket.on('error', (error) => {
      this.lastError = String(error?.message || error);
      this.emitState();
    });
    this.ssdpSocket.on('message', (message, remote) => {
      this.handleSsdpMessage(message.toString(), remote.address, remote.port);
    });
    this.ssdpSocket.bind(this.multicastPort, () => {
      try {
        this.ssdpSocket?.addMembership(this.multicastIp);
      } catch (error) {
        debug('startSsdpBroadcast addMembership failed - %o', error);
      }
      this.ssdpSocket?.setMulticastTTL(2);
      this.ssdpSocket?.setMulticastLoopback(false);
      this.sendSsdpNotify();
      this.ssdpInterval = setInterval(() => {
        this.sendSsdpNotify();
      }, this.notifyIntervalMs);
    });
  }

  private static handleSsdpMessage(message: string, address: string, port: number) {
    const normalizedMessage = message.toUpperCase();
    if (!normalizedMessage.includes('M-SEARCH') || !normalizedMessage.includes('SSDP:DISCOVER')) {
      return;
    }
    const searchTarget = this.extractSsdpHeaderValue(message, 'ST') || 'ssdp:all';
    const searchTargetNormalized = searchTarget.toLowerCase();
    const supportedTargets = [
      'ssdp:all',
      'upnp:rootdevice',
      this.rootDeviceUdn.toLowerCase(),
      this.serviceType.toLowerCase(),
      this.contentDirectoryServiceType.toLowerCase(),
      this.connectionManagerServiceType.toLowerCase(),
    ];
    if (!supportedTargets.includes(searchTargetNormalized)) {
      return;
    }
    const location = this.getDescriptionUrlForClient(address);
    const responseTargets = searchTargetNormalized === 'ssdp:all'
      ? [
        'upnp:rootdevice',
        this.rootDeviceUdn,
        this.serviceType,
        this.contentDirectoryServiceType,
        this.connectionManagerServiceType,
      ]
      : [searchTarget];
    responseTargets.forEach((responseTarget) => {
      this.sendSsdpSearchResponse(responseTarget, location, address, port);
    });
  }

  private static sendSsdpSearchResponse(responseTarget: string, location: string, address: string, port: number) {
    const responseTargetNormalized = responseTarget.toLowerCase();
    let responseUsn = this.usn;
    if (responseTargetNormalized === 'upnp:rootdevice') {
      responseUsn = `${this.rootDeviceUdn}::upnp:rootdevice`;
    } else if (responseTargetNormalized === this.rootDeviceUdn.toLowerCase()) {
      responseUsn = this.rootDeviceUdn;
    } else if (
      responseTargetNormalized === this.contentDirectoryServiceType.toLowerCase()
      || responseTargetNormalized === this.connectionManagerServiceType.toLowerCase()
    ) {
      responseUsn = `${this.rootDeviceUdn}::${responseTarget}`;
    }
    const responseLines = [
      'HTTP/1.1 200 OK',
      `CACHE-CONTROL: max-age=${this.ssdpMaxAgeSeconds}`,
      'EXT:',
      `LOCATION: ${location}`,
      'BOOTID.UPNP.ORG: 1',
      'CONFIGID.UPNP.ORG: 1',
      'SERVER: AuroraPulse/2.0 UPnP/1.1 DLNADOC/1.50',
      `ST: ${responseTarget}`,
      `USN: ${responseUsn}`,
      '\r\n',
    ];
    this.ssdpSocket?.send(responseLines.join('\r\n'), port, address);
  }

  private static sendSsdpNotify() {
    const notificationDefinitions = [
      {
        nt: 'upnp:rootdevice',
        usn: `${this.rootDeviceUdn}::upnp:rootdevice`,
      },
      {
        nt: this.rootDeviceUdn,
        usn: this.rootDeviceUdn,
      },
      {
        nt: this.serviceType,
        usn: this.usn,
      },
      {
        nt: this.contentDirectoryServiceType,
        usn: `${this.rootDeviceUdn}::${this.contentDirectoryServiceType}`,
      },
      {
        nt: this.connectionManagerServiceType,
        usn: `${this.rootDeviceUdn}::${this.connectionManagerServiceType}`,
      },
    ];
    this.getIpAddresses().forEach((ipAddress) => {
      const location = this.getDescriptionUrlForIp(ipAddress);
      notificationDefinitions.forEach((definition) => {
        const notifyLines = [
          'NOTIFY * HTTP/1.1',
          `HOST: ${this.multicastIp}:${this.multicastPort}`,
          `CACHE-CONTROL: max-age=${this.ssdpMaxAgeSeconds}`,
          `LOCATION: ${location}`,
          `NT: ${definition.nt}`,
          'NTS: ssdp:alive',
          'BOOTID.UPNP.ORG: 1',
          'CONFIGID.UPNP.ORG: 1',
          'SERVER: AuroraPulse/2.0 UPnP/1.1 DLNADOC/1.50',
          `USN: ${definition.usn}`,
          '\r\n',
        ];
        this.ssdpSocket?.send(notifyLines.join('\r\n'), this.multicastPort, this.multicastIp);
      });
    });
  }

  private static sendSsdpByeBye() {
    if (!this.ssdpSocket) {
      return;
    }
    const notificationDefinitions = [
      {
        nt: 'upnp:rootdevice',
        usn: `${this.rootDeviceUdn}::upnp:rootdevice`,
      },
      {
        nt: this.rootDeviceUdn,
        usn: this.rootDeviceUdn,
      },
      {
        nt: this.serviceType,
        usn: this.usn,
      },
      {
        nt: this.contentDirectoryServiceType,
        usn: `${this.rootDeviceUdn}::${this.contentDirectoryServiceType}`,
      },
      {
        nt: this.connectionManagerServiceType,
        usn: `${this.rootDeviceUdn}::${this.connectionManagerServiceType}`,
      },
    ];
    notificationDefinitions.forEach((definition) => {
      const byebyeLines = [
        'NOTIFY * HTTP/1.1',
        `HOST: ${this.multicastIp}:${this.multicastPort}`,
        `NT: ${definition.nt}`,
        'NTS: ssdp:byebye',
        `USN: ${definition.usn}`,
        '\r\n',
      ];
      this.ssdpSocket?.send(byebyeLines.join('\r\n'), this.multicastPort, this.multicastIp);
    });
  }

  private static getDescriptionUrlForIp(ipAddress: string) {
    return `http://${ipAddress}:${this.port}/description.xml`;
  }

  private static getDescriptionUrlForClient(clientAddress: string) {
    const ipAddresses = this.getIpAddresses();
    const matchingSubnetIp = ipAddresses.find(ipAddress => this.hasSameIPv4Subnet(ipAddress, clientAddress));
    return this.getDescriptionUrlForIp(matchingSubnetIp || ipAddresses[0] || '127.0.0.1');
  }

  private static handleHttpRequest(request: IncomingMessage, response: ServerResponse) {
    const requestUrl = String(request.url || '/');
    const requestPath = this.getRequestPath(requestUrl);
    this.writeDlnaLog('info', 'http_request_received', {
      method: String(request.method || 'GET').toUpperCase(),
      path: requestPath,
      rawUrl: requestUrl,
      userAgent: String(request.headers['user-agent'] || ''),
      range: String(request.headers.range || ''),
      host: String(request.headers.host || ''),
    });
    if (requestPath === '/description.xml') {
      this.writeXml(response, this.getDescriptionXml());
      return;
    }
    if (requestPath === '/upnp/content-directory.xml') {
      this.writeXml(response, this.getContentDirectoryScpdXml());
      return;
    }
    if (requestPath === '/upnp/connection-manager.xml') {
      this.writeXml(response, this.getConnectionManagerScpdXml());
      return;
    }
    if (requestPath === '/upnp/control/content-directory') {
      this.handleContentDirectoryControlRequest(request, response);
      return;
    }
    if (requestPath === '/upnp/control/connection-manager') {
      this.handleConnectionManagerControlRequest(request, response);
      return;
    }
    if (requestPath === '/content.xml') {
      this.writeXml(response, this.getContentXml());
      return;
    }
    if (requestPath === '/status.json') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(this.getState()));
      return;
    }
    if (requestPath.startsWith('/stream/')) {
      const trackId = decodeURIComponent(requestPath.replace('/stream/', ''));
      this.streamTrack(response, request, trackId === 'current' ? this.currentTrackId : trackId).catch((error) => {
        debug('streamTrack failed - %o', error);
        if (!response.headersSent) {
          response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('Stream failed');
        }
      });
      return;
    }
    if (requestPath.startsWith('/cover/')) {
      const trackId = decodeURIComponent(requestPath.replace('/cover/', ''));
      this.streamTrackCover(response, request, trackId === 'current' ? this.currentTrackId : trackId).catch((error) => {
        debug('streamTrackCover failed - %o', error);
        if (!response.headersSent) {
          response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('Cover failed');
        }
      });
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }

  private static writeXml(response: ServerResponse, xml: string) {
    response.writeHead(200, {
      'Content-Type': 'application/xml; charset="utf-8"',
      'Cache-Control': 'no-cache',
    });
    response.end(xml);
  }

  private static async streamTrack(response: ServerResponse, request: IncomingMessage, trackId?: string) {
    if (!trackId) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('No track selected');
      return;
    }

    const track = await this.resolveStreamTrack(trackId);
    if (!track || !fs.existsSync(track.filePath)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Track not available');
      return;
    }

    const rangeHeader = String(request.headers.range || '');
    let startByte = 0;
    let endByte = Math.max(0, track.fileSize - 1);

    if (rangeHeader.startsWith('bytes=')) {
      const [rangeStart, rangeEnd] = rangeHeader.replace('bytes=', '').split('-');
      const parsedStart = Number(rangeStart);
      const parsedEnd = Number(rangeEnd);
      if (Number.isFinite(parsedStart) && parsedStart >= 0) {
        startByte = parsedStart;
      }
      if (Number.isFinite(parsedEnd) && parsedEnd >= startByte) {
        endByte = parsedEnd;
      }
      endByte = Math.min(endByte, Math.max(0, track.fileSize - 1));
    }

    const contentLength = Math.max(0, (endByte - startByte) + 1);
    const partial = rangeHeader.startsWith('bytes=');
    response.writeHead(partial ? 206 : 200, {
      'Content-Type': track.mimeType,
      'Accept-Ranges': 'bytes',
      'Content-Length': contentLength,
      ...(partial ? { 'Content-Range': `bytes ${startByte}-${endByte}/${track.fileSize}` } : {}),
      'transferMode.dlna.org': 'Streaming',
      'contentFeatures.dlna.org': 'DLNA.ORG_OP=01',
      'Cache-Control': 'no-cache',
    });
    if (String(request.method || 'GET').toUpperCase() === 'HEAD') {
      response.end();
      return;
    }
    const stream = fs.createReadStream(track.filePath, {
      start: startByte,
      end: endByte,
      highWaterMark: this.bufferBytes,
    });
    stream.once('error', () => {
      response.destroy();
    });
    stream.pipe(response);
  }

  private static async streamTrackCover(response: ServerResponse, request: IncomingMessage, trackId?: string) {
    if (!trackId) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('No track selected');
      return;
    }
    const track = await this.resolveStreamTrack(trackId);
    const coverPath = String(track?.coverPath || '').trim();
    if (!coverPath || !fs.existsSync(coverPath)) {
      this.writeDlnaLog('warn', 'cover_not_available', {
        trackId,
        hasTrack: !!track,
      });
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Cover not available');
      return;
    }
    let coverBuffer = fs.readFileSync(coverPath);
    let coverMimeType = track?.coverMimeType || this.getImageMimeType(coverPath);
    if (coverMimeType !== 'image/jpeg' && coverMimeType !== 'image/jpg') {
      try {
        coverBuffer = await sharp(coverBuffer)
          .jpeg({
            quality: 88,
            mozjpeg: true,
          })
          .toBuffer();
        coverMimeType = 'image/jpeg';
      } catch (error) {
        debug('streamTrackCover sharp conversion failed - %o', error);
        this.writeDlnaLog('error', 'cover_sharp_conversion_failed', {
          trackId,
          coverPath,
          error: String((error as any)?.message || error || ''),
        });
      }
    }
    const coverProfile = this.getDlnaImageProfileForMimeType();
    const coverContentFeatures = coverProfile
      ? `DLNA.ORG_PN=${coverProfile};DLNA.ORG_OP=01`
      : 'DLNA.ORG_OP=01';
    const rangeHeader = String(request.headers.range || '');
    const totalLength = coverBuffer.byteLength;
    let startByte = 0;
    let endByte = Math.max(0, totalLength - 1);
    if (rangeHeader.startsWith('bytes=')) {
      const [rangeStart, rangeEnd] = rangeHeader.replace('bytes=', '').split('-');
      const parsedStart = Number(rangeStart);
      const parsedEnd = Number(rangeEnd);
      if (Number.isFinite(parsedStart) && parsedStart >= 0) {
        startByte = Math.floor(parsedStart);
      }
      if (Number.isFinite(parsedEnd) && parsedEnd >= startByte) {
        endByte = Math.floor(parsedEnd);
      }
      endByte = Math.min(endByte, Math.max(0, totalLength - 1));
    }
    const partial = rangeHeader.startsWith('bytes=');
    const contentLength = Math.max(0, (endByte - startByte) + 1);
    response.writeHead(partial ? 206 : 200, {
      'Content-Type': coverMimeType,
      'Content-Length': contentLength,
      'Accept-Ranges': 'bytes',
      ...(partial ? { 'Content-Range': `bytes ${startByte}-${endByte}/${totalLength}` } : {}),
      'transferMode.dlna.org': 'Streaming',
      'contentFeatures.dlna.org': coverContentFeatures,
      'Cache-Control': 'public, max-age=3600',
    });
    if (String(request.method || 'GET').toUpperCase() === 'HEAD') {
      response.end();
      return;
    }
    response.end(coverBuffer.subarray(startByte, endByte + 1));
  }

  private static getDlnaLogPath(): string | undefined {
    if (this.dlnaLogPathCache) {
      return this.dlnaLogPathCache;
    }
    try {
      const rendererLogPath = String(AppService.details.logs_path || '').trim();
      const logsDir = rendererLogPath ? path.dirname(rendererLogPath) : '';
      if (!logsDir) {
        return undefined;
      }
      fs.mkdirSync(logsDir, { recursive: true });
      this.dlnaLogPathCache = path.join(logsDir, this.dlnaLogFileName);
      return this.dlnaLogPathCache;
    } catch (_error) {
      return undefined;
    }
  }

  private static writeDlnaLog(level: 'info' | 'warn' | 'error', event: string, details?: Record<string, any>) {
    try {
      const logPath = this.getDlnaLogPath();
      if (!logPath) {
        return;
      }
      const logLine = JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        outputMode: this.outputMode,
        selectedRendererId: this.selectedRendererId,
        details: details || {},
      });
      fs.appendFileSync(logPath, `${logLine}\n`, {
        encoding: 'utf8',
      });
    } catch (error) {
      debug('writeDlnaLog failed - %o', error);
    }
  }

  private static getLogSnippet(value: any, maxLength: number = 1800): string {
    const normalizedValue = String(value || '');
    if (normalizedValue.length <= maxLength) {
      return normalizedValue;
    }
    return `${normalizedValue.slice(0, maxLength)}…(truncated)`;
  }

  private static async waitForSelectedRendererTransportState(options: {
    allowedStates: string[];
    timeoutMs?: number;
    pollMs?: number;
  }): Promise<string | undefined> {
    const timeoutMs = Math.max(250, Number(options.timeoutMs || 2000));
    const pollMs = Math.max(100, Number(options.pollMs || 250));
    const allowedStates = new Set((options.allowedStates || []).map(state => String(state || '').toUpperCase()));
    const stopAt = Date.now() + timeoutMs;
    const poll = async (): Promise<string | undefined> => {
      if (Date.now() > stopAt) {
        return undefined;
      }
      const transportState = await this.getSelectedRendererTransportState().catch(() => '');
      if (allowedStates.has(transportState)) {
        return transportState;
      }
      await this.wait(pollMs);
      return poll();
    };
    return poll();
  }

  private static async getSelectedRendererTransportState(): Promise<string> {
    const renderer = this.getSelectedRenderer();
    if (!renderer) {
      return '';
    }
    const transportInfoResponse = await this.sendSoapRequest(
      renderer.avTransportControlUrl,
      renderer.avTransportServiceType,
      'GetTransportInfo',
      {
        InstanceID: '0',
      },
    ).catch(() => '');
    return String(this.extractXmlTagValue(transportInfoResponse, 'CurrentTransportState') || '').toUpperCase();
  }

  private static getDescriptionXml() {
    const ipAddress = this.getIpAddresses()[0] || '127.0.0.1';
    const baseUrl = `http://${ipAddress}:${this.port}`;
    const friendlyName = this.escapeXml(this.getState().friendlyName);
    return `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
<specVersion><major>1</major><minor>0</minor></specVersion>
<URLBase>${baseUrl}</URLBase>
<device>
<deviceType>${this.serviceType}</deviceType>
<friendlyName>${friendlyName}</friendlyName>
<manufacturer>Aurora Pulse</manufacturer>
<modelName>Aurora DLNA Media Server</modelName>
<modelNumber>2.0.0</modelNumber>
<serialNumber>aurora-pulse-dlna</serialNumber>
<UDN>${this.rootDeviceUdn}</UDN>
<serviceList>
<service>
<serviceType>${this.contentDirectoryServiceType}</serviceType>
<serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
<controlURL>/upnp/control/content-directory</controlURL>
<eventSubURL>/upnp/event/content-directory</eventSubURL>
<SCPDURL>/upnp/content-directory.xml</SCPDURL>
</service>
<service>
<serviceType>${this.connectionManagerServiceType}</serviceType>
<serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
<controlURL>/upnp/control/connection-manager</controlURL>
<eventSubURL>/upnp/event/connection-manager</eventSubURL>
<SCPDURL>/upnp/connection-manager.xml</SCPDURL>
</service>
</serviceList>
</device>
</root>`;
  }

  private static getContentXml() {
    const ipAddress = this.getIpAddresses()[0] || '127.0.0.1';
    const baseUrl = `http://${ipAddress}:${this.port}`;
    const items = this.trackOrder
      .map((trackId, index) => {
        const track = this.trackMap.get(trackId);
        if (!track) {
          return '';
        }
        const durationSeconds = Math.max(0, Math.floor(track.duration));
        const hours = Math.floor(durationSeconds / 3600);
        const minutes = Math.floor((durationSeconds % 3600) / 60);
        const seconds = durationSeconds % 60;
        const duration = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.000`;
        const streamUrl = `${baseUrl}/stream/${encodeURIComponent(track.id)}`;
        return `<item id="${index + 1}" parentID="0" restricted="1">
<dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">${this.escapeXml(track.title)}</dc:title>
<upnp:artist xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${this.escapeXml(track.artist)}</upnp:artist>
<upnp:album xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${this.escapeXml(track.album)}</upnp:album>
<res protocolInfo="http-get:*:${track.mimeType}:*" size="${track.fileSize}" duration="${duration}">${this.escapeXml(streamUrl)}</res>
</item>`;
      })
      .filter(Boolean)
      .join('');
    return `<?xml version="1.0" encoding="utf-8"?>
<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"
xmlns:dc="http://purl.org/dc/elements/1.1/"
xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"
xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">
${items}
</DIDL-Lite>`;
  }

  private static getIpAddresses() {
    const interfaces = os.networkInterfaces();
    return Object.values(interfaces)
      .flatMap(interfaceEntries => interfaceEntries || [])
      .filter(entry => entry.family === 'IPv4' && !entry.internal)
      .map(entry => entry.address);
  }

  private static extractSsdpHeaderValue(message: string, headerName: string) {
    const match = message.match(new RegExp(`^${headerName}\\s*:\\s*(.+)$`, 'im'));
    if (!match) {
      return '';
    }
    return String(match[1] || '').trim();
  }

  private static hasSameIPv4Subnet(firstAddress: string, secondAddress: string) {
    const firstParts = firstAddress.split('.').map(Number);
    const secondParts = secondAddress.split('.').map(Number);
    if (firstParts.length !== 4 || secondParts.length !== 4) {
      return false;
    }
    return firstParts[0] === secondParts[0]
      && firstParts[1] === secondParts[1]
      && firstParts[2] === secondParts[2];
  }

  private static getRequestPath(requestUrl: string) {
    try {
      return new URL(requestUrl, 'http://127.0.0.1').pathname;
    } catch (_error) {
      const [pathWithoutQuery] = requestUrl.split('?');
      return pathWithoutQuery || '/';
    }
  }

  private static getMimeType(filePath: string) {
    const extension = path.extname(filePath).toLowerCase();
    if (extension === '.flac') {
      return 'audio/flac';
    }
    if (extension === '.wav') {
      return 'audio/wav';
    }
    if (extension === '.aiff' || extension === '.aif' || extension === '.aifc') {
      return 'audio/aiff';
    }
    if (extension === '.m4a' || extension === '.mp4') {
      return 'audio/mp4';
    }
    if (extension === '.ogg') {
      return 'audio/ogg';
    }
    if (extension === '.dsf') {
      return 'audio/x-dsf';
    }
    if (extension === '.dff') {
      return 'audio/x-dff';
    }
    return 'audio/mpeg';
  }

  private static escapeXml(value: string) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private static getContentDirectoryScpdXml() {
    return `<?xml version="1.0"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
<specVersion><major>1</major><minor>0</minor></specVersion>
<actionList>
<action>
<name>Browse</name>
<argumentList>
<argument><name>ObjectID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable></argument>
<argument><name>BrowseFlag</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_BrowseFlag</relatedStateVariable></argument>
<argument><name>Filter</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Filter</relatedStateVariable></argument>
<argument><name>StartingIndex</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Index</relatedStateVariable></argument>
<argument><name>RequestedCount</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
<argument><name>SortCriteria</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SortCriteria</relatedStateVariable></argument>
<argument><name>Result</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable></argument>
<argument><name>NumberReturned</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
<argument><name>TotalMatches</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
<argument><name>UpdateID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable></argument>
</argumentList>
</action>
<action>
<name>GetSearchCapabilities</name>
<argumentList>
<argument><name>SearchCaps</name><direction>out</direction><relatedStateVariable>SearchCapabilities</relatedStateVariable></argument>
</argumentList>
</action>
<action>
<name>GetSortCapabilities</name>
<argumentList>
<argument><name>SortCaps</name><direction>out</direction><relatedStateVariable>SortCapabilities</relatedStateVariable></argument>
</argumentList>
</action>
<action><name>GetSystemUpdateID</name><argumentList><argument><name>Id</name><direction>out</direction><relatedStateVariable>SystemUpdateID</relatedStateVariable></argument></argumentList></action>
</actionList>
<serviceStateTable>
<stateVariable sendEvents="no"><name>A_ARG_TYPE_ObjectID</name><dataType>string</dataType></stateVariable>
<stateVariable sendEvents="no"><name>A_ARG_TYPE_BrowseFlag</name><dataType>string</dataType></stateVariable>
<stateVariable sendEvents="no"><name>A_ARG_TYPE_Filter</name><dataType>string</dataType></stateVariable>
<stateVariable sendEvents="no"><name>A_ARG_TYPE_Index</name><dataType>ui4</dataType></stateVariable>
<stateVariable sendEvents="no"><name>A_ARG_TYPE_Count</name><dataType>ui4</dataType></stateVariable>
<stateVariable sendEvents="no"><name>A_ARG_TYPE_SortCriteria</name><dataType>string</dataType></stateVariable>
<stateVariable sendEvents="no"><name>A_ARG_TYPE_Result</name><dataType>string</dataType></stateVariable>
<stateVariable sendEvents="no"><name>A_ARG_TYPE_UpdateID</name><dataType>ui4</dataType></stateVariable>
<stateVariable sendEvents="no"><name>SearchCapabilities</name><dataType>string</dataType></stateVariable>
<stateVariable sendEvents="no"><name>SortCapabilities</name><dataType>string</dataType></stateVariable>
<stateVariable sendEvents="yes"><name>SystemUpdateID</name><dataType>ui4</dataType></stateVariable>
</serviceStateTable>
</scpd>`;
  }

  private static getConnectionManagerScpdXml() {
    return `<?xml version="1.0"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
<specVersion><major>1</major><minor>0</minor></specVersion>
<actionList>
<action>
<name>GetProtocolInfo</name>
<argumentList>
<argument><name>Source</name><direction>out</direction><relatedStateVariable>SourceProtocolInfo</relatedStateVariable></argument>
<argument><name>Sink</name><direction>out</direction><relatedStateVariable>SinkProtocolInfo</relatedStateVariable></argument>
</argumentList>
</action>
</actionList>
<serviceStateTable>
<stateVariable sendEvents="no"><name>SourceProtocolInfo</name><dataType>string</dataType></stateVariable>
<stateVariable sendEvents="no"><name>SinkProtocolInfo</name><dataType>string</dataType></stateVariable>
</serviceStateTable>
</scpd>`;
  }

  private static handleContentDirectoryControlRequest(request: IncomingMessage, response: ServerResponse) {
    this.readRequestBody(request)
      .then(async (body) => {
        const soapAction = String(request.headers.soapaction || '').replace(/"/g, '').toLowerCase();
        if (soapAction.includes('#getsearchcapabilities')) {
          this.writeSoapResponse(response, 'u:GetSearchCapabilitiesResponse', this.contentDirectoryServiceType, '<SearchCaps></SearchCaps>');
          return;
        }
        if (soapAction.includes('#getsortcapabilities')) {
          this.writeSoapResponse(response, 'u:GetSortCapabilitiesResponse', this.contentDirectoryServiceType, '<SortCaps></SortCaps>');
          return;
        }
        if (soapAction.includes('#getsystemupdateid')) {
          this.writeSoapResponse(response, 'u:GetSystemUpdateIDResponse', this.contentDirectoryServiceType, `<Id>${this.systemUpdateId}</Id>`);
          return;
        }

        const objectId = this.decodeXmlEntities(this.extractXmlTagValue(body, 'ObjectID') || '0');
        const browseFlag = this.decodeXmlEntities(this.extractXmlTagValue(body, 'BrowseFlag') || 'BrowseDirectChildren');
        const startingIndex = Number(this.extractXmlTagValue(body, 'StartingIndex') || 0);
        const requestedCount = Number(this.extractXmlTagValue(body, 'RequestedCount') || 0);
        const browseLibrary = await this.getBrowseLibrary();
        const clientAddress = String(request.socket.remoteAddress || '').replace(/^::ffff:/, '');
        const browseResult = this.buildBrowseResult(
          browseLibrary,
          objectId,
          browseFlag,
          startingIndex,
          requestedCount,
          clientAddress,
        );
        const resultPayload = [
          `<Result>${this.escapeXml(browseResult.resultXml)}</Result>`,
          `<NumberReturned>${browseResult.numberReturned}</NumberReturned>`,
          `<TotalMatches>${browseResult.totalMatches}</TotalMatches>`,
          `<UpdateID>${this.systemUpdateId}</UpdateID>`,
        ].join('');
        this.writeSoapResponse(response, 'u:BrowseResponse', this.contentDirectoryServiceType, resultPayload);
      })
      .catch((error) => {
        debug('handleContentDirectoryControlRequest failed - %o', error);
        this.writeSoapResponse(response, 'u:BrowseResponse', this.contentDirectoryServiceType, [
          '<Result></Result>',
          '<NumberReturned>0</NumberReturned>',
          '<TotalMatches>0</TotalMatches>',
          `<UpdateID>${this.systemUpdateId}</UpdateID>`,
        ].join(''));
      });
  }

  private static handleConnectionManagerControlRequest(request: IncomingMessage, response: ServerResponse) {
    this.readRequestBody(request)
      .then(() => {
        const sourceProtocols = [
          'http-get:*:audio/mpeg:*',
          'http-get:*:audio/flac:*',
          'http-get:*:audio/wav:*',
          'http-get:*:audio/mp4:*',
          'http-get:*:audio/ogg:*',
          'http-get:*:audio/x-dsf:*',
          'http-get:*:audio/x-dff:*',
        ].join(',');
        const payload = [
          `<Source>${this.escapeXml(sourceProtocols)}</Source>`,
          '<Sink></Sink>',
        ].join('');
        this.writeSoapResponse(response, 'u:GetProtocolInfoResponse', this.connectionManagerServiceType, payload);
      })
      .catch((error) => {
        debug('handleConnectionManagerControlRequest failed - %o', error);
        this.writeSoapResponse(response, 'u:GetProtocolInfoResponse', this.connectionManagerServiceType, '<Source></Source><Sink></Sink>');
      });
  }

  private static writeSoapResponse(response: ServerResponse, actionName: string, serviceType: string, actionBody: string) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<${actionName} xmlns:u="${serviceType}">
${actionBody}
</${actionName}>
</s:Body>
</s:Envelope>`;
    response.writeHead(200, {
      'Content-Type': 'text/xml; charset="utf-8"',
      'Cache-Control': 'no-cache',
      EXT: '',
    });
    response.end(body);
  }

  private static readRequestBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      request.on('end', () => {
        resolve(body);
      });
      request.on('error', reject);
    });
  }

  private static extractXmlTagValue(xml: string, tagName: string) {
    const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i'));
    if (!match) {
      return '';
    }
    return String(match[1] || '');
  }

  private static parseDlnaTimeToSeconds(value: string): number | undefined {
    const match = String(value || '').trim().match(/^(\d{2,}):(\d{2}):(\d{2})(?:\.\d+)?$/);
    if (!match) {
      return undefined;
    }
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
      return undefined;
    }
    return (hours * 3600) + (minutes * 60) + seconds;
  }

  private static decodeXmlEntities(value: string) {
    return String(value || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, '\'')
      .replace(/&amp;/g, '&');
  }

  private static buildBrowseResult(
    browseLibrary: DlnaBrowseLibrary,
    objectId: string,
    browseFlag: string,
    startingIndex: number,
    requestedCount: number,
    clientAddress = '',
  ) {
    const id = this.normalizeBrowseObjectId(objectId);
    const directChildren = browseFlag === 'BrowseDirectChildren';
    const hasArtistsContainer = browseLibrary.artistViewMode !== 'off';
    if (id === '0' && directChildren) {
      const artistsContainerXml = hasArtistsContainer
        ? `<container id="artists" parentID="0" restricted="1" searchable="0">
<dc:title>Artists</dc:title>
<upnp:class>object.container.person.musicArtist</upnp:class>
</container>`
        : '';
      const xml = `<?xml version="1.0" encoding="utf-8"?>
${this.getDidlRootStart()}
<container id="tracks" parentID="0" restricted="1" searchable="0">
<dc:title>Tracks</dc:title>
<upnp:class>object.container</upnp:class>
</container>
<container id="albums" parentID="0" restricted="1" searchable="0">
<dc:title>Albums</dc:title>
<upnp:class>object.container.album.musicAlbum</upnp:class>
</container>
${artistsContainerXml}
<container id="playlists" parentID="0" restricted="1" searchable="0">
<dc:title>Playlists</dc:title>
<upnp:class>object.container.playlistContainer</upnp:class>
</container>
<container id="podcasts" parentID="0" restricted="1" searchable="0">
<dc:title>Podcasts</dc:title>
<upnp:class>object.container</upnp:class>
</container>
</DIDL-Lite>`;
      return {
        resultXml: xml,
        numberReturned: hasArtistsContainer ? 5 : 4,
        totalMatches: hasArtistsContainer ? 5 : 4,
      };
    }

    if (id === 'tracks' && directChildren) {
      const allTracks = browseLibrary.tracks;
      const start = Math.max(0, Number.isFinite(startingIndex) ? startingIndex : 0);
      const count = requestedCount > 0 ? requestedCount : allTracks.length;
      const pagedTracks = allTracks.slice(start, start + count);
      const itemsXml = pagedTracks.map(track => this.buildTrackDidlItem(track, 'tracks', clientAddress)).join('');
      const xml = `<?xml version="1.0" encoding="utf-8"?>
${this.getDidlRootStart()}
${itemsXml}
</DIDL-Lite>`;
      return {
        resultXml: xml,
        numberReturned: pagedTracks.length,
        totalMatches: allTracks.length,
      };
    }

    if (id === 'albums' && directChildren) {
      const allAlbums = browseLibrary.albums;
      const pagedAlbums = this.slicePagedEntries(allAlbums, startingIndex, requestedCount);
      const itemsXml = pagedAlbums.map(album => this.buildAlbumDidlContainer(album)).join('');
      return this.buildDidlResult(itemsXml, pagedAlbums.length, allAlbums.length);
    }

    if (id.startsWith('album:') && directChildren) {
      const albumId = id.replace('album:', '');
      const albumTracks = browseLibrary.tracks.filter(trackEntry => trackEntry.albumId === albumId);
      const pagedTracks = this.slicePagedEntries(albumTracks, startingIndex, requestedCount);
      const itemsXml = pagedTracks.map(track => this.buildTrackDidlItem(track, id, clientAddress)).join('');
      return this.buildDidlResult(itemsXml, pagedTracks.length, albumTracks.length);
    }

    if (id === 'artists' && directChildren) {
      if (!hasArtistsContainer) {
        return this.buildDidlResult('', 0, 0);
      }
      const allArtists = browseLibrary.artists;
      const pagedArtists = this.slicePagedEntries(allArtists, startingIndex, requestedCount);
      const itemsXml = pagedArtists.map(artist => this.buildArtistDidlContainer(artist)).join('');
      return this.buildDidlResult(itemsXml, pagedArtists.length, allArtists.length);
    }

    if (id.startsWith('artist:') && directChildren) {
      const artistId = id.replace('artist:', '');
      const artistTracks = browseLibrary.tracks.filter(trackEntry => trackEntry.artistIds.includes(artistId));
      const pagedTracks = this.slicePagedEntries(artistTracks, startingIndex, requestedCount);
      const itemsXml = pagedTracks.map(track => this.buildTrackDidlItem(track, id, clientAddress)).join('');
      return this.buildDidlResult(itemsXml, pagedTracks.length, artistTracks.length);
    }

    if (id === 'playlists' && directChildren) {
      const allPlaylists = browseLibrary.playlists;
      const pagedPlaylists = this.slicePagedEntries(allPlaylists, startingIndex, requestedCount);
      const itemsXml = pagedPlaylists.map(playlist => this.buildPlaylistDidlContainer(playlist)).join('');
      return this.buildDidlResult(itemsXml, pagedPlaylists.length, allPlaylists.length);
    }

    if (id.startsWith('playlist:') && directChildren) {
      const playlistId = id.replace('playlist:', '');
      const playlist = browseLibrary.playlists.find(playlistEntry => playlistEntry.id === playlistId);
      const playlistProviderIds = playlist?.trackProviderIds || [];
      const playlistTracks = browseLibrary.tracks.filter(trackEntry => playlistProviderIds.includes(trackEntry.providerId));
      const pagedTracks = this.slicePagedEntries(playlistTracks, startingIndex, requestedCount);
      const itemsXml = pagedTracks.map(track => this.buildTrackDidlItem(track, id, clientAddress)).join('');
      return this.buildDidlResult(itemsXml, pagedTracks.length, playlistTracks.length);
    }

    if (id === 'podcasts' && directChildren) {
      const allPodcasts = browseLibrary.podcasts;
      const pagedPodcasts = this.slicePagedEntries(allPodcasts, startingIndex, requestedCount);
      const itemsXml = pagedPodcasts.map(subscription => this.buildPodcastDidlContainer(subscription)).join('');
      return this.buildDidlResult(itemsXml, pagedPodcasts.length, allPodcasts.length);
    }

    if (id.startsWith('podcast:') && directChildren) {
      const podcastId = id.replace('podcast:', '');
      const subscription = browseLibrary.podcasts.find(entry => entry.id === podcastId);
      const podcastEpisodes = subscription?.episodes || [];
      const pagedEpisodes = this.slicePagedEntries(podcastEpisodes, startingIndex, requestedCount);
      const itemsXml = pagedEpisodes.map(episode => this.buildPodcastEpisodeDidlItem(episode, podcastId)).join('');
      return this.buildDidlResult(itemsXml, pagedEpisodes.length, podcastEpisodes.length);
    }

    const track = browseLibrary.tracks.find(trackEntry => trackEntry.id === id);
    if (track) {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
${this.buildTrackDidlItem(track, 'tracks', clientAddress)}
</DIDL-Lite>`;
      return {
        resultXml: xml,
        numberReturned: 1,
        totalMatches: 1,
      };
    }

    return {
      resultXml: [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"',
        'xmlns:dc="http://purl.org/dc/elements/1.1/"',
        'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"',
        'xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">',
        '</DIDL-Lite>',
      ].join(''),
      numberReturned: 0,
      totalMatches: 0,
    };
  }

  private static buildTrackDidlItem(track: DlnaTrack, parentId = 'tracks', clientAddress = '') {
    const ipAddress = this.getBestServingIpForClient(clientAddress);
    const baseUrl = `http://${ipAddress}:${this.port}`;
    const durationSeconds = Math.max(0, Math.floor(track.duration));
    const hours = Math.floor(durationSeconds / 3600);
    const minutes = Math.floor((durationSeconds % 3600) / 60);
    const seconds = durationSeconds % 60;
    const duration = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.000`;
    const streamUrl = `${baseUrl}/stream/${encodeURIComponent(track.id)}`;
    const coverUrl = track.coverPath ? `${baseUrl}/cover/${encodeURIComponent(track.id)}` : '';
    const coverMimeType = coverUrl ? 'image/jpeg' : '';
    const coverProfile = this.getDlnaImageProfileForMimeType();
    let coverProtocolInfo = '';
    if (coverMimeType) {
      if (coverProfile) {
        coverProtocolInfo = `http-get:*:${coverMimeType}:DLNA.ORG_PN=${coverProfile}`;
      } else {
        coverProtocolInfo = `http-get:*:${coverMimeType}:*`;
      }
    }
    const albumArtAttributes = coverProfile
      ? ` dlna:profileID="${coverProfile}"`
      : '';
    return `<item id="${this.escapeXml(track.id)}" parentID="${this.escapeXml(parentId)}" restricted="1">
<dc:title>${this.escapeXml(track.title)}</dc:title>
<upnp:class>object.item.audioItem.musicTrack</upnp:class>
<upnp:artist>${this.escapeXml(track.artist)}</upnp:artist>
<upnp:album>${this.escapeXml(track.album)}</upnp:album>
${coverUrl ? `<upnp:albumArtURI${albumArtAttributes}>${this.escapeXml(coverUrl)}</upnp:albumArtURI>` : ''}
${coverUrl && coverProtocolInfo ? `<res protocolInfo="${coverProtocolInfo}">${this.escapeXml(coverUrl)}</res>` : ''}
<res protocolInfo="http-get:*:${track.mimeType}:*" size="${track.fileSize}" duration="${duration}">${this.escapeXml(streamUrl)}</res>
</item>`;
  }

  private static buildAlbumDidlContainer(album: IMediaAlbum) {
    return `<container id="album:${this.escapeXml(album.id)}" parentID="albums" restricted="1" searchable="0">
<dc:title>${this.escapeXml(album.album_name)}</dc:title>
<upnp:class>object.container.album.musicAlbum</upnp:class>
</container>`;
  }

  private static buildArtistDidlContainer(artist: IMediaArtist) {
    return `<container id="artist:${this.escapeXml(artist.id)}" parentID="artists" restricted="1" searchable="0">
<dc:title>${this.escapeXml(artist.artist_name)}</dc:title>
<upnp:class>object.container.person.musicArtist</upnp:class>
</container>`;
  }

  private static buildPlaylistDidlContainer(playlist: { id: string; name: string }) {
    return `<container id="playlist:${this.escapeXml(playlist.id)}" parentID="playlists" restricted="1" searchable="0">
<dc:title>${this.escapeXml(playlist.name)}</dc:title>
<upnp:class>object.container.playlistContainer</upnp:class>
</container>`;
  }

  private static buildPodcastDidlContainer(subscription: IPodcastSubscription) {
    return `<container id="podcast:${this.escapeXml(subscription.id)}" parentID="podcasts" restricted="1" searchable="0">
<dc:title>${this.escapeXml(subscription.title)}</dc:title>
<upnp:class>object.container</upnp:class>
</container>`;
  }

  private static buildPodcastEpisodeDidlItem(episode: IPodcastEpisode, podcastId: string) {
    const episodeId = String(episode.id || episode.audioUrl || `${podcastId}-${episode.title || 'episode'}`);
    const streamUrl = String(episode.audioUrl || '');
    const publishedTimestamp = Number(episode.publishedAt || 0);
    const dateIsoString = publishedTimestamp > 0
      ? new Date(publishedTimestamp).toISOString()
      : new Date().toISOString();
    return `<item id="podcast-episode:${this.escapeXml(episodeId)}" parentID="podcast:${this.escapeXml(podcastId)}" restricted="1">
<dc:title>${this.escapeXml(String(episode.title || 'Episode'))}</dc:title>
<dc:date>${this.escapeXml(dateIsoString)}</dc:date>
<upnp:class>object.item.audioItem.musicTrack</upnp:class>
<res protocolInfo="http-get:*:audio/mpeg:*">${this.escapeXml(streamUrl)}</res>
</item>`;
  }

  private static buildDidlResult(itemsXml: string, numberReturned: number, totalMatches: number) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
${this.getDidlRootStart()}
${itemsXml}
</DIDL-Lite>`;
    return {
      resultXml: xml,
      numberReturned,
      totalMatches,
    };
  }

  private static slicePagedEntries<T>(entries: T[], startingIndex: number, requestedCount: number) {
    const start = Math.max(0, Number.isFinite(startingIndex) ? startingIndex : 0);
    const count = requestedCount > 0 ? requestedCount : entries.length;
    return entries.slice(start, start + count);
  }

  private static normalizeBrowseObjectId(objectId: string) {
    const normalizedId = String(objectId || '0').trim();
    if (normalizedId === '0') {
      return '0';
    }
    if (normalizedId.includes('$')) {
      const candidate = normalizedId.split('$').pop();
      return String(candidate || normalizedId);
    }
    if (normalizedId.includes('/')) {
      const candidate = normalizedId.split('/').pop();
      return String(candidate || normalizedId);
    }
    return normalizedId;
  }

  private static getDidlRootStart() {
    return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"'
      + ' xmlns:dc="http://purl.org/dc/elements/1.1/"'
      + ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"'
      + ' xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">';
  }

  private static async getBrowseLibrary(): Promise<DlnaBrowseLibrary> {
    const now = Date.now();
    if (this.browseLibraryCache && (now - this.browseLibraryCache.updatedAt) < this.browseLibraryCacheTtlMs) {
      return this.browseLibraryCache;
    }
    if (this.browseLibraryLoadingPromise) {
      return this.browseLibraryLoadingPromise;
    }
    this.browseLibraryLoadingPromise = this.refreshBrowseLibrary();
    const library = await this.browseLibraryLoadingPromise;
    this.browseLibraryLoadingPromise = undefined;
    return library;
  }

  private static async refreshBrowseLibrary(): Promise<DlnaBrowseLibrary> {
    const artistViewMode = this.getArtistViewMode();
    const [trackDataList, albumsRaw, artistsRaw, playlistsRaw, likedTracks] = await Promise.all([
      MediaTrackDatastore.findMediaTracks(),
      MediaAlbumService.searchAlbumsByName(''),
      artistViewMode === 'off' ? Promise.resolve([]) : MediaArtistService.getMediaArtists(artistViewMode),
      MediaPlaylistDatastore.findMediaPlaylists(),
      MediaLikedTrackService.resolveLikedTracks(),
    ]);

    const albumById = new Map<string, string>(
      albumsRaw.map(album => [String(album.id), String(album.album_name || '')]),
    );
    const albumCoverByAlbumId = new Map<string, string>(
      albumsRaw.map((album) => {
        const albumCoverPath = this.resolvePicturePath(album.album_cover_picture);
        return [String(album.id), albumCoverPath];
      }),
    );
    const albumArtistByAlbumId = new Map<string, string>(
      albumsRaw.map(album => [String(album.id), String(album.album_artist_id || '')]),
    );
    const artistById = new Map<string, string>(
      artistsRaw.map(artist => [String(artist.id), String(artist.artist_name || '')]),
    );
    const tracks = trackDataList
      .map(trackData => this.createDlnaTrackFromMediaTrackData(
        trackData,
        albumById,
        albumCoverByAlbumId,
        artistById,
        artistViewMode,
        albumArtistByAlbumId,
      ))
      .filter(Boolean) as DlnaTrack[];
    const trackById = new Map<string, DlnaTrack>(tracks.map(track => [track.id, track]));
    const likedTrackProviderIds = likedTracks.map(track => String(track.provider_id || '')).filter(Boolean);
    const playlists = playlistsRaw
      .filter(playlist => !playlist.is_hidden_album)
      .map(playlist => ({
        id: playlist.id,
        name: playlist.name,
        trackProviderIds: (playlist.tracks || []).map(trackEntry => String(trackEntry.provider_id || '')).filter(Boolean),
      }));
    if (likedTrackProviderIds.length > 0) {
      playlists.unshift({
        id: 'auto-playlist-liked-tracks',
        name: 'Lieblingssongs',
        trackProviderIds: likedTrackProviderIds,
      });
    }

    const library: DlnaBrowseLibrary = {
      tracks,
      trackById,
      albums: albumsRaw.filter(album => !album.hidden),
      artists: artistsRaw,
      playlists,
      podcasts: PodcastService.getSubscriptions(),
      artistViewMode,
      updatedAt: Date.now(),
    };
    this.browseLibraryCache = library;
    return library;
  }

  private static createDlnaTrackFromMediaTrackData(
    track: IMediaTrackData,
    albumById: Map<string, string>,
    albumCoverByAlbumId: Map<string, string>,
    artistById: Map<string, string>,
    artistViewMode: ArtistViewMode,
    albumArtistByAlbumId: Map<string, string>,
  ): DlnaTrack | undefined {
    const filePath = String((track.extra as any)?.file_path || '').trim();
    if (!filePath) {
      return undefined;
    }
    const fileSizeFromExtra = Number((track.extra as any)?.file_size);
    const fileSize = Number.isFinite(fileSizeFromExtra) && fileSizeFromExtra > 0
      ? fileSizeFromExtra
      : 0;
    const artistIds = this.resolveTrackArtistIds(track, artistViewMode, albumArtistByAlbumId);
    const artistNames = artistIds
      .map(artistId => artistById.get(artistId))
      .filter(Boolean) as string[];
    const albumId = String(track.track_album_id || '');
    const albumName = String(albumById.get(albumId) || '');
    const coverPathFromTrack = this.resolvePicturePath(track.track_cover_picture);
    const coverPath = coverPathFromTrack || String(albumCoverByAlbumId.get(albumId) || '');
    return {
      id: String(track.id || track.provider_id || filePath),
      providerId: String(track.provider_id || ''),
      title: String(track.track_name || path.basename(filePath)),
      artist: String(artistNames.join(', ') || ''),
      artistIds,
      album: albumName,
      albumId,
      duration: Number(track.track_duration || 0),
      filePath,
      mimeType: this.getMimeType(filePath),
      fileSize,
      coverPath,
      coverMimeType: this.getImageMimeType(coverPath),
    };
  }

  private static getTrackCoverPathFromMediaTrack(mediaTrack: IMediaTrack): string {
    const coverFromTrack = this.resolvePicturePath(mediaTrack.track_cover_picture);
    if (coverFromTrack) {
      return coverFromTrack;
    }
    return this.resolvePicturePath(mediaTrack.track_album?.album_cover_picture);
  }

  private static resolvePicturePath(picture?: { image_data?: any; image_data_type?: MediaTrackCoverPictureImageDataType }): string {
    if (!picture) {
      return '';
    }
    if (picture.image_data_type === MediaTrackCoverPictureImageDataType.Buffer) {
      return this.materializePictureBufferToPath(picture.image_data);
    }
    return this.normalizePicturePath(picture.image_data);
  }

  private static normalizePicturePath(imageData?: any): string {
    const picturePath = String(imageData || '').replace(/^file:\/\//, '').trim();
    if (!picturePath || !fs.existsSync(picturePath)) {
      return '';
    }
    return picturePath;
  }

  private static getImageMimeType(filePath?: string): string {
    const extension = path.extname(String(filePath || '')).toLowerCase();
    if (extension === '.png') {
      return 'image/png';
    }
    if (extension === '.webp') {
      return 'image/webp';
    }
    return 'image/jpeg';
  }

  private static materializePictureBufferToPath(imageData?: any): string {
    if (!imageData) {
      return '';
    }
    let imageBuffer: Buffer | undefined;
    if (Buffer.isBuffer(imageData)) {
      imageBuffer = imageData;
    } else if (Array.isArray(imageData)) {
      imageBuffer = Buffer.from(imageData);
    } else if (typeof imageData === 'string') {
      const dataUrlMatch = imageData.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
      const base64Payload = dataUrlMatch ? dataUrlMatch[1] : imageData;
      try {
        imageBuffer = Buffer.from(base64Payload, 'base64');
      } catch (_error) {
        imageBuffer = undefined;
      }
    } else if (typeof imageData === 'object' && imageData?.type === 'Buffer' && Array.isArray(imageData?.data)) {
      imageBuffer = Buffer.from(imageData.data);
    }
    if (!imageBuffer || imageBuffer.byteLength === 0) {
      return '';
    }
    const artworkCachePath = this.getDlnaArtworkCachePath();
    if (!artworkCachePath) {
      return '';
    }
    const imageHash = crypto.createHash('sha1').update(imageBuffer.toString('base64')).digest('hex');
    const pictureExtension = this.getImageExtensionFromBuffer(imageBuffer);
    const picturePath = path.join(artworkCachePath, `${imageHash}${pictureExtension}`);
    if (!fs.existsSync(picturePath)) {
      fs.writeFileSync(picturePath, Uint8Array.from(imageBuffer));
    }
    return picturePath;
  }

  private static getImageExtensionFromBuffer(imageBuffer: Buffer): string {
    if (imageBuffer.byteLength >= 8
      && imageBuffer[0] === 0x89
      && imageBuffer[1] === 0x50
      && imageBuffer[2] === 0x4E
      && imageBuffer[3] === 0x47) {
      return '.png';
    }
    if (imageBuffer.byteLength >= 4
      && imageBuffer[0] === 0x52
      && imageBuffer[1] === 0x49
      && imageBuffer[2] === 0x46
      && imageBuffer[3] === 0x46) {
      return '.webp';
    }
    return '.jpg';
  }

  private static getDlnaArtworkCachePath(): string | undefined {
    if (this.dlnaArtworkCachePath) {
      return this.dlnaArtworkCachePath;
    }
    try {
      const rendererLogPath = String(AppService.details.logs_path || '').trim();
      const logsDir = rendererLogPath ? path.dirname(rendererLogPath) : '';
      if (!logsDir) {
        return undefined;
      }
      const artworkCachePath = path.join(logsDir, this.dlnaArtworkCacheDirName);
      fs.mkdirSync(artworkCachePath, { recursive: true });
      this.dlnaArtworkCachePath = artworkCachePath;
      return artworkCachePath;
    } catch (_error) {
      return undefined;
    }
  }

  private static async resolveStreamTrack(trackId: string): Promise<DlnaTrack | undefined> {
    const liveTrack = this.trackMap.get(trackId);
    const browseLibrary = await this.getBrowseLibrary();
    const track = browseLibrary.trackById.get(trackId);
    if (track) {
      if (liveTrack) {
        return {
          ...liveTrack,
          coverPath: liveTrack.coverPath || track.coverPath,
          coverMimeType: liveTrack.coverMimeType || track.coverMimeType,
        };
      }
      return track;
    }
    if (liveTrack) {
      return liveTrack;
    }
    const mediaTrackData = await MediaTrackDatastore.findMediaTrack({
      id: trackId,
    });
    if (!mediaTrackData) {
      return undefined;
    }
    const albumData = mediaTrackData.track_album_id
      ? await MediaAlbumDatastore.findMediaAlbumById(mediaTrackData.track_album_id)
      : undefined;
    const artistDataList = mediaTrackData.track_artist_ids && mediaTrackData.track_artist_ids.length > 0
      ? await MediaArtistDatastore.findMediaArtists({
        id: {
          $in: mediaTrackData.track_artist_ids,
        },
      } as any)
      : [];
    const albumById = new Map<string, string>(albumData ? [[String(albumData.id), String(albumData.album_name || '')]] : []);
    const albumCoverByAlbumId = new Map<string, string>(
      albumData ? [[String(albumData.id), this.normalizePicturePath(albumData.album_cover_picture?.image_data)]] : [],
    );
    const albumArtistByAlbumId = new Map<string, string>(
      albumData ? [[String(albumData.id), String(albumData.album_artist_id || '')]] : [],
    );
    const artistById = new Map<string, string>(artistDataList.map(artist => [String(artist.id), String(artist.artist_name || '')]));
    return this.createDlnaTrackFromMediaTrackData(
      mediaTrackData,
      albumById,
      albumCoverByAlbumId,
      artistById,
      this.getArtistViewMode(),
      albumArtistByAlbumId,
    );
  }

  private static getArtistViewMode(): ArtistViewMode {
    try {
      const rawSettings = localStorage.getItem(this.uiSettingsStorageKey);
      if (!rawSettings) {
        return 'artists';
      }
      const parsedSettings = JSON.parse(rawSettings);
      const parsedMode = String(parsedSettings?.artistViewMode || '').trim();
      if (parsedMode === 'off' || parsedMode === 'artists' || parsedMode === 'album_artists') {
        return parsedMode;
      }
      return parsedSettings?.hideArtist ? 'off' : 'artists';
    } catch (_error) {
      return 'artists';
    }
  }

  private static resolveTrackArtistIds(
    track: IMediaTrackData,
    artistViewMode: ArtistViewMode,
    albumArtistByAlbumId: Map<string, string>,
  ) {
    if (artistViewMode === 'off') {
      return [];
    }
    if (artistViewMode === 'album_artists') {
      const albumArtistId = String(albumArtistByAlbumId.get(String(track.track_album_id || '')) || '');
      return albumArtistId ? [albumArtistId] : [];
    }
    return (track.track_artist_ids || []).map(artistId => String(artistId || '')).filter(Boolean);
  }

  private static invalidateBrowseLibrary() {
    this.browseLibraryCache = undefined;
    this.browseLibraryLoadingPromise = undefined;
    this.systemUpdateId += 1;
    this.emitState();
  }

  private static getBestServingIpForClient(clientAddress: string) {
    const ipAddresses = this.getIpAddresses();
    if (!clientAddress) {
      return ipAddresses[0] || '127.0.0.1';
    }
    const matchingSubnetIp = ipAddresses.find(ipAddress => this.hasSameIPv4Subnet(ipAddress, clientAddress));
    return matchingSubnetIp || ipAddresses[0] || '127.0.0.1';
  }
}
