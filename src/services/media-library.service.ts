import _ from 'lodash';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { MediaLibraryActions, MediaTrackCoverPictureImageDataType } from '../enums';
import store from '../store';

import { DataStoreInputData } from '../modules/datastore';
import { IPCRenderer, IPCCommChannel } from '../modules/ipc';

import MediaPlayerService from './media-player.service';

import {
  MediaAlbumDatastore,
  MediaArtistDatastore,
  MediaProviderDatastore,
  MediaTrackDatastore,
} from '../datastores';

import {
  IMediaAlbum,
  IMediaAlbumData,
  IMediaArtist,
  IMediaArtistData,
  IMediaPicture,
  IMediaTrack,
  IMediaTrackData,
} from '../interfaces';

import { MediaTrackService } from './media-track.service';
import { MediaArtistService } from './media-artist.service';
import { MediaAlbumService } from './media-album.service';
import { MediaProviderService } from './media-provider.service';
import { NotificationService } from './notification.service';
import { PodcastService } from './podcast.service';
import { I18nService } from './i18n.service';

import MediaLocalConstants from '../providers/media-local/media-local.constants.json';
import type { IMediaLocalSettings } from '../providers/media-local/media-local.interfaces';

import {
  adbPushLocalFile,
  checkAdbDestinationCurrent,
  getAuthorizedAdbDeviceSerial,
  hashRemoteFileViaPull,
  isAdbDeviceReachable,
  joinDevicePosixPath,
  forEachRemoteFileLine,
  remoteListFilesRecursive,
  remoteMkdirP,
  remoteUnlink,
  resolveAdbExecutable,
  resolveDapStorageBasePath,
  walkLocalFilesRecursive as dapWalkLocalFilesRecursive,
} from './dap-adb-sync.service';

const debug = require('debug')('aurora:service:media_library');

type DapSyncPhase = 'idle' | 'planning' | 'copying' | 'cleaning' | 'done' | 'aborted' | 'error';

interface IDapSyncCheckpoint {
  targetDirectory: string;
  syncRootPath: string;
  completedRelativePaths: string[];
  copiedFiles: number;
  deletedFiles: number;
  updatedAt: number;
}

interface IDapSyncStateEntry {
  sourceSize: number;
  sourceMtimeMs: number;
  sourceHash?: string;
  destinationSize?: number;
  destinationMtimeMs?: number;
  destinationHash?: string;
}

interface IDapSyncState {
  targetDirectory: string;
  syncRootPath: string;
  entries: Record<string, IDapSyncStateEntry>;
  updatedAt: number;
}

interface IDapDestinationCheckResult {
  isCurrent: boolean;
  syncStateEntry?: IDapSyncStateEntry;
}

export interface IDapSyncProgressSnapshot {
  phase: DapSyncPhase;
  isRunning: boolean;
  processedItems: number;
  totalItems: number;
  copiedFiles: number;
  deletedFiles: number;
  startedAt: number;
  elapsedMs: number;
  etaMs?: number;
  targetDirectory: string;
  syncRootPath: string;
  canResume: boolean;
  resumedFromProcessedItems: number;
  errorMessage?: string;
}

export class MediaLibraryService {
  static readonly mediaPictureScaleWidth = 500;
  static readonly mediaPictureScaleHeight = 500;
  static readonly dapSyncSettingsStorageKey = 'aurora:dap-sync-settings';
  static readonly dapSyncDirectoryName = 'Music';
  static readonly dapSyncCheckpointStorageKey = 'aurora:dap-sync-checkpoint';
  static readonly dapSyncStateStorageKey = 'aurora:dap-sync-state';
  static readonly dapSyncProgressEventName = 'aurora:dap-sync-progress';
  static readonly dapSyncAbortErrorCode = 'DAP_SYNC_ABORTED';
  static readonly dapSyncDeviceRemovedErrorCode = 'DAP_SYNC_DEVICE_REMOVED';
  private static dapSyncAbortController: AbortController | null = null;
  private static dapSyncPromise: Promise<{ copiedFiles: number; deletedFiles: number; totalTracks: number }> | null = null;
  /** Last successful `done` snapshot for UI + localStorage (survives idle wipe / app reload). */
  private static dapSyncLastCompletedSummary: IDapSyncProgressSnapshot | null = null;
  private static readonly dapSyncLastSummaryStorageKey = 'aurora:dap-sync-last-summary';
  private static dapLastSummaryHydratedFromStorage = false;
  /** `syncDapLibraryIfEnabled` passes a monotonic id per library-sync end; skip duplicate auto-runs that would clear the summary UI. */
  private static dapLibrarySyncGenerationLastConsumedForDone = -1;
  /** Generation id for the DAP run started from `syncDapLibrary` (auto chain). */
  private static dapCurrentRunLibrarySyncGeneration: number | undefined;
  /** Silent runs overwrite raw state with planning/0 before work starts; keep showing prior `done` counts in getSnapshot until processedItems > 0. */
  private static dapSilentRunHoldPriorSummaryForUi = false;
  private static dapSyncProgressSnapshot: IDapSyncProgressSnapshot = {
    phase: 'idle',
    isRunning: false,
    processedItems: 0,
    totalItems: 0,
    copiedFiles: 0,
    deletedFiles: 0,
    startedAt: 0,
    elapsedMs: 0,
    targetDirectory: '',
    syncRootPath: '',
    canResume: false,
    resumedFromProcessedItems: 0,
  };

  static async checkAndInsertMediaArtists(mediaArtistInputDataList: DataStoreInputData<IMediaArtistData>[]): Promise<IMediaArtist[]> {
    return Promise.all(mediaArtistInputDataList.map(mediaArtistInputData => this.checkAndInsertMediaArtist(mediaArtistInputData)));
  }

  static async checkAndInsertMediaArtist(mediaArtistInputData: DataStoreInputData<IMediaArtistData>): Promise<IMediaArtist> {
    if (_.isNil(mediaArtistInputData.provider_id)) {
      throw new Error('Provider id is required for checkAndInsertMediaArtist');
    }

    const mediaArtistData = await MediaArtistDatastore.upsertMediaArtist({
      provider: mediaArtistInputData.provider,
      provider_id: mediaArtistInputData.provider_id,
    }, {
      provider: mediaArtistInputData.provider,
      provider_id: mediaArtistInputData.provider_id,
      sync_timestamp: mediaArtistInputData.sync_timestamp,
      artist_name: mediaArtistInputData.artist_name,
      artist_name_normalized: this.normalizeSearchValue(mediaArtistInputData.artist_name),
      artist_feature_picture: await this.processPicture(mediaArtistInputData.artist_feature_picture),
      extra: mediaArtistInputData.extra,
    });

    return MediaArtistService.buildMediaArtist(mediaArtistData, true);
  }

  static async checkAndInsertMediaAlbum(mediaAlbumInputData: DataStoreInputData<IMediaAlbumData>): Promise<IMediaAlbum> {
    if (_.isNil(mediaAlbumInputData.provider_id)) {
      throw new Error('Provider id is required for checkAndInsertMediaAlbum');
    }

    let existingMediaAlbumData = await MediaAlbumDatastore.findMediaAlbum({
      provider: mediaAlbumInputData.provider,
      provider_id: mediaAlbumInputData.provider_id,
    });

    // If album exists identified by source fingerprint, reuse it and preserve user edits
    const sourceFingerprint = (mediaAlbumInputData.extra as any)?.source_fingerprint;
    let effectiveProviderId = mediaAlbumInputData.provider_id;
    if (!existingMediaAlbumData && sourceFingerprint) {
      const foundBySource = await MediaAlbumDatastore.findMediaAlbum({
        provider: mediaAlbumInputData.provider,
        // @ts-ignore - nested field filter allowed at runtime
        'extra.source_fingerprint': sourceFingerprint,
      } as any);
      if (foundBySource) {
        existingMediaAlbumData = foundBySource;
        effectiveProviderId = foundBySource.provider_id;
      }
    }
    const processedAlbumCoverPicture = await this.processPicture(mediaAlbumInputData.album_cover_picture);

    const upsertFilter: any = {
      provider: mediaAlbumInputData.provider,
      provider_id: effectiveProviderId,
    };

    const existingAddedAt = Number((existingMediaAlbumData?.extra as any)?.added_at);
    let resolvedAddedAt = Number.isFinite(existingAddedAt) && existingAddedAt > 0
      ? existingAddedAt
      : undefined;
    if (!resolvedAddedAt && existingMediaAlbumData?.id) {
      const albumTracks = await MediaTrackDatastore.findMediaTracks({
        track_album_id: existingMediaAlbumData.id,
      });
      const albumTrackFileMtimes = albumTracks
        .map(track => Number((track.extra as any)?.file_mtime))
        .filter(fileMtime => Number.isFinite(fileMtime) && fileMtime > 0);
      if (albumTrackFileMtimes.length > 0) {
        resolvedAddedAt = Math.min(...albumTrackFileMtimes);
      } else {
        const albumTrackSyncTimestamps = albumTracks
          .map(track => Number(track.sync_timestamp))
          .filter(syncTimestamp => Number.isFinite(syncTimestamp) && syncTimestamp > 0);
        if (albumTrackSyncTimestamps.length > 0) {
          resolvedAddedAt = Math.min(...albumTrackSyncTimestamps);
        }
      }
    }

    const baseUpdate: Partial<IMediaAlbumData> = {
      provider: mediaAlbumInputData.provider,
      provider_id: effectiveProviderId,
      sync_timestamp: mediaAlbumInputData.sync_timestamp,
      album_name_normalized: this.normalizeSearchValue(mediaAlbumInputData.album_name),
      album_cover_picture: processedAlbumCoverPicture || existingMediaAlbumData?.album_cover_picture,
      album_genre: mediaAlbumInputData.album_genre,
      album_year: mediaAlbumInputData.album_year,
      extra: {
        ...(existingMediaAlbumData?.extra || {}),
        ...(mediaAlbumInputData.extra || {}),
        added_at: resolvedAddedAt || mediaAlbumInputData.sync_timestamp,
      },
    };

    // Preserve manual edits: only set album_name/album_artist_id when inserting new album
    if (!existingMediaAlbumData) {
      (baseUpdate as any).album_name = mediaAlbumInputData.album_name;
      (baseUpdate as any).album_artist_id = mediaAlbumInputData.album_artist_id;
    }

    const mediaTrackAlbumData = await MediaAlbumDatastore.upsertMediaAlbum(upsertFilter, baseUpdate as any);
    return MediaAlbumService.buildMediaAlbum(mediaTrackAlbumData, true);
  }

  static async checkAndInsertMediaTrack(mediaTrackInputData: DataStoreInputData<IMediaTrackData>): Promise<IMediaTrack> {
    const { mediaTrack } = await this.checkAndInsertMediaTrackWithStatus(mediaTrackInputData);
    return mediaTrack;
  }

