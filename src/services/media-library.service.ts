import _ from 'lodash';
import fs from 'fs';
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
import { NotificationService } from './notification.service';
import { PodcastService } from './podcast.service';

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
}

interface IDapSyncState {
  targetDirectory: string;
  syncRootPath: string;
  entries: Record<string, IDapSyncStateEntry>;
  updatedAt: number;
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
  private static dapSyncAbortController: AbortController | null = null;
  private static dapSyncPromise: Promise<{ copiedFiles: number; deletedFiles: number; totalTracks: number }> | null = null;
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
      extra: mediaTrackInputData.extra,
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

  static getDapSyncSettings(): {
    targetDirectory: string;
    autoSyncEnabled: boolean;
    deleteMissingOnDevice: boolean;
  } {
    const fallback = {
      targetDirectory: '',
      autoSyncEnabled: false,
      deleteMissingOnDevice: true,
    };

    const rawSettings = localStorage.getItem(this.dapSyncSettingsStorageKey);
    if (!rawSettings) {
      return fallback;
    }

    try {
      const parsedSettings = JSON.parse(rawSettings);
      return {
        targetDirectory: String(parsedSettings?.targetDirectory || ''),
        autoSyncEnabled: Boolean(parsedSettings?.autoSyncEnabled),
        deleteMissingOnDevice: parsedSettings?.deleteMissingOnDevice !== false,
      };
    } catch (_error) {
      return fallback;
    }
  }

  static saveDapSyncSettings(input: {
    targetDirectory: string;
    autoSyncEnabled: boolean;
    deleteMissingOnDevice: boolean;
  }) {
    localStorage.setItem(this.dapSyncSettingsStorageKey, JSON.stringify({
      targetDirectory: String(input.targetDirectory || ''),
      autoSyncEnabled: Boolean(input.autoSyncEnabled),
      deleteMissingOnDevice: Boolean(input.deleteMissingOnDevice),
    }));
  }