  static async checkAndInsertMediaTrackWithStatus(mediaTrackInputData: DataStoreInputData<IMediaTrackData>): Promise<{
    mediaTrack: IMediaTrack;
    isNew: boolean;
  }> {
    if (_.isNil(mediaTrackInputData.provider_id)) {
      throw new Error('Provider id is required for checkAndInsertMediaTrack');
    }

    const existingMediaTrackData = await MediaTrackDatastore.findMediaTrack({
      provider: mediaTrackInputData.provider,
      provider_id: mediaTrackInputData.provider_id,
    });
    const mergedTrackExtra = {
      ...((existingMediaTrackData?.extra || {}) as Record<string, any>),
      ...((mediaTrackInputData.extra || {}) as Record<string, any>),
    };
    const processedTrackCoverPicture = await this.processPicture(mediaTrackInputData.track_cover_picture);

    const mediaTrackData = await MediaTrackDatastore.upsertMediaTrack({
      provider: mediaTrackInputData.provider,
      provider_id: mediaTrackInputData.provider_id,
    }, {
      provider: mediaTrackInputData.provider,
      provider_id: mediaTrackInputData.provider_id,
      sync_timestamp: mediaTrackInputData.sync_timestamp,
      track_name: mediaTrackInputData.track_name,
      track_name_normalized: this.normalizeSearchValue(mediaTrackInputData.track_name),
      track_number: mediaTrackInputData.track_number,
      track_duration: mediaTrackInputData.track_duration,
      track_cover_picture: processedTrackCoverPicture || existingMediaTrackData?.track_cover_picture,
      track_artist_ids: mediaTrackInputData.track_artist_ids,
      track_album_id: mediaTrackInputData.track_album_id,
      extra: mergedTrackExtra as any,
    });

    return {
      mediaTrack: await MediaTrackService.buildMediaTrack(mediaTrackData, true),
      isNew: !existingMediaTrackData,
    };
  }

  static async startMediaTrackSync(mediaProviderIdentifier: string): Promise<void> {
    const mediaProviderData = await MediaProviderDatastore.findMediaProviderByIdentifier(mediaProviderIdentifier);
    if (!mediaProviderData) {
      throw new Error(`MediaLibraryService encountered error at startMediaTrackSync - Provider not found - ${mediaProviderIdentifier}`);
    }

    const mediaSyncStartTimestamp = Date.now();
    await MediaProviderDatastore.updateMediaProviderByIdentifier(mediaProviderIdentifier, {
      sync_started_at: mediaSyncStartTimestamp,
      sync_finished_at: null,
    });
    debug('started sync for provider %s at %d', mediaProviderIdentifier, mediaSyncStartTimestamp);

    store.dispatch({
      type: MediaLibraryActions.StartSync,
      data: {
        mediaProviderIdentifier,
      },
    });
  }

  static async finishMediaTrackSync(mediaProviderIdentifier: string): Promise<void> {
    const mediaProviderData = await MediaProviderDatastore.findMediaProviderByIdentifier(mediaProviderIdentifier);
    if (!mediaProviderData) {
      throw new Error(`MediaLibraryService encountered error at finishMediaTrackSync - Provider not found - ${mediaProviderIdentifier}`);
    }
    if (!mediaProviderData.sync_started_at || mediaProviderData.sync_finished_at) {
      throw new Error('MediaLibraryService encountered error at finishMediaTrackSync - Invalid sync state');
    }

    // delete unsync'd media - media which is older than start of the sync
    // important - this will only delete it from store, state still needs to be managed
    const mediaSyncStartTimestamp = mediaProviderData.sync_started_at;
    await this.deleteUnsyncMedia(mediaProviderIdentifier, mediaSyncStartTimestamp);
    await MediaPlayerService.revalidatePlayer();

    // update provider
    const mediaSyncEndTimestamp = Date.now();
    await MediaProviderDatastore.updateMediaProviderByIdentifier(mediaProviderIdentifier, {
      sync_finished_at: mediaSyncEndTimestamp,
    });
    debug('finished sync for provider %s at %d', mediaProviderIdentifier, mediaSyncEndTimestamp);

    store.dispatch({
      type: MediaLibraryActions.FinishSync,
      data: {
        mediaProviderIdentifier,
        mediaSyncStartTimestamp,
      },
    });
  }

  static async processPicture(mediaPicture?: IMediaPicture): Promise<IMediaPicture | undefined> {
    // this accepts a MediaPicture and returns a serializable instance of MediaPicture which can be stored and
    // further processed system-wide after deserializing
    if (!mediaPicture) {
      return undefined;
    }

    if (mediaPicture.image_data_type === MediaTrackCoverPictureImageDataType.Buffer) {
      let imageCachePath;

      try {
        imageCachePath = await IPCRenderer.sendAsyncMessage(IPCCommChannel.ImageScale, mediaPicture.image_data, {
          width: this.mediaPictureScaleWidth,
          height: this.mediaPictureScaleHeight,
        });
      } catch (error) {
        console.error('encountered error while processing image - %s', error);
      }

      if (!imageCachePath) {
        return undefined;
      }

      return {
        image_data: imageCachePath,
        image_data_type: MediaTrackCoverPictureImageDataType.Path,
      };
    }

    // image data type does not need any processing, return as is
    return mediaPicture;
  }

  private static normalizeSearchValue(value: string): string {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u2018\u2019]/g, '\'')
      .replace(/[\u201C\u201D]/g, '"')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');
  }

  private static buildDapDestinationPath(syncRootPath: string, relativePath: string): string {
    if (!syncRootPath) {
      return relativePath;
    }
    if (syncRootPath.startsWith('/')) {
      return path.posix.join(syncRootPath, ...relativePath.split('/').filter(Boolean));
    }
    return path.join(syncRootPath, ...relativePath.split(/[/\\]/).filter(Boolean));
  }

  private static async resolveDapLibraryRootsForMirror(): Promise<string[]> {
    const localSettings = await MediaProviderService.getMediaProviderSettings(MediaLocalConstants.Provider) as IMediaLocalSettings;
    return (localSettings?.library?.directories || [])
      .map(directory => String(directory || '').trim())
      .filter(Boolean)
      .map(directory => path.resolve(directory));
  }

  /**
   * Maps a host file path to a device-relative path that mirrors the folder layout under configured library roots.
   * Returns null if the file is not under any library directory.
   */
  private static tryBuildMirrorRelativePath(sourcePath: string, libraryRootsResolved: string[]): string | null {
    if (!libraryRootsResolved.length) {
      return null;
    }
    const resolvedSource = path.resolve(sourcePath);
    const uniqueRoots = [...new Set(libraryRootsResolved.map(rootPath => path.resolve(rootPath)))].sort((a, b) => b.length - a.length);
    let mirrorResult: string | null = null;
    uniqueRoots.some((root) => {
      const relativeFromRoot = path.relative(root, resolvedSource);
      if (!relativeFromRoot || relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
        return false;
      }
      let relativePosix = relativeFromRoot.split(path.sep).join('/');
      if (uniqueRoots.length > 1) {
        const rootTag = this.truncatePathPart(this.sanitizePathPart(path.basename(root)), 80);
        relativePosix = `${rootTag}/${relativePosix}`;
      }
      mirrorResult = this.sanitizeMirrorRelativePath(relativePosix);
      return true;
    });
    return mirrorResult;
  }

  private static sanitizeMirrorRelativePath(relativePosix: string): string {
    const segments = relativePosix.split('/').filter(Boolean);
    if (!segments.length) {
      return '';
    }
    const directorySegments = segments.slice(0, -1).map(segment => this.truncatePathPart(this.sanitizePathPart(segment), 200));
    const lastSegment = segments[segments.length - 1];
    const extension = path.posix.extname(lastSegment);
    const baseNameWithoutExtension = extension ? lastSegment.slice(0, -extension.length) : lastSegment;
    const fileName = this.truncatePathPart(`${this.sanitizePathPart(baseNameWithoutExtension)}${extension}`, 220);
    return [...directorySegments, fileName].join('/');
  }

  private static buildDapMetadataLayoutRelativePath(
    mediaTrack: IMediaTrack,
    albumDiscNumbersByAlbumId: Map<string, Set<number>>,
    sourceExtension: string,
  ): { baseRelativePath: string; legacyRelativePaths: string[] } {
    const artistName = this.truncatePathPart(this.sanitizePathPart(
      mediaTrack.track_album?.album_artist?.artist_name || 'Unknown Artist',
    ), 80);
    const albumName = this.sanitizePathPart(mediaTrack.track_album?.album_name || 'Unknown Album');
    const albumYear = String(mediaTrack.track_album?.album_year || '').trim();
    const albumDirectoryName = this.truncatePathPart(this.sanitizePathPart(
      albumYear ? `${albumName} - ${albumYear}` : albumName,
    ), 120);
    const trackNumber = String(mediaTrack.track_number || 0).padStart(2, '0');
    const trackName = this.truncatePathPart(this.sanitizePathPart(mediaTrack.track_name || 'Unknown Track'), 120);
    const baseFileName = this.truncatePathPart(`${trackNumber} - ${trackName}`, 140);
    const uniqueSuffix = mediaTrack.id.slice(0, 8);
    const albumId = String(mediaTrack.track_album_id || mediaTrack.track_album?.id || '');
    const discNumber = this.resolveTrackDiscNumber(mediaTrack);
    const albumDiscNumbers = albumDiscNumbersByAlbumId.get(albumId);
    const isMultiDiscAlbum = !!albumDiscNumbers && albumDiscNumbers.size > 1;
    const discDirectoryName = (isMultiDiscAlbum && discNumber > 0) ? `CD${discNumber}` : '';
    const fileName = this.truncatePathPart(`${baseFileName} [${uniqueSuffix}]${sourceExtension}`, 160);
    const baseRelativePath = path
      .join(artistName, albumDirectoryName, discDirectoryName, fileName)
      .split(path.sep)
      .join('/');
    const legacyRelativePaths = discDirectoryName
      ? [path.join(artistName, albumDirectoryName, fileName).split(path.sep).join('/')]
      : [];
    return { baseRelativePath, legacyRelativePaths };
  }

  private static async buildDapLibraryTrackPlan(syncRootPath: string): Promise<{
    trackItems: Array<{
      relativePath: string;
      sourcePath: string;
      destinationPath: string;
      legacyDestinationPaths: string[];
      sourceSize?: number;
      sourceMtimeMs?: number;
    }>;
    expectedRelativePaths: Set<string>;
    totalExpectedMusicItems: number;
  }> {
    const trackDataList = await MediaTrackDatastore.findMediaTracks();
    const mediaTracks = await MediaTrackService.buildMediaTracks(trackDataList);
    const tracksWithPaths = mediaTracks.filter((mediaTrack) => {
      const filePath = String((mediaTrack.extra as any)?.file_path || '');
      return !_.isEmpty(filePath) && fs.existsSync(filePath);
    });
    const albumDiscNumbersByAlbumId = new Map<string, Set<number>>();
    tracksWithPaths.forEach((mediaTrack) => {
      const albumId = String(mediaTrack.track_album_id || mediaTrack.track_album?.id || '');
      if (!albumId) {
        return;
      }
      const discNumber = this.resolveTrackDiscNumber(mediaTrack);
      if (discNumber <= 0) {
        return;
      }
      const existingDiscNumbers = albumDiscNumbersByAlbumId.get(albumId) || new Set<number>();
      existingDiscNumbers.add(discNumber);
      albumDiscNumbersByAlbumId.set(albumId, existingDiscNumbers);
    });

    const { mirrorHostFolderLayout } = this.getDapSyncSettings();
    const libraryRootsForMirror = mirrorHostFolderLayout
      ? await this.resolveDapLibraryRootsForMirror()
      : [];

    const usedRelativePathCounts = new Map<string, number>();
    const trackItems = tracksWithPaths.map((mediaTrack) => {
      const sourcePath = String((mediaTrack.extra as any)?.file_path || '');
      const sourceExtension = path.extname(sourcePath) || '.flac';
      const mirrorRelativePath = mirrorHostFolderLayout && libraryRootsForMirror.length > 0
        ? this.tryBuildMirrorRelativePath(sourcePath, libraryRootsForMirror)
        : null;
      let baseRelativePath: string;
      let legacyRelativePaths: string[];
      if (mirrorRelativePath) {
        baseRelativePath = mirrorRelativePath;
        legacyRelativePaths = [];
      } else {
        const metadataLayout = this.buildDapMetadataLayoutRelativePath(mediaTrack, albumDiscNumbersByAlbumId, sourceExtension);
        baseRelativePath = metadataLayout.baseRelativePath;
        legacyRelativePaths = metadataLayout.legacyRelativePaths;
      }
      const relativePathUsageCount = Number(usedRelativePathCounts.get(baseRelativePath) || 0);
      usedRelativePathCounts.set(baseRelativePath, relativePathUsageCount + 1);
      const relativePath = relativePathUsageCount > 0
        ? this.disambiguateRelativePath(baseRelativePath, sourcePath, relativePathUsageCount)
        : baseRelativePath;
      const destinationPath = this.buildDapDestinationPath(syncRootPath, relativePath);
      const legacyDestinationPaths = legacyRelativePaths.map(legacyRelativePath => this.buildDapDestinationPath(syncRootPath, legacyRelativePath));
      const sourceSize = Number((mediaTrack.extra as any)?.file_size);
      const sourceMtimeMs = Number((mediaTrack.extra as any)?.file_mtime);
      return {
        relativePath,
        sourcePath,
        destinationPath,
        legacyDestinationPaths,
        sourceSize: Number.isFinite(sourceSize) && sourceSize > 0 ? sourceSize : undefined,
        sourceMtimeMs: Number.isFinite(sourceMtimeMs) && sourceMtimeMs > 0 ? sourceMtimeMs : undefined,
      };
    });

    const expectedRelativePaths = new Set(trackItems.map(item => item.relativePath));
    const expectedPodcastFilesCount = PodcastService.getExpectedDapSyncFileCount();
    const totalExpectedMusicItems = trackItems.length + expectedPodcastFilesCount;
    return {
      trackItems,
      expectedRelativePaths,
      totalExpectedMusicItems,
    };
  }

  static getDapSyncSettings(): {
    targetDirectory: string;
    autoSyncEnabled: boolean;
    deleteMissingOnDevice: boolean;
    transport: 'filesystem' | 'adb';
    mirrorHostFolderLayout: boolean;
  } {
    const fallback = {
      targetDirectory: '',
      autoSyncEnabled: false,
      deleteMissingOnDevice: true,
      transport: 'filesystem' as const,
      mirrorHostFolderLayout: true,
    };

    const rawSettings = localStorage.getItem(this.dapSyncSettingsStorageKey);
    if (!rawSettings) {
      return fallback;
    }

    try {
      const parsedSettings = JSON.parse(rawSettings);
      const rawTransport = String(parsedSettings?.transport || '').toLowerCase();
      const transport: 'filesystem' | 'adb' = rawTransport === 'adb' ? 'adb' : 'filesystem';
      return {
        targetDirectory: String(parsedSettings?.targetDirectory || ''),
        autoSyncEnabled: Boolean(parsedSettings?.autoSyncEnabled),
        deleteMissingOnDevice: parsedSettings?.deleteMissingOnDevice !== false,
        transport,
        mirrorHostFolderLayout: parsedSettings?.mirrorHostFolderLayout !== false,
      };
    } catch (_error) {
      return fallback;
    }
  }

  static saveDapSyncSettings(input: {
    targetDirectory: string;
    autoSyncEnabled: boolean;
    deleteMissingOnDevice: boolean;
    transport: 'filesystem' | 'adb';
    mirrorHostFolderLayout: boolean;
  }) {
    let normalizedTargetDirectory = String(input.targetDirectory || '').trim();
    if (normalizedTargetDirectory && path.basename(normalizedTargetDirectory).toLowerCase() === this.dapSyncDirectoryName.toLowerCase()) {
      normalizedTargetDirectory = path.dirname(normalizedTargetDirectory);
    }
    const previousTargetDirectory = String(this.dapSyncProgressSnapshot.targetDirectory || '').trim();
    const previousIsAdbVirtual = previousTargetDirectory.startsWith('adb:');
    const settingsAdbEmpty = input.transport === 'adb' && !normalizedTargetDirectory;
    const trivialAdbTargetDrift = settingsAdbEmpty && previousIsAdbVirtual;
    const targetDirectoryChanged = normalizedTargetDirectory !== previousTargetDirectory && !trivialAdbTargetDrift;
    const previousMirrorHostFolderLayout = this.getDapSyncSettings().mirrorHostFolderLayout;
    const mirrorHostFolderLayoutChanged = Boolean(input.mirrorHostFolderLayout) !== Boolean(previousMirrorHostFolderLayout);

    localStorage.setItem(this.dapSyncSettingsStorageKey, JSON.stringify({
      targetDirectory: normalizedTargetDirectory,
      autoSyncEnabled: Boolean(input.autoSyncEnabled),
      deleteMissingOnDevice: Boolean(input.deleteMissingOnDevice),
      transport: input.transport === 'adb' ? 'adb' : 'filesystem',
      mirrorHostFolderLayout: Boolean(input.mirrorHostFolderLayout),
    }));

    if (!this.dapSyncProgressSnapshot.isRunning && (targetDirectoryChanged || mirrorHostFolderLayoutChanged)) {
      this.dapSyncLastCompletedSummary = null;
      try {
        localStorage.removeItem(this.dapSyncLastSummaryStorageKey);
      } catch (_e) {
        /* ignore */
      }
      this.updateDapSyncProgress({
        phase: 'idle',
        isRunning: false,
        processedItems: 0,
        totalItems: 0,
        copiedFiles: 0,
        deletedFiles: 0,
        startedAt: 0,
        targetDirectory: normalizedTargetDirectory,
        syncRootPath: normalizedTargetDirectory ? path.join(normalizedTargetDirectory, this.dapSyncDirectoryName) : '',
        canResume: false,
        resumedFromProcessedItems: 0,
        errorMessage: undefined,
      });
    }
  }

  private static hydrateDapLastSummaryFromStorage() {
    if (this.dapLastSummaryHydratedFromStorage || typeof localStorage === 'undefined') {
      return;
    }
    this.dapLastSummaryHydratedFromStorage = true;
    try {
      const raw = localStorage.getItem(this.dapSyncLastSummaryStorageKey);
      if (raw && !this.dapSyncLastCompletedSummary) {
        this.dapSyncLastCompletedSummary = JSON.parse(raw) as IDapSyncProgressSnapshot;
      }
    } catch (_e) {
      /* ignore */
    }
  }

  private static persistDapLastCompletedSummary(snapshot: IDapSyncProgressSnapshot) {
    try {
      localStorage.setItem(this.dapSyncLastSummaryStorageKey, JSON.stringify(snapshot));
    } catch (_e) {
      /* ignore */
    }
  }

  static getDapSyncProgressSnapshot(): IDapSyncProgressSnapshot {
    this.hydrateDapLastSummaryFromStorage();
    const live = this.dapSyncProgressSnapshot;
    const last = this.dapSyncLastCompletedSummary;
    const syncInFlight = this.dapSyncPromise != null || live.isRunning;

    // After a finished sync, keep showing its statistics until a new run actually starts (manual or auto).
    // If the live snapshot was reset to empty idle (e.g. side effects), fall back to the last completed summary.
    if (!syncInFlight && last) {
      const blankIdle = !live.isRunning
        && live.phase === 'idle'
        && live.processedItems === 0
        && live.totalItems === 0
        && live.copiedFiles === 0
        && live.deletedFiles === 0;
      if (blankIdle) {
        return { ...last };
      }
    }

    // Silent auto-sync: first updates are planning/0 — overlay prior done counts until this run reports progress.
    if (
      syncInFlight
      && this.dapSilentRunHoldPriorSummaryForUi
      && last
      && live.isRunning
      && live.processedItems === 0
      && last.totalItems > 0
    ) {
      return {
        ...live,
        processedItems: last.processedItems,
        totalItems: last.totalItems,
        copiedFiles: last.copiedFiles,
        deletedFiles: last.deletedFiles,
      };
    }

    return { ...live };
  }

  static subscribeDapSyncProgress(listener: (snapshot: IDapSyncProgressSnapshot) => void): () => void {
    if (typeof window === 'undefined') {
      return () => {};
    }

    const eventListener = (event: Event) => {
      const progressEvent = event as CustomEvent<IDapSyncProgressSnapshot>;
      listener(progressEvent.detail);
    };

    window.addEventListener(this.dapSyncProgressEventName, eventListener);
    return () => {
      window.removeEventListener(this.dapSyncProgressEventName, eventListener);
    };
  }

  static cancelDapLibrarySync() {
    if (this.dapSyncAbortController) {
      this.dapSyncAbortController.abort();
    }
  }

  static abortAndResetDapLibrarySyncState() {
    this.cancelDapLibrarySync();
    this.clearDapSyncCheckpoint();
    this.clearDapSyncState();
    if (this.dapSyncProgressSnapshot.isRunning) {
      this.updateDapSyncProgress({
        phase: 'aborted',
        isRunning: false,
        canResume: true,
        errorMessage: undefined,
      });
    }
  }

  private static mapAdbSyncInitError(error: unknown): string {
    const code = String((error as Error)?.message || error);
    if (code === 'ADB_NOT_FOUND') {
      return I18nService.getString('label_settings_dap_adb_error_no_adb');
    }
    if (code === 'ADB_NO_DEVICE') {
      return I18nService.getString('label_settings_dap_adb_error_no_device');
    }
    if (code === 'ADB_UNAUTHORIZED') {
      return I18nService.getString('label_settings_dap_adb_error_unauthorized');
    }
    if (code === 'ADB_MULTIPLE_DEVICES') {
      return I18nService.getString('label_settings_dap_adb_error_multiple_devices');
    }
    if (code === 'ADB_DEVICES_TIMED_OUT') {
      return I18nService.getString('label_settings_dap_adb_error_devices_timeout');
    }
    if (code === 'ADB_INVALID_DEVICE_SERIAL') {
      return I18nService.getString('label_settings_dap_adb_error_invalid_serial');
    }
    return code;
  }

  /**
   * Push library to a single USB-debugging Android device via adb (Music + Podcasts under SD if writable, else internal).
   */
  private static runDapAdbLibrarySync(options?: {
    deleteMissingOnDevice?: boolean;
    silent?: boolean;
  }): Promise<{ copiedFiles: number; deletedFiles: number; totalTracks: number }> {
    const abortController = new AbortController();
    this.dapSyncAbortController = abortController;
    const { signal } = abortController;
    const startedAt = Date.now();
    let adbPathForMonitor = '';
    let serialForMonitor = '';

    const syncPromise = (async () => {
      if (signal.aborted) {
        throw this.toDapAbortError();
      }

      // Build the local track list before touching ADB. Remote paths use `musicSyncRoot` + `relativePath` later;
      // placeholder root only affects unused `destinationPath` fields for this transport.
      const planPlaceholderRoot = path.posix.join('/', this.dapSyncDirectoryName);
      const {
        trackItems,
        expectedRelativePaths,
        totalExpectedMusicItems,
      } = await this.buildDapLibraryTrackPlan(planPlaceholderRoot);

      this.updateDapSyncProgress({
        phase: 'planning',
        isRunning: true,
        processedItems: 0,
        totalItems: totalExpectedMusicItems,
        copiedFiles: 0,
        deletedFiles: 0,
        startedAt,
        targetDirectory: '',
        syncRootPath: '',
        canResume: false,
        resumedFromProcessedItems: 0,
        errorMessage: undefined,
      });

      let adbPath: string;
      let serial: string;
      let storageBase: string;
      try {
        adbPath = await resolveAdbExecutable(signal);
        adbPathForMonitor = adbPath;
        serial = await getAuthorizedAdbDeviceSerial(adbPath, signal);
        serialForMonitor = serial;
        storageBase = await resolveDapStorageBasePath(adbPath, serial, signal);
      } catch (error) {
        throw new Error(this.mapAdbSyncInitError(error));
      }

      const musicSyncRoot = path.posix.join(storageBase, this.dapSyncDirectoryName);
      const podcastRemoteRoot = path.posix.join(storageBase, PodcastService.podcastDirectoryName);
      const dapTargetVirtual = `adb:${serial}`;

      const deviceMonitor = setInterval(() => {
        if (this.dapSyncAbortController !== abortController || !adbPathForMonitor || !serialForMonitor) {
          return;
        }
        isAdbDeviceReachable(adbPathForMonitor, serialForMonitor).then((ok) => {
          if (!ok && this.dapSyncAbortController === abortController) {
            abortController.abort();
          }
        }).catch(() => undefined);
      }, 2500);

      try {
        const currentCheckpoint = this.loadDapSyncCheckpoint(dapTargetVirtual, musicSyncRoot);
        const currentSyncState = this.loadDapSyncState(dapTargetVirtual, musicSyncRoot);
        const syncStateEntries = new Map(Object.entries(currentSyncState?.entries || {}));
        const completedRelativePathSet = new Set(currentCheckpoint?.completedRelativePaths || []);
        let copiedFiles = currentCheckpoint?.copiedFiles || 0;
        let deletedFiles = currentCheckpoint?.deletedFiles || 0;
        let skippedFiles = 0;

        this.updateDapSyncProgress({
          phase: 'planning',
          isRunning: true,
          processedItems: 0,
          totalItems: totalExpectedMusicItems,
          copiedFiles,
          deletedFiles,
          startedAt,
          targetDirectory: dapTargetVirtual,
          syncRootPath: musicSyncRoot,
          canResume: false,
          resumedFromProcessedItems: completedRelativePathSet.size,
          errorMessage: undefined,
        });

        const deleteMissingOnDevice = options?.deleteMissingOnDevice ?? this.getDapSyncSettings().deleteMissingOnDevice;

        const hashRemoteForCompare = (remote: string, sig?: AbortSignal) => hashRemoteFileViaPull(
          adbPath,
          serial,
          remote,
          (p, s) => this.hashFileSha1(p, s),
          sig,
        );

        let planningProcessedItems = 0;
        let planningLastProgressUpdateAt = 0;
        const resumeValidation = await Promise.map(trackItems, async (trackItem) => {
          if (signal.aborted) {
            throw this.toDapAbortError();
          }
          const remotePath = joinDevicePosixPath(musicSyncRoot, trackItem.relativePath);
          const destinationCheck = await checkAdbDestinationCurrent({
            adbPath,
            serial,
            sourcePath: trackItem.sourcePath,
            remotePath,
            sourceMeta: {
              sourceSize: trackItem.sourceSize,
              sourceMtimeMs: trackItem.sourceMtimeMs,
              syncStateEntry: syncStateEntries.get(trackItem.relativePath),
              signal,
            },
            hashLocalFile: (p, s) => this.hashFileSha1(p, s),
            hashRemoteFile: hashRemoteForCompare,
          });
          if (destinationCheck.isCurrent && destinationCheck.syncStateEntry) {
            syncStateEntries.set(trackItem.relativePath, destinationCheck.syncStateEntry as IDapSyncStateEntry);
          }
          planningProcessedItems += 1;
          const now = Date.now();
          if (planningProcessedItems % 20 === 0 || (now - planningLastProgressUpdateAt) > 250 || planningProcessedItems >= trackItems.length) {
            planningLastProgressUpdateAt = now;
            this.updateDapSyncProgress({
              phase: 'planning',
              isRunning: true,
              processedItems: planningProcessedItems,
              totalItems: totalExpectedMusicItems,
              copiedFiles,
              deletedFiles,
              startedAt,
              targetDirectory: dapTargetVirtual,
              syncRootPath: musicSyncRoot,
              canResume: false,
              resumedFromProcessedItems: completedRelativePathSet.size,
              errorMessage: undefined,
            });
          }
          return {
            ...trackItem,
            remotePath,
            alreadyCompleted: destinationCheck.isCurrent,
          };
        }, { concurrency: 4 });

        const resumedValidRelativePaths = resumeValidation
          .filter(item => item.alreadyCompleted)
          .map(item => item.relativePath);
        const resumedValidRelativePathSet = new Set(resumedValidRelativePaths);
        const pendingTrackItems = resumeValidation.filter(item => !item.alreadyCompleted);

        this.persistDapSyncCheckpoint({
          targetDirectory: dapTargetVirtual,
          syncRootPath: musicSyncRoot,
          completedRelativePaths: resumedValidRelativePaths,
          copiedFiles,
          deletedFiles,
        });

        this.updateDapSyncProgress({
          phase: 'copying',
          isRunning: true,
          processedItems: resumedValidRelativePathSet.size,
          totalItems: totalExpectedMusicItems,
          copiedFiles,
          deletedFiles,
          startedAt,
          targetDirectory: dapTargetVirtual,
          syncRootPath: musicSyncRoot,
          canResume: false,
          resumedFromProcessedItems: resumedValidRelativePathSet.size,
          errorMessage: undefined,
        });

        let lastCheckpointPersistAt = 0;
        let lastProgressUpdateAt = 0;
        const persistDapProgressState = (force = false) => {
          const now = Date.now();
          if (!force && resumedValidRelativePathSet.size > 0 && resumedValidRelativePathSet.size % 20 !== 0 && (now - lastCheckpointPersistAt) < 1200) {
            return;
          }
          lastCheckpointPersistAt = now;
          this.persistDapSyncCheckpoint({
            targetDirectory: dapTargetVirtual,
            syncRootPath: musicSyncRoot,
            completedRelativePaths: [...resumedValidRelativePathSet],
            copiedFiles,
            deletedFiles,
          });
          this.persistDapSyncState({
            targetDirectory: dapTargetVirtual,
            syncRootPath: musicSyncRoot,
            entries: Object.fromEntries(syncStateEntries.entries()),
          });
        };
        const publishCopyProgress = (force = false) => {
          const now = Date.now();
          if (!force && resumedValidRelativePathSet.size > 0 && resumedValidRelativePathSet.size % 10 !== 0 && (now - lastProgressUpdateAt) < 200) {
            return;
          }
          lastProgressUpdateAt = now;
          this.updateDapSyncProgress({
            phase: 'copying',
            isRunning: true,
            processedItems: resumedValidRelativePathSet.size,
            totalItems: totalExpectedMusicItems,
            copiedFiles,
            deletedFiles,
            startedAt,
            targetDirectory: dapTargetVirtual,
            syncRootPath: musicSyncRoot,
            canResume: false,
            resumedFromProcessedItems: resumedValidRelativePathSet.size,
            errorMessage: undefined,
          });
        };

        await Promise.map(pendingTrackItems, async (trackItem) => {
          if (signal.aborted) {
            throw this.toDapAbortError();
          }

          let trackSynchronized = false;
          let trackSyncCheck: Awaited<ReturnType<typeof checkAdbDestinationCurrent>> | undefined;
          const { remotePath } = trackItem as { remotePath: string };
          try {
            await remoteMkdirP(adbPath, serial, path.posix.dirname(remotePath), signal);
            const preCopyCheck = await checkAdbDestinationCurrent({
              adbPath,
              serial,
              sourcePath: trackItem.sourcePath,
              remotePath,
              sourceMeta: {
                sourceSize: trackItem.sourceSize,
                sourceMtimeMs: trackItem.sourceMtimeMs,
                syncStateEntry: syncStateEntries.get(trackItem.relativePath),
                signal,
              },
              hashLocalFile: (p, s) => this.hashFileSha1(p, s),
              hashRemoteFile: hashRemoteForCompare,
            });
            const shouldCopy = !preCopyCheck.isCurrent;
            if (shouldCopy) {
              await adbPushLocalFile(adbPath, serial, trackItem.sourcePath, remotePath, signal);
              copiedFiles += 1;
              trackSyncCheck = await checkAdbDestinationCurrent({
                adbPath,
                serial,
                sourcePath: trackItem.sourcePath,
                remotePath,
                sourceMeta: {
                  sourceSize: trackItem.sourceSize,
                  sourceMtimeMs: trackItem.sourceMtimeMs,
                  syncStateEntry: syncStateEntries.get(trackItem.relativePath),
                  signal,
                },
                hashLocalFile: (p, s) => this.hashFileSha1(p, s),
                hashRemoteFile: hashRemoteForCompare,
              });
              trackSynchronized = trackSyncCheck.isCurrent;
            } else {
              trackSyncCheck = preCopyCheck;
              trackSynchronized = true;
            }
          } catch (error) {
            if (signal.aborted) {
              throw this.toDapAbortError();
            }
            skippedFiles += 1;
            debug('Skipping ADB DAP sync file after error: %o', {
              sourcePath: trackItem.sourcePath,
              remotePath,
              error: String((error as any)?.message || error),
            });
          }

          if (!trackSynchronized) {
            publishCopyProgress();
            return;
          }

          resumedValidRelativePathSet.add(trackItem.relativePath);
          const syncStateEntry = trackSyncCheck?.syncStateEntry;
          if (syncStateEntry) {
            syncStateEntries.set(trackItem.relativePath, syncStateEntry as IDapSyncStateEntry);
          }
          persistDapProgressState();
          publishCopyProgress();
        }, { concurrency: 1 });
        persistDapProgressState(true);
        publishCopyProgress(true);

        if (signal.aborted) {
          throw this.toDapAbortError();
        }

        if (deleteMissingOnDevice) {
          const musicPrefix = musicSyncRoot.endsWith('/') ? musicSyncRoot : `${musicSyncRoot}/`;
          const staleRelativePaths = [...syncStateEntries.keys()].filter(relativePath => !expectedRelativePaths.has(relativePath));
          staleRelativePaths.forEach(relativePath => syncStateEntries.delete(relativePath));

          let cleaningScanLines = 0;
          const publishCleaningProgress = (force = false) => {
            if (!force && cleaningScanLines % 80 !== 0) {
              return;
            }
            const gap = Math.max(0, totalExpectedMusicItems - resumedValidRelativePathSet.size);
            const cleaningAdvance = gap > 0 ? Math.min(gap, cleaningScanLines) : 0;
            this.updateDapSyncProgress({
              phase: 'cleaning',
              isRunning: true,
              processedItems: Math.min(
                totalExpectedMusicItems,
                resumedValidRelativePathSet.size + cleaningAdvance,
              ),
              totalItems: totalExpectedMusicItems,
              copiedFiles,
              deletedFiles,
              startedAt,
              targetDirectory: dapTargetVirtual,
              syncRootPath: musicSyncRoot,
              canResume: false,
              resumedFromProcessedItems: resumedValidRelativePathSet.size,
              errorMessage: undefined,
            });
          };

          this.updateDapSyncProgress({
            phase: 'cleaning',
            isRunning: true,
            processedItems: resumedValidRelativePathSet.size,
            totalItems: totalExpectedMusicItems,
            copiedFiles,
            deletedFiles,
            startedAt,
            targetDirectory: dapTargetVirtual,
            syncRootPath: musicSyncRoot,
            canResume: false,
            resumedFromProcessedItems: resumedValidRelativePathSet.size,
            errorMessage: undefined,
          });

          await forEachRemoteFileLine(adbPath, serial, musicSyncRoot, async (remoteFile) => {
            if (signal.aborted) {
              throw this.toDapAbortError();
            }
            cleaningScanLines += 1;
            publishCleaningProgress();
            if (cleaningScanLines % 120 === 0) {
              await new Promise<void>(r => setImmediate(r));
            }
            if (!remoteFile.startsWith(musicPrefix)) {
              return;
            }
            const relativePath = remoteFile.slice(musicPrefix.length).split(path.sep).join('/');
            if (expectedRelativePaths.has(relativePath)) {
              return;
            }
            if (!this.isManagedDapMusicRelativePath(relativePath) || this.isIgnoredDapRelativePath(relativePath)) {
              return;
            }
            const removed = await remoteUnlink(adbPath, serial, remoteFile, signal);
            if (removed) {
              deletedFiles += 1;
            }
            persistDapProgressState();
            publishCleaningProgress(true);
          }, signal);
          persistDapProgressState(true);
          publishCleaningProgress(true);
        }

        const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aurora-dap-adb-'));
        let tmpPodcastsExists = false;
        let podcastSyncResult = {
          copiedFiles: 0,
          deletedFiles: 0,
          totalFiles: 0,
          syncedFiles: 0,
        };
        try {
          podcastSyncResult = await PodcastService.syncPodcastsToDap({
            targetDirectory: tmpRoot,
            deleteMissingOnDevice,
            signal,
          });
          const tmpPodcasts = path.join(tmpRoot, PodcastService.podcastDirectoryName);
          tmpPodcastsExists = await fs.promises.stat(tmpPodcasts).then(s => s.isDirectory()).catch(() => false);
          const expectedPodcastRel = new Set<string>();
          if (tmpPodcastsExists) {
            const localPodFiles = await dapWalkLocalFilesRecursive(tmpPodcasts);
            localPodFiles.forEach((f) => {
              expectedPodcastRel.add(path.relative(tmpPodcasts, f).split(path.sep).join('/'));
            });
            await Promise.map(localPodFiles, async (localFile) => {
              if (signal.aborted) {
                throw this.toDapAbortError();
              }
              const rel = path.relative(tmpPodcasts, localFile).split(path.sep).join('/');
              const remotePod = joinDevicePosixPath(podcastRemoteRoot, rel);
              await remoteMkdirP(adbPath, serial, path.posix.dirname(remotePod), signal);
              await adbPushLocalFile(adbPath, serial, localFile, remotePod, signal);
            }, { concurrency: 1 });
          }

          if (deleteMissingOnDevice && tmpPodcastsExists) {
            const podPrefix = podcastRemoteRoot.endsWith('/') ? podcastRemoteRoot : `${podcastRemoteRoot}/`;
            const remotePodFiles = await remoteListFilesRecursive(adbPath, serial, podcastRemoteRoot, signal);
            await Promise.map(remotePodFiles, async (remotePodPath) => {
              if (signal.aborted) {
                throw this.toDapAbortError();
              }
              if (!remotePodPath.startsWith(podPrefix)) {
                return;
              }
              const rel = remotePodPath.slice(podPrefix.length).split(path.sep).join('/');
              if (!expectedPodcastRel.has(rel)) {
                await remoteUnlink(adbPath, serial, remotePodPath, signal);
                deletedFiles += 1;
              }
            }, { concurrency: 1 });
          }
        } finally {
          await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
        }

        copiedFiles += podcastSyncResult.copiedFiles;
        deletedFiles += podcastSyncResult.deletedFiles;
        const totalExpectedItemsWithPodcasts = trackItems.length + podcastSyncResult.totalFiles;
        const synchronizedItemsWithPodcasts = resumedValidRelativePathSet.size + podcastSyncResult.syncedFiles;
        const missingItems = Math.max(0, totalExpectedItemsWithPodcasts - synchronizedItemsWithPodcasts);

        this.persistDapSyncState({
          targetDirectory: dapTargetVirtual,
          syncRootPath: musicSyncRoot,
          entries: Object.fromEntries(syncStateEntries.entries()),
        });

        this.clearDapSyncCheckpoint();
        const result = {
          copiedFiles,
          deletedFiles,
          totalTracks: synchronizedItemsWithPodcasts,
        };

        this.updateDapSyncProgress({
          phase: 'done',
          isRunning: false,
          processedItems: synchronizedItemsWithPodcasts,
          totalItems: totalExpectedItemsWithPodcasts,
          copiedFiles: result.copiedFiles,
          deletedFiles: result.deletedFiles,
          startedAt,
          targetDirectory: dapTargetVirtual,
          syncRootPath: musicSyncRoot,
          canResume: false,
          resumedFromProcessedItems: 0,
          errorMessage: missingItems > 0 ? `${missingItems} Datei(en) fehlen und werden beim nächsten Sync nachgeholt.` : undefined,
        });

        if (!options?.silent) {
          NotificationService.showMessage(`DAP Sync (ADB): ${result.copiedFiles} kopiert, ${result.deletedFiles} gelöscht, ${result.totalTracks} Titel synchronisiert, ${skippedFiles} übersprungen.`);
        }

        return result;
      } finally {
        clearInterval(deviceMonitor);
      }
    })()
      .catch((error) => {
        const abortedByUser = error?.message === this.dapSyncAbortErrorCode || error?.name === 'AbortError';
        if (abortedByUser) {
          const dapTargetVirtual = serialForMonitor ? `adb:${serialForMonitor}` : '';
          const snap = this.getDapSyncProgressSnapshot();
          const checkpoint = dapTargetVirtual
            ? this.loadDapSyncCheckpoint(dapTargetVirtual, String(snap.syncRootPath || '').trim() || '')
            : null;
          this.updateDapSyncProgress({
            phase: 'aborted',
            isRunning: false,
            canResume: true,
            resumedFromProcessedItems: checkpoint?.completedRelativePaths.length || 0,
            errorMessage: undefined,
          });
          return {
            copiedFiles: this.dapSyncProgressSnapshot.copiedFiles,
            deletedFiles: this.dapSyncProgressSnapshot.deletedFiles,
            totalTracks: this.dapSyncProgressSnapshot.totalItems,
          };
        }
        const normalizedErrorMessage = String(error?.message || error);
        this.updateDapSyncProgress({
          phase: 'error',
          isRunning: false,
          canResume: false,
          targetDirectory: serialForMonitor ? `adb:${serialForMonitor}` : '',
          syncRootPath: '',
          errorMessage: normalizedErrorMessage,
        });
        throw error;
      })
      .finally(() => {
        this.dapCurrentRunLibrarySyncGeneration = undefined;
        this.dapSilentRunHoldPriorSummaryForUi = false;
        if (this.dapSyncAbortController === abortController) {
          this.dapSyncAbortController = null;
        }
        this.dapSyncPromise = null;
      });

    return syncPromise;
  }

  /** Clears counters for a new run (manual Sync only — silent auto-sync keeps the last summary until progress updates). */
  private static prepareDapSyncProgressForNewRun(transport: 'filesystem' | 'adb', targetDirectoryForUi: string) {
    const td = String(targetDirectoryForUi || '').trim();
    const syncRootPath = transport === 'filesystem' && td
      ? path.join(td, this.dapSyncDirectoryName)
      : '';
    this.updateDapSyncProgress({
      phase: 'planning',
      isRunning: true,
      processedItems: 0,
      totalItems: 0,
      copiedFiles: 0,
      deletedFiles: 0,
      startedAt: Date.now(),
      targetDirectory: transport === 'adb' ? '' : td,
      syncRootPath,
      errorMessage: undefined,
      canResume: false,
      resumedFromProcessedItems: 0,
    });
  }

  static async syncDapLibrary(options?: {
    targetDirectory?: string;
    deleteMissingOnDevice?: boolean;
    silent?: boolean;
    transport?: 'filesystem' | 'adb';
    /** Set by `syncDapLibraryIfEnabled` to dedupe auto runs after the same library-sync completion. */
    librarySyncGeneration?: number;
  }): Promise<{ copiedFiles: number; deletedFiles: number; totalTracks: number }> {
    if (this.dapSyncPromise) {
      return this.dapSyncPromise;
    }

    this.dapCurrentRunLibrarySyncGeneration = options?.librarySyncGeneration;
    this.dapSilentRunHoldPriorSummaryForUi = !!options?.silent;

    const settings = this.getDapSyncSettings();
    const transport = options?.transport ?? settings.transport ?? 'filesystem';

    if (transport === 'adb') {
      if (!options?.silent) {
        this.prepareDapSyncProgressForNewRun('adb', '');
      }
      this.saveDapSyncSettings({
        targetDirectory: String(settings.targetDirectory || '').trim(),
        autoSyncEnabled: settings.autoSyncEnabled,
        deleteMissingOnDevice: options?.deleteMissingOnDevice ?? settings.deleteMissingOnDevice,
        transport: 'adb',
        mirrorHostFolderLayout: settings.mirrorHostFolderLayout,
      });
      const adbPromise = this.runDapAdbLibrarySync(options);
      this.dapSyncPromise = adbPromise;
      return adbPromise;
    }

    const configuredTargetDirectory = String(options?.targetDirectory || settings.targetDirectory || '').trim();
    if (!configuredTargetDirectory) {
      throw new Error('No DAP target directory configured');
    }

    let dapTargetDirectory = configuredTargetDirectory;
    if (path.basename(dapTargetDirectory).toLowerCase() === this.dapSyncDirectoryName.toLowerCase()) {
      dapTargetDirectory = path.dirname(dapTargetDirectory);
    }
    if (!options?.silent) {
      this.prepareDapSyncProgressForNewRun('filesystem', dapTargetDirectory);
    }
    this.saveDapSyncSettings({
      targetDirectory: dapTargetDirectory,
      autoSyncEnabled: settings.autoSyncEnabled,
      deleteMissingOnDevice: settings.deleteMissingOnDevice,
      transport: 'filesystem',
      mirrorHostFolderLayout: settings.mirrorHostFolderLayout,
    });

    const abortController = new AbortController();
    this.dapSyncAbortController = abortController;
    const { signal } = abortController;
    const dapTargetAvailabilityMonitor = setInterval(() => {
      if (this.dapSyncAbortController !== abortController) {
        return;
      }
      if (!fs.existsSync(dapTargetDirectory)) {
        abortController.abort();
      }
    }, 1000);

    const syncPromise = (async () => {
      const deleteMissingOnDevice = options?.deleteMissingOnDevice ?? settings.deleteMissingOnDevice;
      const syncRootPath = path.join(dapTargetDirectory, this.dapSyncDirectoryName);
      const startedAt = Date.now();
      const dapTargetStat = await fs.promises.stat(dapTargetDirectory).catch(() => undefined);
      if (!dapTargetStat || !dapTargetStat.isDirectory()) {
        throw this.toDapAbortError(this.dapSyncDeviceRemovedErrorCode);
      }
      await fs.promises.mkdir(syncRootPath, { recursive: true });

      const currentCheckpoint = this.loadDapSyncCheckpoint(dapTargetDirectory, syncRootPath);
      const currentSyncState = this.loadDapSyncState(dapTargetDirectory, syncRootPath);
      const syncStateEntries = new Map(Object.entries(currentSyncState?.entries || {}));
      const completedRelativePathSet = new Set(currentCheckpoint?.completedRelativePaths || []);
      let copiedFiles = currentCheckpoint?.copiedFiles || 0;
      let deletedFiles = currentCheckpoint?.deletedFiles || 0;
      let skippedFiles = 0;

      this.updateDapSyncProgress({
        phase: 'planning',
        isRunning: true,
        processedItems: completedRelativePathSet.size,
        totalItems: completedRelativePathSet.size,
        copiedFiles,
        deletedFiles,
        startedAt,
        targetDirectory: dapTargetDirectory,
        syncRootPath,
        canResume: false,
        resumedFromProcessedItems: completedRelativePathSet.size,
        errorMessage: undefined,
      });

      const {
        trackItems,
        expectedRelativePaths,
        totalExpectedMusicItems,
      } = await this.buildDapLibraryTrackPlan(syncRootPath);
      this.updateDapSyncProgress({
        phase: 'planning',
        isRunning: true,
        processedItems: 0,
        totalItems: totalExpectedMusicItems,
        copiedFiles,
        deletedFiles,
        startedAt,
        targetDirectory: dapTargetDirectory,
        syncRootPath,
        canResume: false,
        resumedFromProcessedItems: completedRelativePathSet.size,
        errorMessage: undefined,
      });
      let planningProcessedItems = 0;
      let planningLastProgressUpdateAt = 0;
      const resumeValidation = await Promise.map(trackItems, async (trackItem) => {
        if (signal.aborted) {
          throw this.toDapAbortError();
        }
        const destinationCheck = await this.checkDestinationCurrent(trackItem.sourcePath, trackItem.destinationPath, {
          sourceSize: trackItem.sourceSize,
          sourceMtimeMs: trackItem.sourceMtimeMs,
          syncStateEntry: syncStateEntries.get(trackItem.relativePath),
          signal,
        });
        if (destinationCheck.isCurrent && destinationCheck.syncStateEntry) {
          syncStateEntries.set(trackItem.relativePath, destinationCheck.syncStateEntry);
        }
        planningProcessedItems += 1;
        const now = Date.now();
        if (planningProcessedItems % 20 === 0 || (now - planningLastProgressUpdateAt) > 250 || planningProcessedItems >= trackItems.length) {
          planningLastProgressUpdateAt = now;
          this.updateDapSyncProgress({
            phase: 'planning',
            isRunning: true,
            processedItems: planningProcessedItems,
            totalItems: totalExpectedMusicItems,
            copiedFiles,
            deletedFiles,
            startedAt,
            targetDirectory: dapTargetDirectory,
            syncRootPath,
            canResume: false,
            resumedFromProcessedItems: completedRelativePathSet.size,
            errorMessage: undefined,
          });
        }
        return {
          ...trackItem,
          alreadyCompleted: destinationCheck.isCurrent,
        };
      }, { concurrency: 4 });
      const resumedValidRelativePaths = resumeValidation
        .filter(item => item.alreadyCompleted)
        .map(item => item.relativePath);
      const resumedValidRelativePathSet = new Set(resumedValidRelativePaths);
      const pendingTrackItems = resumeValidation.filter(item => !item.alreadyCompleted);

      this.persistDapSyncCheckpoint({
        targetDirectory: dapTargetDirectory,
        syncRootPath,
        completedRelativePaths: resumedValidRelativePaths,
        copiedFiles,
        deletedFiles,
      });

      this.updateDapSyncProgress({
        phase: 'copying',
        isRunning: true,
        processedItems: resumedValidRelativePathSet.size,
        totalItems: totalExpectedMusicItems,
        copiedFiles,
        deletedFiles,
        startedAt,
        targetDirectory: dapTargetDirectory,
        syncRootPath,
        canResume: false,
        resumedFromProcessedItems: resumedValidRelativePathSet.size,
        errorMessage: undefined,
      });

      let lastCheckpointPersistAt = 0;
      let lastProgressUpdateAt = 0;
      const persistDapProgressState = (force = false) => {
        const now = Date.now();
        if (!force && resumedValidRelativePathSet.size > 0 && resumedValidRelativePathSet.size % 20 !== 0 && (now - lastCheckpointPersistAt) < 1200) {
          return;
        }
        lastCheckpointPersistAt = now;
        this.persistDapSyncCheckpoint({
          targetDirectory: dapTargetDirectory,
          syncRootPath,
          completedRelativePaths: [...resumedValidRelativePathSet],
          copiedFiles,
          deletedFiles,
        });
        this.persistDapSyncState({
          targetDirectory: dapTargetDirectory,
          syncRootPath,
          entries: Object.fromEntries(syncStateEntries.entries()),
        });
      };
      const publishCopyProgress = (force = false) => {
        const now = Date.now();
        if (!force && resumedValidRelativePathSet.size > 0 && resumedValidRelativePathSet.size % 10 !== 0 && (now - lastProgressUpdateAt) < 200) {
          return;
        }
        lastProgressUpdateAt = now;
        this.updateDapSyncProgress({
          phase: 'copying',
          isRunning: true,
          processedItems: resumedValidRelativePathSet.size,
          totalItems: totalExpectedMusicItems,
          copiedFiles,
          deletedFiles,
          startedAt,
          targetDirectory: dapTargetDirectory,
          syncRootPath,
          canResume: false,
          resumedFromProcessedItems: resumedValidRelativePathSet.size,
          errorMessage: undefined,
        });
      };

      await Promise.map(pendingTrackItems, async (trackItem) => {
        if (signal.aborted) {
          throw this.toDapAbortError();
        }

        let trackSynchronized = false;
        let trackSyncCheck: IDapDestinationCheckResult | undefined;
        try {
          await fs.promises.mkdir(path.dirname(trackItem.destinationPath), { recursive: true });
          await this.tryMigrateLegacyDapFile(trackItem);
          const preCopyCheck = await this.checkDestinationCurrent(trackItem.sourcePath, trackItem.destinationPath, {
            sourceSize: trackItem.sourceSize,
            sourceMtimeMs: trackItem.sourceMtimeMs,
            syncStateEntry: syncStateEntries.get(trackItem.relativePath),
            signal,
          });
          const shouldCopy = !preCopyCheck.isCurrent;
          if (shouldCopy) {
            await fs.promises.copyFile(trackItem.sourcePath, trackItem.destinationPath);
            copiedFiles += 1;
            trackSyncCheck = await this.checkDestinationCurrent(trackItem.sourcePath, trackItem.destinationPath, {
              sourceSize: trackItem.sourceSize,
              sourceMtimeMs: trackItem.sourceMtimeMs,
              syncStateEntry: syncStateEntries.get(trackItem.relativePath),
              signal,
            });
            trackSynchronized = trackSyncCheck.isCurrent;
          } else {
            trackSyncCheck = preCopyCheck;
            trackSynchronized = true;
          }
        } catch (error) {
          if (signal.aborted) {
            throw this.toDapAbortError();
          }
          if (this.isDapDeviceUnavailableError(error)) {
            throw this.toDapAbortError(this.dapSyncDeviceRemovedErrorCode);
          }
          skippedFiles += 1;
          debug('Skipping DAP sync file after error: %o', {
            sourcePath: trackItem.sourcePath,
            destinationPath: trackItem.destinationPath,
            error: String((error as any)?.message || error),
          });
        }

        if (!trackSynchronized) {
          publishCopyProgress();
          return;
        }

        resumedValidRelativePathSet.add(trackItem.relativePath);
        const syncStateEntry = trackSyncCheck?.syncStateEntry;
        if (syncStateEntry) {
          syncStateEntries.set(trackItem.relativePath, syncStateEntry);
        }
        persistDapProgressState();
        publishCopyProgress();
      }, { concurrency: 1 });
      persistDapProgressState(true);
      publishCopyProgress(true);

      if (signal.aborted) {
        throw this.toDapAbortError();
      }

      if (deleteMissingOnDevice) {
        const allDeviceFiles = await this.getFilesRecursive(syncRootPath);
        const staleDeviceFiles = allDeviceFiles.filter((deviceFilePath) => {
          const relativePath = path.relative(syncRootPath, deviceFilePath).split(path.sep).join('/');
          if (expectedRelativePaths.has(relativePath)) {
            return false;
          }
          return this.isManagedDapMusicRelativePath(relativePath) && !this.isIgnoredDapRelativePath(relativePath);
        });
        const staleRelativePaths = [...syncStateEntries.keys()].filter(relativePath => !expectedRelativePaths.has(relativePath));
        staleRelativePaths.forEach(relativePath => syncStateEntries.delete(relativePath));

        this.updateDapSyncProgress({
          phase: 'cleaning',
          isRunning: true,
          processedItems: resumedValidRelativePathSet.size,
          totalItems: totalExpectedMusicItems,
          copiedFiles,
          deletedFiles,
          startedAt,
          targetDirectory: dapTargetDirectory,
          syncRootPath,
          canResume: false,
          resumedFromProcessedItems: resumedValidRelativePathSet.size,
          errorMessage: undefined,
        });

        await Promise.map(staleDeviceFiles, async (staleDeviceFilePath) => {
          if (signal.aborted) {
            throw this.toDapAbortError();
          }

          let deletedInThisPass = false;
          try {
            await fs.promises.unlink(staleDeviceFilePath);
            deletedInThisPass = true;
          } catch (error) {
            const errorCode = String((error as any)?.code || '').toUpperCase();
            if (errorCode === 'ENOENT') {
              deletedInThisPass = false;
            } else if (this.isDapDeviceUnavailableError(error)) {
              throw this.toDapAbortError(this.dapSyncDeviceRemovedErrorCode);
            }
          }
          if (deletedInThisPass) {
            deletedFiles += 1;
          }

          persistDapProgressState();
          this.updateDapSyncProgress({
            phase: 'cleaning',
            isRunning: true,
            processedItems: resumedValidRelativePathSet.size,
            totalItems: totalExpectedMusicItems,
            copiedFiles,
            deletedFiles,
            startedAt,
            targetDirectory: dapTargetDirectory,
            syncRootPath,
            canResume: false,
            resumedFromProcessedItems: resumedValidRelativePathSet.size,
            errorMessage: undefined,
          });
        }, { concurrency: 1 });
        persistDapProgressState(true);
      }

      const podcastSyncResult = await PodcastService.syncPodcastsToDap({
        targetDirectory: dapTargetDirectory,
        deleteMissingOnDevice,
        signal,
      });
      copiedFiles += podcastSyncResult.copiedFiles;
      deletedFiles += podcastSyncResult.deletedFiles;
      const totalExpectedItemsWithPodcasts = trackItems.length + podcastSyncResult.totalFiles;
      const synchronizedItemsWithPodcasts = resumedValidRelativePathSet.size + podcastSyncResult.syncedFiles;
      const missingItems = Math.max(0, totalExpectedItemsWithPodcasts - synchronizedItemsWithPodcasts);
      this.persistDapSyncState({
        targetDirectory: dapTargetDirectory,
        syncRootPath,
        entries: Object.fromEntries(syncStateEntries.entries()),
      });

      this.clearDapSyncCheckpoint();
      const result = {
        copiedFiles,
        deletedFiles,
        totalTracks: synchronizedItemsWithPodcasts,
      };

      this.updateDapSyncProgress({
        phase: 'done',
        isRunning: false,
        processedItems: synchronizedItemsWithPodcasts,
        totalItems: totalExpectedItemsWithPodcasts,
        copiedFiles: result.copiedFiles,
        deletedFiles: result.deletedFiles,
        startedAt,
        targetDirectory: dapTargetDirectory,
        syncRootPath,
        canResume: false,
        resumedFromProcessedItems: 0,
        errorMessage: missingItems > 0 ? `${missingItems} Datei(en) fehlen und werden beim nächsten Sync nachgeholt.` : undefined,
      });

      if (!options?.silent) {
        NotificationService.showMessage(`DAP Sync: ${result.copiedFiles} kopiert, ${result.deletedFiles} gelöscht, ${result.totalTracks} Titel synchronisiert, ${skippedFiles} übersprungen.`);
        await this.promptEjectDapTarget(dapTargetDirectory);
      }

      return result;
    })()
      .catch((error) => {
        const abortedByUser = error?.message === this.dapSyncAbortErrorCode || error?.name === 'AbortError';
        const abortedByDeviceRemoval = error?.message === this.dapSyncDeviceRemovedErrorCode
          || this.isDapDeviceUnavailableError(error);
        if (abortedByUser || abortedByDeviceRemoval) {
          const checkpoint = this.loadDapSyncCheckpoint(dapTargetDirectory, path.join(dapTargetDirectory, this.dapSyncDirectoryName));
          this.updateDapSyncProgress({
            phase: 'aborted',
            isRunning: false,
            canResume: true,
            resumedFromProcessedItems: checkpoint?.completedRelativePaths.length || 0,
            errorMessage: abortedByDeviceRemoval ? `DAP target directory unavailable: ${dapTargetDirectory}` : undefined,
          });
          return {
            copiedFiles: this.dapSyncProgressSnapshot.copiedFiles,
            deletedFiles: this.dapSyncProgressSnapshot.deletedFiles,
            totalTracks: this.dapSyncProgressSnapshot.totalItems,
          };
        }

        const errorCode = String((error as any)?.code || '');
        const normalizedErrorMessage = (errorCode === 'ENODEV' || errorCode === 'EIO' || errorCode === 'ENXIO' || errorCode === 'ENOTDIR')
          ? `DAP target directory unavailable: ${dapTargetDirectory}`
          : String(error?.message || error);
        this.updateDapSyncProgress({
          phase: 'error',
          isRunning: false,
          canResume: false,
          errorMessage: normalizedErrorMessage,
        });
        throw error;
      })
      .finally(() => {
        clearInterval(dapTargetAvailabilityMonitor);
        this.dapCurrentRunLibrarySyncGeneration = undefined;
        this.dapSilentRunHoldPriorSummaryForUi = false;
        if (this.dapSyncAbortController === abortController) {
          this.dapSyncAbortController = null;
        }
        this.dapSyncPromise = null;
      });

    this.dapSyncPromise = syncPromise;
    return syncPromise;
  }

  static async syncDapLibraryIfEnabled(options?: {
    silent?: boolean;
    /** Incremented in app when the media library finishes a sync pass (dedupes duplicate auto DAP after the same completion). */
    librarySyncGeneration?: number;
  }): Promise<void> {
    const settings = this.getDapSyncSettings();
    if (!settings.autoSyncEnabled) {
      return;
    }
    if (settings.transport === 'filesystem' && !String(settings.targetDirectory || '').trim()) {
      return;
    }

    const silent = options?.silent ?? true;
    const gen = options?.librarySyncGeneration;
    const raw = this.dapSyncProgressSnapshot;
    if (silent && gen !== undefined
      && raw.phase === 'done' && !raw.isRunning
      && gen === this.dapLibrarySyncGenerationLastConsumedForDone) {
      return;
    }

    await this.syncDapLibrary({
      targetDirectory: settings.targetDirectory,
      deleteMissingOnDevice: settings.deleteMissingOnDevice,
      silent,
      transport: settings.transport,
      librarySyncGeneration: gen,
    });
  }

  private static toDapAbortError(code = this.dapSyncAbortErrorCode): Error {
    const error = new Error(code) as Error & { code?: string };
    error.code = code;
    return error;
  }

  private static isDapDeviceUnavailableError(error: any): boolean {
    const errorCode = String(error?.code || '').toUpperCase();
    if (errorCode === 'ENODEV' || errorCode === 'EIO' || errorCode === 'ENXIO' || errorCode === 'ENOTDIR') {
      return true;
    }
    const errorMessage = String(error?.message || error || '').toLowerCase();
    return errorMessage.includes('device not configured')
      || errorMessage.includes('input/output error')
      || errorMessage.includes('target directory unavailable');
  }

  private static sanitizePathPart(value: string): string {
    const normalizedValue = String(value || '').trim();
    const sanitizedValue = normalizedValue
      .replace(/[<>:"/\\|?*]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return sanitizedValue || 'Unknown';
  }

  private static truncatePathPart(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }

    return value.slice(0, Math.max(8, maxLength)).trim();
  }

  private static disambiguateRelativePath(relativePath: string, sourcePath: string, duplicateIndex: number): string {
    const extension = path.extname(relativePath);
    const filePathWithoutExtension = extension
      ? relativePath.slice(0, -extension.length)
      : relativePath;
    const fingerprint = createHash('sha1')
      .update(`${sourcePath}|${duplicateIndex}`)
      .digest('hex')
      .slice(0, 8);
    return `${filePathWithoutExtension} [${fingerprint}]${extension}`;
  }

  private static async getFilesRecursive(directoryPath: string): Promise<string[]> {
    const directoryEntries = await fs.promises.readdir(directoryPath, { withFileTypes: true }).catch(() => []);
    const filePaths = await Promise.all(directoryEntries.map(async (directoryEntry) => {
      const fullPath = path.join(directoryPath, directoryEntry.name);
      if (directoryEntry.isDirectory()) {
        return this.getFilesRecursive(fullPath);
      }

      return [fullPath];
    }));

    return filePaths.flat();
  }

  private static async promptEjectDapTarget(targetDirectory: string): Promise<void> {
    const targetName = path.basename(targetDirectory) || targetDirectory;
    const askConfirmation = (window as any).confirm as ((message?: string) => boolean) | undefined;
    const shouldEject = askConfirmation ? askConfirmation(`DAP Sync abgeschlossen. Soll das Volume "${targetName}" jetzt ausgeworfen werden?`) : false;
    if (!shouldEject) {
      return;
    }

    const isEjected = await IPCRenderer.sendAsyncMessage(IPCCommChannel.DeviceEjectVolume, {
      targetPath: targetDirectory,
    }).catch(() => false);

    NotificationService.showMessage(isEjected
      ? `Volume "${targetName}" wurde ausgeworfen.`
      : `Volume "${targetName}" konnte nicht ausgeworfen werden.`);
  }

  private static isIgnoredDapRelativePath(relativePath: string): boolean {
    const normalizedRelativePath = String(relativePath || '').split('\\').join('/').replace(/^\/+/, '');
    if (!normalizedRelativePath) {
      return true;
    }
    const parts = normalizedRelativePath.split('/').filter(Boolean);
    if (parts.length === 0) {
      return true;
    }
    if (parts.some(part => part.startsWith('.'))) {
      return true;
    }
    const normalizedLowerPath = normalizedRelativePath.toLowerCase();
    if (normalizedLowerPath.startsWith('$recycle.bin/')) {
      return true;
    }
    if (normalizedLowerPath.startsWith('system volume information/')) {
      return true;
    }
    const fileName = String(parts[parts.length - 1] || '').toLowerCase();
    return fileName === 'thumbs.db' || fileName === 'desktop.ini';
  }

  private static isManagedDapMusicRelativePath(relativePath: string): boolean {
    const normalizedRelativePath = String(relativePath || '').split('\\').join('/');
    return /\[[a-f0-9]{8}\]\.[^./\\]+$/i.test(normalizedRelativePath);
  }

  private static resolveTrackDiscNumber(mediaTrack: IMediaTrack): number {
    const extraDiscNumber = Number((mediaTrack.extra as any)?.disc_number || 0);
    if (Number.isFinite(extraDiscNumber) && extraDiscNumber > 0) {
      return Math.floor(extraDiscNumber);
    }
    const filePath = String((mediaTrack.extra as any)?.file_path || '');
    const matches = Array.from(filePath.matchAll(/(?:^|[\\/])(disc|cd)\s*(\d+)(?:[\\/]|$)/ig));
    if (matches.length > 0) {
      const discFromPath = Number(matches[matches.length - 1]?.[2] || 0);
      if (Number.isFinite(discFromPath) && discFromPath > 0) {
        return Math.floor(discFromPath);
      }
    }
    return 0;
  }

  private static async tryMigrateLegacyDapFile(trackItem: {
    sourcePath: string;
    destinationPath: string;
    legacyDestinationPaths?: string[];
    sourceSize?: number;
    sourceMtimeMs?: number;
  }): Promise<void> {
    if (_.isEmpty(trackItem.legacyDestinationPaths)) {
      return;
    }
    const destinationExists = !!(await fs.promises.stat(trackItem.destinationPath).catch(() => undefined));
    if (destinationExists) {
      return;
    }

    const legacyDestinationPaths = trackItem.legacyDestinationPaths || [];
    const tryAtIndex = async (index: number): Promise<boolean> => {
      if (index >= legacyDestinationPaths.length) {
        return false;
      }
      const legacyDestinationPath = legacyDestinationPaths[index];
      const legacyCurrent = await this.checkDestinationCurrent(trackItem.sourcePath, legacyDestinationPath, {
        sourceSize: trackItem.sourceSize,
        sourceMtimeMs: trackItem.sourceMtimeMs,
        syncStateEntry: undefined,
      });
      if (!legacyCurrent.isCurrent) {
        return tryAtIndex(index + 1);
      }

      await fs.promises.mkdir(path.dirname(trackItem.destinationPath), { recursive: true });
      try {
        await fs.promises.rename(legacyDestinationPath, trackItem.destinationPath);
        return true;
      } catch (error: any) {
        if (String(error?.code || '').toUpperCase() === 'EXDEV') {
          await fs.promises.copyFile(legacyDestinationPath, trackItem.destinationPath);
          await fs.promises.unlink(legacyDestinationPath).catch(() => undefined);
          return true;
        }
        throw error;
      }
    };
    await tryAtIndex(0);
  }

  private static updateDapSyncProgress(partial: Partial<IDapSyncProgressSnapshot>) {
    const nextSnapshot = {
      ...this.dapSyncProgressSnapshot,
      ...partial,
    };
    const elapsedMs = nextSnapshot.startedAt > 0 ? Math.max(0, Date.now() - nextSnapshot.startedAt) : 0;
    const canEstimate = nextSnapshot.isRunning
      && nextSnapshot.processedItems > 0
      && nextSnapshot.totalItems > nextSnapshot.processedItems;
    const etaMs = canEstimate
      ? Math.max(0, Math.round((elapsedMs / nextSnapshot.processedItems) * (nextSnapshot.totalItems - nextSnapshot.processedItems)))
      : undefined;
    this.dapSyncProgressSnapshot = {
      ...nextSnapshot,
      elapsedMs,
      etaMs,
    };

    if (nextSnapshot.phase === 'done' && !nextSnapshot.isRunning) {
      this.dapSyncLastCompletedSummary = { ...this.dapSyncProgressSnapshot };
      this.persistDapLastCompletedSummary(this.dapSyncLastCompletedSummary);
      if (this.dapCurrentRunLibrarySyncGeneration !== undefined) {
        this.dapLibrarySyncGenerationLastConsumedForDone = this.dapCurrentRunLibrarySyncGeneration;
      }
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(this.dapSyncProgressEventName, {
        detail: this.getDapSyncProgressSnapshot(),
      }));
    }
  }

  private static loadDapSyncCheckpoint(targetDirectory: string, syncRootPath: string): IDapSyncCheckpoint | null {
    const rawCheckpoint = localStorage.getItem(this.dapSyncCheckpointStorageKey);
    if (!rawCheckpoint) {
      return null;
    }

    try {
      const parsedCheckpoint = JSON.parse(rawCheckpoint) as IDapSyncCheckpoint;
      if (parsedCheckpoint.targetDirectory !== targetDirectory || parsedCheckpoint.syncRootPath !== syncRootPath) {
        return null;
      }

      return {
        ...parsedCheckpoint,
        completedRelativePaths: _.uniq(parsedCheckpoint.completedRelativePaths || []),
      };
    } catch (_error) {
      return null;
    }
  }

  private static persistDapSyncCheckpoint(checkpoint: {
    targetDirectory: string;
    syncRootPath: string;
    completedRelativePaths: string[];
    copiedFiles: number;
    deletedFiles: number;
  }) {
    localStorage.setItem(this.dapSyncCheckpointStorageKey, JSON.stringify({
      ...checkpoint,
      completedRelativePaths: _.uniq(checkpoint.completedRelativePaths),
      updatedAt: Date.now(),
    }));
  }

  private static clearDapSyncCheckpoint() {
    localStorage.removeItem(this.dapSyncCheckpointStorageKey);
  }

  private static clearDapSyncState() {
    localStorage.removeItem(this.dapSyncStateStorageKey);
  }

  private static loadDapSyncState(targetDirectory: string, syncRootPath: string): IDapSyncState | null {
    const rawState = localStorage.getItem(this.dapSyncStateStorageKey);
    if (!rawState) {
      return null;
    }

    try {
      const parsedState = JSON.parse(rawState) as IDapSyncState;
      if (parsedState.targetDirectory !== targetDirectory || parsedState.syncRootPath !== syncRootPath) {
        return null;
      }
      return {
        ...parsedState,
        entries: parsedState.entries || {},
      };
    } catch (_error) {
      return null;
    }
  }

  private static persistDapSyncState(state: {
    targetDirectory: string;
    syncRootPath: string;
    entries: Record<string, IDapSyncStateEntry>;
  }) {
    localStorage.setItem(this.dapSyncStateStorageKey, JSON.stringify({
      ...state,
      updatedAt: Date.now(),
    }));
  }

  private static async checkDestinationCurrent(
    sourcePath: string,
    destinationPath: string,
    sourceMeta?: { sourceSize?: number; sourceMtimeMs?: number; syncStateEntry?: IDapSyncStateEntry; signal?: AbortSignal },
  ): Promise<IDapDestinationCheckResult> {
    if (sourceMeta?.signal?.aborted) {
      throw this.toDapAbortError();
    }
    const destinationStats = await fs.promises.stat(destinationPath).catch(() => undefined);
    if (!destinationStats) {
      return {
        isCurrent: false,
      };
    }

    const sourceStats = (!sourceMeta?.sourceSize || !sourceMeta?.sourceMtimeMs)
      ? await fs.promises.stat(sourcePath).catch(() => undefined)
      : undefined;
    const sourceSize = Number(sourceMeta?.sourceSize || sourceStats?.size || 0);
    const sourceMtimeMs = Number(sourceMeta?.sourceMtimeMs || sourceStats?.mtimeMs || 0);
    if (!Number.isFinite(sourceSize) || sourceSize < 0 || destinationStats.size !== sourceSize) {
      return {
        isCurrent: false,
      };
    }

    if (sourceSize === 0) {
      return {
        isCurrent: true,
        syncStateEntry: {
          sourceSize,
          sourceMtimeMs,
          destinationSize: destinationStats.size,
          destinationMtimeMs: Number(destinationStats.mtimeMs || 0),
        },
      };
    }

    const cachedEntry = sourceMeta?.syncStateEntry;
    if (cachedEntry
      && cachedEntry.sourceSize === sourceSize
      && cachedEntry.sourceMtimeMs === sourceMtimeMs
      && cachedEntry.destinationSize === destinationStats.size
      && Number(cachedEntry.destinationMtimeMs || 0) === Number(destinationStats.mtimeMs || 0)
      && !!cachedEntry.sourceHash
      && cachedEntry.sourceHash === cachedEntry.destinationHash) {
      return {
        isCurrent: true,
        syncStateEntry: cachedEntry,
      };
    }

    const sourceHash = (cachedEntry
      && cachedEntry.sourceSize === sourceSize
      && cachedEntry.sourceMtimeMs === sourceMtimeMs
      && cachedEntry.sourceHash)
      ? cachedEntry.sourceHash
      : await this.hashFileSha1(sourcePath, sourceMeta?.signal);
    const destinationHash = (cachedEntry
      && cachedEntry.destinationSize === destinationStats.size
      && Number(cachedEntry.destinationMtimeMs || 0) === Number(destinationStats.mtimeMs || 0)
      && cachedEntry.destinationHash)
      ? cachedEntry.destinationHash
      : await this.hashFileSha1(destinationPath, sourceMeta?.signal);

    return {
      isCurrent: !!sourceHash && sourceHash === destinationHash,
      syncStateEntry: {
        sourceSize,
        sourceMtimeMs,
        sourceHash,
        destinationSize: destinationStats.size,
        destinationMtimeMs: Number(destinationStats.mtimeMs || 0),
        destinationHash,
      },
    };
  }

  private static hashFileSha1(filePath: string, signal?: AbortSignal): Promise<string | undefined> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(undefined);
        return;
      }
      const hash = createHash('sha1');
      const stream = fs.createReadStream(filePath);
      const handleAbort = () => {
        stream.destroy(this.toDapAbortError());
      };
      if (signal) {
        signal.addEventListener('abort', handleAbort, { once: true });
      }

      stream.on('error', () => resolve(undefined));
      stream.on('data', (chunk) => {
        if (signal?.aborted) {
          stream.destroy(this.toDapAbortError());
          return;
        }
        const hashChunk = typeof chunk === 'string'
          ? new TextEncoder().encode(chunk)
          : Uint8Array.from(chunk as unknown as ArrayLike<number>);
        hash.update(hashChunk);
      });
      stream.on('end', () => {
        if (signal) {
          signal.removeEventListener('abort', handleAbort);
        }
        resolve(hash.digest('hex'));
      });
      stream.on('close', () => {
        if (signal) {
          signal.removeEventListener('abort', handleAbort);
        }
      });
    });
  }

  private static async deleteUnsyncMedia(mediaProviderIdentifier: string, mediaSyncStartTimestamp: number): Promise<void> {
    await MediaTrackDatastore.deleteTracks({
      provider: mediaProviderIdentifier,
      sync_timestamp: {
        $lt: mediaSyncStartTimestamp,
      },
    });
    await MediaAlbumDatastore.deleteAlbums({
      provider: mediaProviderIdentifier,
      sync_timestamp: {
        $lt: mediaSyncStartTimestamp,
      },
    });
    await MediaArtistDatastore.deleteArtists({
      provider: mediaProviderIdentifier,
      sync_timestamp: {
        $lt: mediaSyncStartTimestamp,
      },
    });
  }
}