  static getDapSyncProgressSnapshot(): IDapSyncProgressSnapshot {
    return {
      ...this.dapSyncProgressSnapshot,
    };
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

  static async syncDapLibrary(options?: {
    targetDirectory?: string;
    deleteMissingOnDevice?: boolean;
    silent?: boolean;
  }): Promise<{ copiedFiles: number; deletedFiles: number; totalTracks: number }> {
    if (this.dapSyncPromise) {
      return this.dapSyncPromise;
    }

    const settings = this.getDapSyncSettings();
    const configuredTargetDirectory = String(options?.targetDirectory || settings.targetDirectory || '').trim();
    if (!configuredTargetDirectory) {
      throw new Error('No DAP target directory configured');
    }

    let dapTargetDirectory = configuredTargetDirectory;
    if (path.basename(dapTargetDirectory).toLowerCase() === this.dapSyncDirectoryName.toLowerCase()) {
      dapTargetDirectory = path.dirname(dapTargetDirectory);
    }
    this.saveDapSyncSettings({
      targetDirectory: dapTargetDirectory,
      autoSyncEnabled: settings.autoSyncEnabled,
      deleteMissingOnDevice: settings.deleteMissingOnDevice,
    });

    const abortController = new AbortController();
    this.dapSyncAbortController = abortController;
    const { signal } = abortController;

    const syncPromise = (async () => {
      const deleteMissingOnDevice = options?.deleteMissingOnDevice ?? settings.deleteMissingOnDevice;
      const syncRootPath = path.join(dapTargetDirectory, this.dapSyncDirectoryName);
      const startedAt = Date.now();
      const dapTargetStat = await fs.promises.stat(dapTargetDirectory).catch(() => undefined);
      if (!dapTargetStat || !dapTargetStat.isDirectory()) {
        throw new Error(`DAP target directory unavailable: ${dapTargetDirectory}`);
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

      const trackDataList = await MediaTrackDatastore.findMediaTracks();
      const mediaTracks = await MediaTrackService.buildMediaTracks(trackDataList);
      const tracksWithPaths = mediaTracks.filter((mediaTrack) => {
        const filePath = String((mediaTrack.extra as any)?.file_path || '');
        return !_.isEmpty(filePath) && fs.existsSync(filePath);
      });

      const trackItems = tracksWithPaths.map((mediaTrack) => {
        const sourcePath = String((mediaTrack.extra as any)?.file_path || '');
        const sourceExtension = path.extname(sourcePath) || '.flac';
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
        const relativePath = path
          .join(artistName, albumDirectoryName, this.truncatePathPart(`${baseFileName} [${uniqueSuffix}]${sourceExtension}`, 160))
          .split(path.sep)
          .join('/');
        const destinationPath = path.join(syncRootPath, relativePath.split('/').join(path.sep));
        const sourceSize = Number((mediaTrack.extra as any)?.file_size);
        const sourceMtimeMs = Number((mediaTrack.extra as any)?.file_mtime);
        return {
          relativePath,
          sourcePath,
          destinationPath,
          sourceSize: Number.isFinite(sourceSize) && sourceSize > 0 ? sourceSize : undefined,
          sourceMtimeMs: Number.isFinite(sourceMtimeMs) && sourceMtimeMs > 0 ? sourceMtimeMs : undefined,
        };
      });

      const expectedRelativePaths = new Set(trackItems.map(item => item.relativePath));
      const resumeValidation = await Promise.all(trackItems.map(async (trackItem) => {
        if (!completedRelativePathSet.has(trackItem.relativePath)) {
          return {
            ...trackItem,
            alreadyCompleted: false,
          };
        }

        const stateEntry = syncStateEntries.get(trackItem.relativePath);
        if (stateEntry
          && trackItem.sourceSize
          && trackItem.sourceMtimeMs
          && stateEntry.sourceSize === trackItem.sourceSize
          && stateEntry.sourceMtimeMs === trackItem.sourceMtimeMs) {
          const destinationStats = await fs.promises.stat(trackItem.destinationPath).catch(() => undefined);
          return {
            ...trackItem,
            alreadyCompleted: !!destinationStats,
          };
        }
        const destinationIsCurrent = await this.checkDestinationCurrent(trackItem.sourcePath, trackItem.destinationPath, {
          sourceSize: trackItem.sourceSize,
          sourceMtimeMs: trackItem.sourceMtimeMs,
        });
        return {
          ...trackItem,
          alreadyCompleted: destinationIsCurrent,
        };
      }));
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
        totalItems: trackItems.length,
        copiedFiles,
        deletedFiles,
        startedAt,
        targetDirectory: dapTargetDirectory,
        syncRootPath,
        canResume: false,
        resumedFromProcessedItems: resumedValidRelativePathSet.size,
        errorMessage: undefined,
      });

      await Promise.map(pendingTrackItems, async (trackItem) => {
        if (signal.aborted) {
          throw new Error('DAP_SYNC_ABORTED');
        }

        try {
          await fs.promises.mkdir(path.dirname(trackItem.destinationPath), { recursive: true });
          const shouldCopy = !(await this.checkDestinationCurrent(trackItem.sourcePath, trackItem.destinationPath, {
            sourceSize: trackItem.sourceSize,
            sourceMtimeMs: trackItem.sourceMtimeMs,
          }));
          if (shouldCopy) {
            await fs.promises.copyFile(trackItem.sourcePath, trackItem.destinationPath);
            copiedFiles += 1;
          }
        } catch (error) {
          if (signal.aborted) {
            throw new Error('DAP_SYNC_ABORTED');
          }
          skippedFiles += 1;
          debug('Skipping DAP sync file after error: %o', {
            sourcePath: trackItem.sourcePath,
            destinationPath: trackItem.destinationPath,
            error: String((error as any)?.message || error),
          });
        }

        resumedValidRelativePathSet.add(trackItem.relativePath);
        const syncStateSourceSize = trackItem.sourceSize || Number((await fs.promises.stat(trackItem.sourcePath).catch(() => undefined))?.size || 0);
        const syncStateSourceMtimeMs = trackItem.sourceMtimeMs || Number((await fs.promises.stat(trackItem.sourcePath).catch(() => undefined))?.mtimeMs || 0);
        if (syncStateSourceSize > 0 && syncStateSourceMtimeMs > 0) {
          syncStateEntries.set(trackItem.relativePath, {
            sourceSize: syncStateSourceSize,
            sourceMtimeMs: syncStateSourceMtimeMs,
          });
        }
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
        this.updateDapSyncProgress({
          phase: 'copying',
          isRunning: true,
          processedItems: resumedValidRelativePathSet.size,
          totalItems: trackItems.length,
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

      if (signal.aborted) {
        throw new Error('DAP_SYNC_ABORTED');
      }

      if (deleteMissingOnDevice) {
        const allDeviceFiles = await this.getFilesRecursive(syncRootPath);
        const staleDeviceFiles = allDeviceFiles.filter((deviceFilePath) => {
          const relativePath = path.relative(syncRootPath, deviceFilePath).split(path.sep).join('/');
          return !expectedRelativePaths.has(relativePath);
        });
        const staleRelativePaths = [...syncStateEntries.keys()].filter(relativePath => !expectedRelativePaths.has(relativePath));
        staleRelativePaths.forEach(relativePath => syncStateEntries.delete(relativePath));

        this.updateDapSyncProgress({
          phase: 'cleaning',
          isRunning: true,
          processedItems: resumedValidRelativePathSet.size,
          totalItems: trackItems.length + staleDeviceFiles.length,
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
            throw new Error('DAP_SYNC_ABORTED');
          }

          await fs.promises.unlink(staleDeviceFilePath).catch(() => undefined);
          deletedFiles += 1;

          this.persistDapSyncCheckpoint({
            targetDirectory: dapTargetDirectory,
            syncRootPath,
            completedRelativePaths: [...resumedValidRelativePathSet],
            copiedFiles,
            deletedFiles,
          });
          this.updateDapSyncProgress({
            phase: 'cleaning',
            isRunning: true,
            processedItems: resumedValidRelativePathSet.size + deletedFiles,
            totalItems: trackItems.length + staleDeviceFiles.length,
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
      }

      const podcastSyncResult = await PodcastService.syncPodcastsToDap({
        targetDirectory: dapTargetDirectory,
        deleteMissingOnDevice,
      });
      copiedFiles += podcastSyncResult.copiedFiles;
      deletedFiles += podcastSyncResult.deletedFiles;
      this.persistDapSyncState({
        targetDirectory: dapTargetDirectory,
        syncRootPath,
        entries: Object.fromEntries(syncStateEntries.entries()),
      });

      this.clearDapSyncCheckpoint();
      const result = {
        copiedFiles,
        deletedFiles,
        totalTracks: tracksWithPaths.length,
      };

      this.updateDapSyncProgress({
        phase: 'done',
        isRunning: false,
        processedItems: trackItems.length + deletedFiles,
        totalItems: trackItems.length + deletedFiles,
        copiedFiles: result.copiedFiles,
        deletedFiles: result.deletedFiles,
        startedAt,
        targetDirectory: dapTargetDirectory,
        syncRootPath,
        canResume: false,
        resumedFromProcessedItems: 0,
        errorMessage: undefined,
      });

      if (!options?.silent) {
        NotificationService.showMessage(`DAP Sync: ${result.copiedFiles} kopiert, ${result.deletedFiles} gelöscht, ${result.totalTracks} Titel synchronisiert, ${skippedFiles} übersprungen.`);
      }

      return result;
    })()
      .catch((error) => {
        if (error?.message === 'DAP_SYNC_ABORTED') {
          const checkpoint = this.loadDapSyncCheckpoint(dapTargetDirectory, path.join(dapTargetDirectory, this.dapSyncDirectoryName));
          this.updateDapSyncProgress({
            phase: 'aborted',
            isRunning: false,
            canResume: true,
            resumedFromProcessedItems: checkpoint?.completedRelativePaths.length || 0,
          });
          return {
            copiedFiles: this.dapSyncProgressSnapshot.copiedFiles,
            deletedFiles: this.dapSyncProgressSnapshot.deletedFiles,
            totalTracks: this.dapSyncProgressSnapshot.totalItems,
          };
        }

        const errorCode = String((error as any)?.code || '');
        const normalizedErrorMessage = (errorCode === 'ENOENT' || errorCode === 'ENODEV' || errorCode === 'EIO')
          ? `DAP target directory unavailable: ${dapTargetDirectory}`
          : String(error?.message || error);
        this.updateDapSyncProgress({
          phase: 'error',
          isRunning: false,
          canResume: true,
          errorMessage: normalizedErrorMessage,
        });
        throw error;
      })
      .finally(() => {
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
  }): Promise<void> {
    const settings = this.getDapSyncSettings();
    if (!settings.autoSyncEnabled || !settings.targetDirectory) {
      return;
    }

    await this.syncDapLibrary({
      targetDirectory: settings.targetDirectory,
      deleteMissingOnDevice: settings.deleteMissingOnDevice,
      silent: options?.silent ?? true,
    });
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
    sourceMeta?: { sourceSize?: number; sourceMtimeMs?: number },
  ): Promise<boolean> {
    const destinationStats = await fs.promises.stat(destinationPath).catch(() => undefined);
    if (!destinationStats) {
      return false;
    }

    const sourceStats = (!sourceMeta?.sourceSize || !sourceMeta?.sourceMtimeMs)
      ? await fs.promises.stat(sourcePath).catch(() => undefined)
      : undefined;
    const sourceSize = Number(sourceMeta?.sourceSize || sourceStats?.size || 0);
    const sourceMtimeMs = Number(sourceMeta?.sourceMtimeMs || sourceStats?.mtimeMs || 0);
    if (!sourceSize || destinationStats.size !== sourceSize) {
      return false;
    }

    if (!sourceMtimeMs) {
      return true;
    }

    return destinationStats.mtimeMs >= sourceMtimeMs
      || Math.abs(destinationStats.mtimeMs - sourceMtimeMs) <= 5000;
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
