import {
  IAudioMetadata,
  IPicture,
  parseFile,
  selectCover,
} from 'music-metadata';
import path from 'path';

import PQueue from 'p-queue';
import { Semaphore } from 'async-mutex';
import _, { isEmpty, isNumber } from 'lodash';

import { MediaEnums } from '../../enums';
import { IMediaLibraryService, IMediaPicture } from '../../interfaces';
import { DateTimeUtils } from '../../utils';

import {
  I18nService,
  MediaAlbumService,
  MediaArtistService,
  MediaLibraryService,
  MediaPlaylistService,
  MediaProviderService,
  MediaTrackService,
  NotificationService,
} from '../../services';

import {
  MediaAlbumDatastore,
  MediaArtistDatastore,
  MediaPlaylistDatastore,
  MediaTrackDatastore,
} from '../../datastores';

import { CryptoService } from '../../modules/crypto';
import { FSFile, FSAudioExtensions } from '../../modules/file-system';
import { IPCCommChannel, IPCRenderer } from '../../modules/ipc';

import { IMediaLocalSettings } from './media-local.interfaces';
import MediaLocalConstants from './media-local.constants.json';
import MediaLocalUtils from './media-local.utils';
import { MediaLocalStateActionType, mediaLocalStore } from './media-local.store';

const debug = require('debug')('aurora:provider:media_local:media_library');

class MediaLocalLibraryService implements IMediaLibraryService {
  private readonly syncAddFileQueue = new PQueue({ concurrency: 10, autoStart: true, timeout: 5 * 60 * 1000 }); // timeout 5 minutes / track
  private readonly syncLock = new Semaphore(1);
  private syncAbortController: AbortController | null = null;
  private syncFilesQueuedCount = 0;
  private syncFilesProcessedQueueCount = 0;
  private playlistCoversRefreshedThisSession = false;
  private playlistCoversRefreshPromise: Promise<void> | null = null;

  onProviderRegistered(): void {
    debug('onProviderRegistered - received');
    debug('onProviderRegistered - starting sync');
    this.syncMediaTracks()
      .then(() => {
        debug('onProviderRegistered - sync completed');
      });
  }

  onProviderSettingsUpdated(existingSettings: object, updatedSettings: object): void {
    debug('onProviderSettingsUpdated - received - existing settings - %o, updated settings - %o', existingSettings, updatedSettings);
    const oldSettings = existingSettings as IMediaLocalSettings;
    const newSettings = updatedSettings as IMediaLocalSettings;
    const forceRescan = oldSettings.library?.group_compilations_by_folder !== newSettings.library?.group_compilations_by_folder;

    this.syncMediaTracks({ forceRescan, settings: newSettings })
      .then(() => {
        debug('onProviderSettingsUpdated - sync completed');
      });
  }

  async syncMediaTracks(options?: { forceRescan?: boolean, settings?: IMediaLocalSettings }) {
    const { forceRescan, settings: settingsOverride } = options || {};
    // cancel currently running sync
    if (this.syncAbortController) {
      this.syncAbortController.abort();
    }

    const abortController = new AbortController();
    this.syncAbortController = abortController;

    return this.syncLock.runExclusive(async () => {
      // if we were replaced before acquiring lock, bail
      if (this.syncAbortController !== abortController) {
        return;
      }

      debug('syncMediaTracks - started sync');
      const syncStart = performance.now();
      const { signal } = abortController;

      // finalize
      const finalize = (() => {
        const onAbort = () => this.syncAddFileQueue.clear();

        signal.addEventListener('abort', onAbort);

        return () => {
          if (this.syncAbortController === abortController) {
            this.syncAbortController = null;
          }

          signal.removeEventListener('abort', onAbort);
        };
      })();

      try {
        // start
        this.syncFilesQueuedCount = 0;
        this.syncFilesProcessedQueueCount = 0;
        mediaLocalStore.dispatch({ type: MediaLocalStateActionType.StartSync });
        await MediaLibraryService.startMediaTrackSync(MediaLocalConstants.Provider);
        const settings: IMediaLocalSettings = settingsOverride || await MediaProviderService.getMediaProviderSettings(MediaLocalConstants.Provider);
        await Promise.map(settings.library.directories, directory => this.addTracksFromDirectory(directory, {
          signal,
          settings,
          forceRescan,
        }));

        // Wait for potential IPC delays/race conditions where 'complete' arrives before 'data'
        // This ensures the queue is populated before we check for idleness
        await new Promise(resolve => setTimeout(resolve, 2000));

        // wait for queue to empty and process all files
        debug('syncMediaTracks - waiting for queue to drain. Queued: %d, Processed: %d', this.syncFilesQueuedCount, this.syncFilesProcessedQueueCount);
        await this.syncAddFileQueue.onIdle();

        // Safety check: ensure all queued files are processed
        let retries = 0;
        while (this.syncFilesProcessedQueueCount < this.syncFilesQueuedCount && retries < 60) {
          debug('syncMediaTracks - waiting for processing completion... %d/%d', this.syncFilesProcessedQueueCount, this.syncFilesQueuedCount);
          // eslint-disable-next-line no-await-in-loop
          await new Promise(resolve => setTimeout(resolve, 1000));
          retries += 1;
        }

        // consolidate compilation albums
        await this.consolidateCompilationAlbums(settings);
        await this.syncFolderPlaylists(settings);
        await this.repairAlbumArtists();

        // process compilation album covers
        await this.processCompilationAlbumCovers(settings);
        await this.processHiddenAlbumPlaylistCovers();
        await this.processArtistFeaturePictures();
        await this.processSmartPlaylistCovers();

        // done - only finish if not aborted or new run is already in place
        if (signal.aborted || this.syncAbortController !== abortController) {
          debug('syncMediaTracks - operation aborted');
          return;
        }

        const syncDuration = performance.now() - syncStart;
        await MediaLibraryService.finishMediaTrackSync(MediaLocalConstants.Provider);

        mediaLocalStore.dispatch({
          type: MediaLocalStateActionType.FinishSync,
          data: {
            syncDuration,
          },
        });

        // notification
        const { syncFilesFoundCount, syncFilesProcessedCount, syncFilesAddedCount } = mediaLocalStore.getState();
        if (syncFilesAddedCount > 0) {
          NotificationService.showMessage(I18nService.getString('message_sync_finished', {
            tracksAddedCount: syncFilesAddedCount,
          }));
        }

        // reload library
        MediaAlbumService.loadMediaAlbums();
        MediaArtistService.loadMediaArtists();
        MediaPlaylistService.loadMediaPlaylists();

        debug(
          'syncMediaTracks - finished sync, took - %s, found - %d, processed - %d, added - %d',
          DateTimeUtils.formatDuration(syncDuration),
          syncFilesFoundCount,
          syncFilesProcessedCount,
          syncFilesAddedCount,
        );
      } finally {
        finalize();
      }
    });
  }

  private addTracksFromDirectory(directory: string, options: { signal: AbortSignal, settings: IMediaLocalSettings, forceRescan?: boolean }): Promise<void> {
    const { signal, settings, forceRescan } = options;

    return new Promise((resolve) => {
      const scanTimestamp = Date.now();
      debug('addTracksFromDirectory - reading directory - %s, scan timestamp - %d', directory, scanTimestamp);

      IPCRenderer.stream(
        IPCCommChannel.FSReadDirectoryStream, {
          directory,
          fileExtensions: FSAudioExtensions,
        }, (data: { files: FSFile[] }) => {
          // on data
          this.addTracksFromFiles(directory, data.files, {
            scanTimestamp,
            signal,
            settings,
            forceRescan,
          });

          // update stats
          mediaLocalStore.dispatch({
            type: MediaLocalStateActionType.IncrementDirectorySyncFilesFound,
            data: {
              directory,
              count: data.files.length,
            },
          });
        }, (err: Error) => {
          // on error
          // don't stop, just log
          console.error('Encountered error while reading directory - %s', directory);
          console.error(err);

          // update stats
          mediaLocalStore.dispatch({
            type: MediaLocalStateActionType.SetDirectorySyncError,
            data: {
              directory,
              error: err.message,
            },
          });
        }, () => {
          // on done
          debug('addTracksFromDirectory - finished reading directory - %s', directory);
          resolve();
        },
        signal,
      );
    });
  }

  private addTracksFromFiles(directory: string, files: FSFile[], options: { scanTimestamp: number, signal: AbortSignal, settings: IMediaLocalSettings, forceRescan?: boolean }) {
    const {
      scanTimestamp,
      signal,
      settings,
      forceRescan,
    } = options;

    files.forEach((file) => {
      debug('addTracksFromFiles - found file at - %s, queueing...', file.path);
      this.syncFilesQueuedCount += 1;

      this.syncAddFileQueue
        .add(async () => {
          try {
            if (signal.aborted) {
              debug('addTracksFromFiles - operation aborted, skipping - %s', file.name);
              return;
            }

            await this.addTrackFromFile(directory, file, {
              scanTimestamp,
              settings,
              forceRescan,
            });

            // update stats
            mediaLocalStore.dispatch({
              type: MediaLocalStateActionType.IncrementDirectorySyncFilesProcessed,
              data: {
                directory,
                count: 1,
              },
            });
          } finally {
            this.syncFilesProcessedQueueCount += 1;
          }
        })
        .catch((err) => {
          console.error('addTracksFromFiles - encountered error while adding file - %s', file.name);
          console.error(err);
        });
    });
  }

  private async addTrackFromFile(directory: string, file: FSFile, options: { scanTimestamp: number, settings: IMediaLocalSettings, forceRescan?: boolean }) {
    const { scanTimestamp, settings, forceRescan } = options;
    debug('addTrackFromFile - adding file - %s', file.path);

    // generate local id - we are using location of the file to uniquely identify the track
    const mediaTrackId = MediaLocalLibraryService.getMediaId(file.path);
    // determine if this is a new track before any upsert work (used for stats only)
    const preExistingTrack = await MediaTrackDatastore.findMediaTrack({
      provider: MediaLocalConstants.Provider,
      provider_id: mediaTrackId,
    });

    // first check if we can simply mark it as seen; required both mtime and size for this to work
    if (!forceRescan && isNumber(file.stats?.mtime) && isNumber(file.stats?.size)) {
      const mediaTrack = await MediaTrackService.updateMediaTrack({
        provider: MediaLocalConstants.Provider,
        provider_id: mediaTrackId,
        // @ts-ignore - can't get extra props to work with type checking
        'extra.file_mtime': file.stats?.mtime,
        'extra.file_size': file.stats?.size,
      }, {
        sync_timestamp: scanTimestamp,
      });

      if (mediaTrack) {
        const mediaTrackExtra = (mediaTrack.extra || {}) as {
          audio_sample_rate_hz?: number;
          audio_bit_depth?: number;
          audio_bitrate_kbps?: number;
          audio_codec?: string;
          audio_file_type?: string;
        };
        const hasAudioDetails = [
          mediaTrackExtra.audio_sample_rate_hz,
          mediaTrackExtra.audio_bit_depth,
          mediaTrackExtra.audio_bitrate_kbps,
          mediaTrackExtra.audio_codec,
          mediaTrackExtra.audio_file_type,
        ].some(value => !!value);
        const expectedGroupingFolder = this.getEffectiveGroupingFolder(file.path, !!settings.library.group_compilations_by_folder);
        const expectedSourceFingerprint = CryptoService.sha256(expectedGroupingFolder);
        const currentSourceFingerprint = String((mediaTrack.track_album.extra as any)?.source_fingerprint || '').trim();
        const shouldForceRegroup = currentSourceFingerprint !== expectedSourceFingerprint;

        if (!hasAudioDetails) {
          debug('addTrackFromFile - track %s missing audio detail fields, falling back to full scan', file.path);
        } else if (shouldForceRegroup) {
          debug('addTrackFromFile - track %s requires regroup by source fingerprint, falling back to full scan', file.path);
        } else if (settings.library.group_compilations_by_folder) {
          const parentDir = path.dirname(file.path);
          let folderName = path.basename(parentDir);

          if (folderName.match(/^(disc|cd)\s*\d+$/i)) {
            const grandParentDir = path.dirname(parentDir);
            const parentName = path.basename(grandParentDir);
            folderName = parentName;
          }

          const yearMatch = folderName.match(/\s*\((\d{4})\)/);
          if (yearMatch) {
            folderName = folderName.replace(yearMatch[0], '');
          }

          const isGrouped = mediaTrack.track_album.album_name === folderName;

          if (!isGrouped) {
            debug('addTrackFromFile - track %s needs grouping update, falling back to full scan', file.path);
          } else {
            await MediaAlbumService.updateMediaAlbum({
              id: mediaTrack.track_album_id,
            }, {
              sync_timestamp: scanTimestamp,
            });

            await MediaArtistService.updateMediaArtists({
              id: {
                $in: [
                  mediaTrack.track_album.album_artist_id,
                  ...mediaTrack.track_artists.map(artist => artist.id),
                ],
              },
            }, {
              sync_timestamp: scanTimestamp,
            });

            debug('addTrackFromFile - track at path %s already added %s, skipping...', file.path, mediaTrack.id);
            return mediaTrack;
          }
        } else {
          await MediaAlbumService.updateMediaAlbum({
            id: mediaTrack.track_album_id,
          }, {
            sync_timestamp: scanTimestamp,
          });

          await MediaArtistService.updateMediaArtists({
            id: {
              $in: [
                mediaTrack.track_album.album_artist_id,
                ...mediaTrack.track_artists.map(artist => artist.id),
              ],
            },
          }, {
            sync_timestamp: scanTimestamp,
          });

          debug('addTrackFromFile - track at path %s already added %s, skipping...', file.path, mediaTrack.id);
          return mediaTrack;
        }
      }
    }

    // read metadata
    const audioMetadata = await MediaLocalLibraryService.readAudioMetadataFromFile(file.path);

    let effectiveFolderForGrouping: string | undefined;
    if (settings.library.group_compilations_by_folder) {
      const parentDir = path.dirname(file.path);
      let folderName = path.basename(parentDir);
      // If current folder is a disc folder (e.g., "Disc 1" or "CD 2"), use the parent directory name as album
      // and try to set disc number from folder suffix to keep discs separated logically
      if (/^(disc|cd)\s*\d+$/i.test(folderName)) {
        const grandParentDir = path.dirname(parentDir);
        const parentName = path.basename(grandParentDir);
        const discMatch = folderName.match(/(disc|cd)\s*(\d+)/i);
        folderName = parentName;
        effectiveFolderForGrouping = grandParentDir;
        if (discMatch && audioMetadata.common) {
          // ensure disk structure exists
          // @ts-ignore - music-metadata typings allow partials at runtime
          audioMetadata.common.disk = audioMetadata.common.disk || {};
          // @ts-ignore
          audioMetadata.common.disk.no = parseInt(discMatch[2], 10);
        }
      } else {
        effectiveFolderForGrouping = parentDir;
      }

      // Extract year if present in folder name (e.g. "Album Name (2024)")
      const yearMatch = folderName.match(/\s*\((\d{4})\)$/);
      if (yearMatch) {
        if (audioMetadata.common) {
          audioMetadata.common.year = parseInt(yearMatch[1], 10);
        }
        folderName = folderName.replace(yearMatch[0], '');
      }

      if (audioMetadata.common) {
        audioMetadata.common.album = folderName;
        // We do NOT force 'Various Artists' here anymore.
        // Instead, we let the consolidation process handle mixed albums later.
      }
    }
    if (!effectiveFolderForGrouping) {
      effectiveFolderForGrouping = this.getEffectiveGroupingFolder(file.path, !!settings.library.group_compilations_by_folder);
    }

    // obtain cover image (important - there can be cases where audio has no cover image, handle accordingly)
    const audioCoverPicture = MediaLocalLibraryService.getAudioCoverPictureFromMetadata(audioMetadata);

    if (settings.library.group_compilations_by_folder) {
      // debug(`[DEBUG-IMPORT] File: ${file.path}`);
      // debug(`[DEBUG-IMPORT] Grouping enabled. Folder: ${effectiveFolderForGrouping}, Album Name: ${audioMetadata.common.album}`);
    }

    const rawTrackArtists = (() => {
      const artists = (audioMetadata.common as any)?.artists;
      if (Array.isArray(artists) && artists.length > 0) {
        return artists.map((artist: any) => String(artist || '').trim()).filter(Boolean);
      }
      const artist = (audioMetadata.common as any)?.artist;
      if (artist) {
        return [String(artist).trim()].filter(Boolean);
      }
      return [];
    })();

    const mediaArtists = await MediaLibraryService.checkAndInsertMediaArtists(rawTrackArtists.length > 0
      ? rawTrackArtists.map(audioArtist => ({
        artist_name: audioArtist,
        provider: MediaLocalConstants.Provider,
        provider_id: MediaLocalLibraryService.getMediaId(audioArtist),
        sync_timestamp: scanTimestamp,
      }))
      : [{
        artist_name: 'unknown artist',
        provider: MediaLocalConstants.Provider,
        provider_id: MediaLocalLibraryService.getMediaId('unknown artist'),
        sync_timestamp: scanTimestamp,
      }]);

    const rawAlbumArtist = (() => {
      const albumartist = (audioMetadata.common as any)?.albumartist;
      if (Array.isArray(albumartist) && albumartist.length > 0) {
        return String(albumartist[0] || '').trim();
      }
      return albumartist ? String(albumartist).trim() : '';
    })();

    const mediaAlbumArtist = isEmpty(rawAlbumArtist)
      ? mediaArtists[0]
      : await MediaLibraryService.checkAndInsertMediaArtist({
        artist_name: rawAlbumArtist,
        provider: MediaLocalConstants.Provider,
        provider_id: MediaLocalLibraryService.getMediaId(rawAlbumArtist),
        sync_timestamp: scanTimestamp,
      });

    // #2: add media album
    const mediaAlbumName = audioMetadata.common.album || 'unknown album';
    const mediaAlbumSourceFingerprint = CryptoService.sha256(effectiveFolderForGrouping || path.dirname(file.path));
    const mediaAlbumProviderId = MediaLocalLibraryService.getMediaId(
      mediaAlbumSourceFingerprint,
      mediaAlbumArtist.artist_name,
      mediaAlbumName,
    );

    const mediaAlbumData = await MediaLibraryService.checkAndInsertMediaAlbum({
      album_name: mediaAlbumName,
      album_artist_id: mediaAlbumArtist.id,
      album_genre: audioMetadata.common.genre ? audioMetadata.common.genre[0] : undefined,
      album_year: audioMetadata.common.year,
      album_cover_picture: audioCoverPicture ? {
        image_data: audioCoverPicture.data,
        image_data_type: MediaEnums.MediaTrackCoverPictureImageDataType.Buffer,
      } : undefined,
      provider: MediaLocalConstants.Provider,
      provider_id: mediaAlbumProviderId,
      extra: {
        source_fingerprint: mediaAlbumSourceFingerprint,
      },
      sync_timestamp: scanTimestamp,
    });

    // #3: add media track
    const mediaTrack = await MediaLibraryService.checkAndInsertMediaTrack({
      provider: MediaLocalConstants.Provider,
      provider_id: mediaTrackId,
      // fallback to file name if title could not be found in metadata
      track_name: audioMetadata.common.title || file.name,
      track_number: this.resolveTrackNumber(file.name, audioMetadata.common.track.no || 0),
      track_duration: MediaLocalUtils.parseMediaMetadataDuration(audioMetadata.format.duration),
      track_cover_picture: audioCoverPicture ? {
        image_data: audioCoverPicture.data,
        image_data_type: MediaEnums.MediaTrackCoverPictureImageDataType.Buffer,
      } : undefined,
      track_artist_ids: mediaArtists.map(mediaArtist => mediaArtist.id),
      track_album_id: mediaAlbumData.id,
      extra: {
        file_source: effectiveFolderForGrouping || path.dirname(file.path),
        file_path: file.path,
        file_mtime: file.stats?.mtime,
        file_size: file.stats?.size,
        ...(isNumber(audioMetadata.format.sampleRate) ? { audio_sample_rate_hz: audioMetadata.format.sampleRate } : {}),
        ...(isNumber(audioMetadata.format.bitsPerSample) ? { audio_bit_depth: audioMetadata.format.bitsPerSample } : {}),
        ...(isNumber(audioMetadata.format.bitrate) ? { audio_bitrate_kbps: Math.round(audioMetadata.format.bitrate / 1000) } : {}),
        ...(audioMetadata.format.codec ? { audio_codec: audioMetadata.format.codec } : {}),
        ...(audioMetadata.format.container ? { audio_file_type: audioMetadata.format.container } : {}),
        ...(audioMetadata.common.disk?.no ? {
          disc_number: audioMetadata.common.disk.no,
        } : {}),
      },
      sync_timestamp: scanTimestamp,
    });

    // update stats only if track did not exist before this run
    if (!preExistingTrack) {
      mediaLocalStore.dispatch({
        type: MediaLocalStateActionType.IncrementDirectorySyncFilesAdded,
        data: {
          directory,
          count: 1,
        },
      });
    }

    debug('addTracksFromFiles - added track %s from file %s', mediaTrack.id, file.path);
    return mediaTrack;
  }

  private getEffectiveGroupingFolder(filePath: string, groupCompilationsByFolder: boolean): string {
    const parentDir = path.dirname(filePath);
    if (!groupCompilationsByFolder) {
      return parentDir;
    }
    const folderName = path.basename(parentDir);
    if (/^(disc|cd)\s*\d+$/i.test(folderName)) {
      return path.dirname(parentDir);
    }
    return parentDir;
  }

  private resolveTrackNumber(fileName: string, metadataTrackNumber: number): number {
    const fileBaseName = path.parse(fileName || '').name.trim();
    const fileNumberMatch = fileBaseName.match(/^(\d{1,3})\s*([.\-_)]|\s)/);
    const trackNumberFromFileName = fileNumberMatch ? Number(fileNumberMatch[1]) : 0;

    if (!Number.isFinite(trackNumberFromFileName) || trackNumberFromFileName <= 0) {
      return metadataTrackNumber || 0;
    }
    if (!metadataTrackNumber || metadataTrackNumber <= 0) {
      return trackNumberFromFileName;
    }
    if (metadataTrackNumber === 1 && trackNumberFromFileName > 1) {
      return trackNumberFromFileName;
    }

    return metadataTrackNumber;
  }

  private static getMediaId(...mediaInput: string[]): string {
    return CryptoService.sha256(...mediaInput);
  }

  private static readAudioMetadataFromFile(filePath: string): Promise<IAudioMetadata> {
    return parseFile(filePath).catch(() => ({
      common: {
        title: path.parse(filePath).name,
        album: path.basename(path.dirname(filePath)),
        artist: 'unknown artist',
        albumartist: 'unknown artist',
        genre: [],
        track: { no: 0, of: 0 },
        disk: { no: 0, of: 0 },
      },
      format: {
        duration: 0,
      },
    } as unknown as IAudioMetadata));
  }

  private static getAudioCoverPictureFromMetadata(audioMetadata: IAudioMetadata): IPicture | null {
    return selectCover(audioMetadata.common.picture);
  }

  private async repairAlbumArtists(): Promise<void> {
    const localArtists = await MediaArtistDatastore.findMediaArtists({
      provider: MediaLocalConstants.Provider,
    });
    const artistNameById = new Map<string, string>();
    localArtists.forEach((artist: any) => {
      const artistId = String(artist?.id || _.get(artist, '_id') || '').trim();
      if (!artistId) {
        return;
      }
      artistNameById.set(artistId, String(artist?.artist_name || '').trim());
    });

    const badArtistIds = new Set<string>();
    localArtists.forEach((artist: any) => {
      const artistId = String(artist?.id || _.get(artist, '_id') || '').trim();
      if (!artistId) {
        return;
      }

      const artistName = String(artist?.artist_name || '').trim();
      if (!artistName || artistName.toLowerCase() === 'unknown artist') {
        badArtistIds.add(artistId);
      }
    });

    if (badArtistIds.size === 0) {
      return;
    }

    const localAlbums = await MediaAlbumDatastore.findMediaAlbums({
      provider: MediaLocalConstants.Provider,
    });

    await Promise.map(localAlbums, async (album: any) => {
      const albumId = String(album?.id || _.get(album, '_id') || '').trim();
      if (!albumId) {
        return;
      }

      const albumArtistId = String(album?.album_artist_id || '').trim();
      const albumArtistName = String(artistNameById.get(albumArtistId) || '').trim();
      const albumName = String(album?.album_name || '').trim();
      const escapedAlbumArtistName = _.escapeRegExp(albumArtistName);
      const normalizedAlbumNameMatch = albumArtistName
        ? albumName.match(new RegExp(`^${escapedAlbumArtistName}\\s*[-–—]\\s*(.+)$`, 'i'))
        : null;

      if (normalizedAlbumNameMatch && normalizedAlbumNameMatch[1]) {
        const normalizedAlbumName = String(normalizedAlbumNameMatch[1]).trim();
        if (normalizedAlbumName) {
          await MediaAlbumService.updateMediaAlbum({
            id: albumId,
          }, {
            album_name: normalizedAlbumName,
            provider_id: MediaLocalLibraryService.getMediaId(albumArtistName, normalizedAlbumName),
            sync_timestamp: Date.now(),
          });
          return;
        }
      }

      if (albumArtistId && !badArtistIds.has(albumArtistId)) {
        return;
      }

      const tracks = await MediaTrackDatastore.findMediaTracks({
        track_album_id: albumId,
      });

      const splitMatch = albumName.match(/^(.+?)\s+-\s+(.+)$/);
      if (splitMatch) {
        const parsedArtistName = String(splitMatch[1] || '').trim();
        const parsedAlbumName = String(splitMatch[2] || '').trim();
        const parsedArtistNameLower = parsedArtistName.toLowerCase();
        const trackArtistNameMatches = tracks.some((track: any) => {
          const artistIds: string[] = Array.isArray(track?.track_artist_ids) ? track.track_artist_ids : [];
          return artistIds.some((artistId) => {
            const trackArtistName = String(artistNameById.get(String(artistId || '').trim()) || '').trim().toLowerCase();
            return trackArtistName === parsedArtistNameLower;
          });
        });

        if (parsedArtistName && parsedAlbumName && (trackArtistNameMatches || tracks.length === 0)) {
          const parsedArtist = await MediaLibraryService.checkAndInsertMediaArtist({
            artist_name: parsedArtistName,
            provider: MediaLocalConstants.Provider,
            provider_id: MediaLocalLibraryService.getMediaId(parsedArtistName),
            sync_timestamp: Date.now(),
          });

          await MediaAlbumService.updateMediaAlbum({
            id: albumId,
          }, {
            album_artist_id: parsedArtist.id,
            album_name: parsedAlbumName,
            provider_id: MediaLocalLibraryService.getMediaId(parsedArtistName, parsedAlbumName),
            sync_timestamp: Date.now(),
          });
          return;
        }
      }

      const artistCounts = new Map<string, number>();
      tracks.forEach((track: any) => {
        const artistIds: string[] = Array.isArray(track?.track_artist_ids) ? track.track_artist_ids : [];
        artistIds
          .map(id => String(id || '').trim())
          .filter(id => id && !badArtistIds.has(id))
          .forEach((id) => {
            artistCounts.set(id, (artistCounts.get(id) || 0) + 1);
          });
      });

      let bestArtistId = '';
      let bestCount = 0;
      artistCounts.forEach((count, id) => {
        if (count > bestCount) {
          bestCount = count;
          bestArtistId = id;
        }
      });

      if (!bestArtistId) {
        return;
      }

      const candidateArtist = await MediaArtistDatastore.findMediaArtistById(bestArtistId);
      if (!candidateArtist || !String((candidateArtist as any).artist_name || '').trim()) {
        return;
      }

      await MediaAlbumService.updateMediaAlbum({
        id: albumId,
      }, {
        album_artist_id: bestArtistId,
        provider_id: MediaLocalLibraryService.getMediaId(
          String(((album as any)?.extra || {})?.source_fingerprint || '').trim(),
          String((candidateArtist as any).artist_name || '').trim(),
          albumName,
        ),
        sync_timestamp: Date.now(),
      });
    }, {
      concurrency: 10,
    });
  }

  private async consolidateCompilationAlbums(settings: IMediaLocalSettings): Promise<void> {
    if (!settings.library.group_compilations_by_folder) {
      return;
    }
    debug('consolidateCompilationAlbums - starting consolidation');

    // Find all tracks with file_source (directory)
    const tracks = await MediaTrackDatastore.findMediaTracks({
      provider: MediaLocalConstants.Provider,
      'extra.file_source': { $exists: true },
    } as any);

    // Group by directory
    const tracksByDir = _.groupBy(tracks, (t: any) => t.extra?.file_source);

    // Process each directory
    await Promise.map(Object.keys(tracksByDir), async (dir) => {
      const dirTracks = tracksByDir[dir];
      if (isEmpty(dirTracks)) {
        return;
      }

      const albumIds = _.uniq(dirTracks.map((t: any) => t.track_album_id));

      if (albumIds.length <= 1) {
        return;
      }

      // Found split album! Check if they share the same album name
      // eslint-disable-next-line no-underscore-dangle
      // @ts-ignore
      // eslint-disable-next-line no-underscore-dangle
      // @ts-ignore
      const albums = await MediaAlbumDatastore.findMediaAlbums({ id: { $in: albumIds } });
      const albumNames = _.uniq(albums.map((a: any) => a.album_name));

      const targetAlbumName = albumNames[0];
      let targetArtistName = 'Various Artists';

      if (albumNames.length > 1) {
        return;
      }

      // Determine target artist
      const albumArtistIds = _.uniq(albums.map((a: any) => a.album_artist_id));
      const artists = await MediaArtistDatastore.findMediaArtists({ id: { $in: albumArtistIds } });
      const artistNames = artists.map((a: any) => a.artist_name);

      // Heuristic 0: Check if there is only one unique artist
      const uniqueArtists = _.uniqBy(artistNames, (name: string) => name.toLowerCase());
      if (uniqueArtists.length === 1) {
        [targetArtistName] = uniqueArtists;
      } else {
        // Heuristic 1: Check if one artist is a prefix of all others (e.g. "Adele" vs "Adele feat. X")
        const shortestArtist = _.minBy(artistNames, 'length');
        if (shortestArtist) {
          const allStartsWithShortest = artistNames.every(name => name.toLowerCase().startsWith(shortestArtist.toLowerCase()));
          if (allStartsWithShortest) {
            targetArtistName = shortestArtist;
          }
        }

        // Heuristic 2: Check folder name matches an artist
        if (targetArtistName === 'Various Artists') {
          const folderName = path.basename(dir);
          const matchingArtist = artistNames.find(name => folderName.toLowerCase().startsWith(name.toLowerCase()));
          if (matchingArtist) {
            targetArtistName = matchingArtist;
          }
        }
      }

      debug('consolidateCompilationAlbums - consolidating album %s in %s into %s - %s', targetAlbumName, dir, targetArtistName, targetAlbumName);

      // Find or Create target artist
      // @ts-ignore
      let targetArtist = await MediaArtistDatastore.findMediaArtist({
        provider: MediaLocalConstants.Provider,
        provider_id: MediaLocalLibraryService.getMediaId(targetArtistName),
      });

      if (!targetArtist) {
        targetArtist = await MediaLibraryService.checkAndInsertMediaArtist({
          artist_name: targetArtistName,
          provider: MediaLocalConstants.Provider,
          provider_id: MediaLocalLibraryService.getMediaId(targetArtistName),
          sync_timestamp: Date.now(),
        });
      }

      const targetAlbumSourceFingerprint = CryptoService.sha256(dir);
      const targetAlbumId = MediaLocalLibraryService.getMediaId(targetAlbumSourceFingerprint, targetArtistName, targetAlbumName);
      // @ts-ignore
      let targetAlbum = await MediaAlbumDatastore.findMediaAlbum({ provider_id: targetAlbumId });

      if (!targetAlbum) {
        // Create it using metadata from the first album
        const firstAlbum = albums[0];
        targetAlbum = await MediaLibraryService.checkAndInsertMediaAlbum({
          album_name: targetAlbumName,
          // eslint-disable-next-line no-underscore-dangle
          album_artist_id: targetArtist.id || (targetArtist as any)._id,
          album_genre: firstAlbum.album_genre,
          album_year: firstAlbum.album_year,
          album_cover_picture: firstAlbum.album_cover_picture,
          provider: MediaLocalConstants.Provider,
          provider_id: targetAlbumId,
          extra: {
            source_fingerprint: targetAlbumSourceFingerprint,
          },
          sync_timestamp: Date.now(),
        });
      }

      // Move tracks to consolidated album
      // eslint-disable-next-line no-underscore-dangle
      // @ts-ignore
      await MediaTrackDatastore.updateMediaTracks(
        // eslint-disable-next-line no-underscore-dangle
        { id: { $in: dirTracks.map((t: any) => t.id) } },
        // eslint-disable-next-line no-underscore-dangle
        { track_album_id: targetAlbum.id || (targetAlbum as any)._id },
      );

      // Generate collage if needed (immediate update)
      // Get tracks for this album (could be more than just this dir if existing album)
      // But for collage we might want to prioritize variety
      const currentTracks = await MediaTrackService.getMediaAlbumTracks(targetAlbum.id);
      const coverPicturesRaw = currentTracks
        .filter(track => track.track_cover_picture && track.track_cover_picture.image_data_type === MediaEnums.MediaTrackCoverPictureImageDataType.Path)
        .map(track => track.track_cover_picture as IMediaPicture);
      const clusters = await this.getCoverClusters(coverPicturesRaw, 10);
      const coverPictures = clusters.map(c => c.pictures[0]).slice(0, 4);

      if (coverPictures.length > 1) {
        const total = clusters.reduce((a, b) => a + b.pictures.length, 0);
        const dominant = _.maxBy(clusters, c => c.pictures.length);
        const ratio = dominant ? dominant.pictures.length / total : 1;
        if (ratio >= 0.6) {
          await MediaAlbumService.updateMediaAlbum({ id: targetAlbum.id }, { album_cover_picture: dominant!.pictures[0] });
        } else {
          const collage = await this.createCollage(coverPictures.slice(0, 4));
          if (collage) {
            const generatedCoverPicture = await MediaLibraryService.processPicture({
              image_data: collage,
              image_data_type: MediaEnums.MediaTrackCoverPictureImageDataType.Buffer,
            });
            if (generatedCoverPicture) {
              await MediaAlbumService.updateMediaAlbum({ id: targetAlbum.id }, { album_cover_picture: generatedCoverPicture });
            }
          }
        }
      } else if (coverPictures.length === 1) {
        const primaryCover = coverPictures[0];
        await MediaAlbumService.updateMediaAlbum({ id: targetAlbum.id }, { album_cover_picture: primaryCover });
      }

      // Delete old albums if empty
      // eslint-disable-next-line no-underscore-dangle
      const targetAlbumResolvedId = targetAlbum ? (targetAlbum.id || (targetAlbum as any)._id) : undefined;
      if (!targetAlbumResolvedId) {
        return;
      }
      const oldAlbumIds = albumIds.filter(id => id !== targetAlbumResolvedId);

      await Promise.map(oldAlbumIds, async (oldId) => {
        // @ts-ignore
        const count = await MediaTrackDatastore.countMediaTracks({ track_album_id: oldId });
        if (count === 0) {
          // @ts-ignore
          await MediaAlbumDatastore.deleteAlbums({ id: oldId });
        }
      });
    }, { concurrency: 4 });

    debug('consolidateCompilationAlbums - finished consolidation');
  }

  private async syncFolderPlaylists(settings: IMediaLocalSettings): Promise<void> {
    if (!settings.library.group_compilations_by_folder) {
      return;
    }

    const tracks = await MediaTrackDatastore.findMediaTracks({
      provider: MediaLocalConstants.Provider,
      'extra.file_source': { $exists: true },
    } as any);
    const tracksByDir = _.groupBy(tracks, (track: any) => String(track?.extra?.file_source || '').trim());
    const allDirectories = Object.keys(tracksByDir).filter(Boolean);

    await Promise.map(allDirectories, async (directory) => {
      const folderTracks = tracksByDir[directory] || [];
      const folderPlaylistId = MediaLocalLibraryService.getMediaId('folder_playlist', directory);
      const folderMediaTracks = await MediaTrackService.buildMediaTracks(folderTracks);

      const uniqueAlbumNames = _.uniq(
        folderMediaTracks
          .map(track => String(track.track_album?.album_name || '').trim().toLowerCase())
          .filter(Boolean),
      );
      const uniqueAlbumArtists = _.uniq(
        folderMediaTracks
          .map(track => String(track.track_album?.album_artist?.artist_name || '').trim().toLowerCase())
          .filter(Boolean),
      );
      const uniqueTrackArtists = _.uniq(
        _.flatten(folderMediaTracks.map(track => (track.track_artists || []).map(artist => String(artist.artist_name || '').trim().toLowerCase())))
          .filter(Boolean),
      );

      const shouldBeFolderPlaylist = uniqueAlbumNames.length >= 2
        && (uniqueAlbumArtists.length >= 2 || uniqueTrackArtists.length >= 3);

      const existingFolderPlaylist = await MediaPlaylistDatastore.findMediaPlaylist({
        id: folderPlaylistId,
      });

      if (!shouldBeFolderPlaylist) {
        if (existingFolderPlaylist) {
          await MediaPlaylistDatastore.deleteMediaPlaylist({
            id: folderPlaylistId,
          });
        }
        return;
      }

      const sortedFolderTracks = [...folderTracks].sort((trackA: any, trackB: any) => {
        const trackNumberA = Number(trackA?.track_number) || 0;
        const trackNumberB = Number(trackB?.track_number) || 0;
        if (trackNumberA !== trackNumberB) {
          return trackNumberA - trackNumberB;
        }
        const pathA = String((trackA?.extra || {}).file_path || '');
        const pathB = String((trackB?.extra || {}).file_path || '');
        return pathA.localeCompare(pathB);
      });
      const playlistTracks = sortedFolderTracks.map((track: any) => ({
        playlist_track_id: MediaLocalLibraryService.getMediaId('folder_playlist_track', directory, track.provider_id),
        provider: track.provider,
        provider_id: track.provider_id,
        added_at: Number(track.sync_timestamp) || Date.now(),
      }));

      await MediaPlaylistDatastore.upsertMediaPlaylist({
        id: folderPlaylistId,
      }, {
        id: folderPlaylistId,
        name: path.basename(directory),
        tracks: playlistTracks,
        is_smart: true,
        smart_match_mode: 'all',
        smart_rules: [{
          keyword: 'path',
          pattern: `${directory}*`,
        }],
      } as any);
    }, { concurrency: 4 });
  }

  private async processCompilationAlbumCovers(settings: IMediaLocalSettings): Promise<void> {
    if (!settings.library.group_compilations_by_folder) {
      return;
    }

    const mediaAlbums = await MediaAlbumService.getMediaAlbums();
    const compilationAlbums = mediaAlbums.filter(album => (
      album.provider === MediaLocalConstants.Provider
      && album.album_artist.artist_name === 'Various Artists'
    ));

    await Promise.map(compilationAlbums, async (album) => {
      const tracks = await MediaTrackService.getMediaAlbumTracks(album.id);
      if (isEmpty(tracks)) {
        return;
      }

      const coverPicturesRaw = tracks
        .filter(track => track.track_cover_picture && track.track_cover_picture.image_data_type === MediaEnums.MediaTrackCoverPictureImageDataType.Path)
        .map(track => track.track_cover_picture as IMediaPicture);
      const clusters = await this.getCoverClusters(coverPicturesRaw, 10);
      const coverPictures = clusters.map(c => c.pictures[0]).slice(0, 4);

      if (coverPictures.length > 1) {
        const total = clusters.reduce((a, b) => a + b.pictures.length, 0);
        const dominant = _.maxBy(clusters, c => c.pictures.length);
        const ratio = dominant ? dominant.pictures.length / total : 1;
        if (ratio >= 0.6) {
          await MediaAlbumService.updateMediaAlbum({ id: album.id }, { album_cover_picture: dominant!.pictures[0] });
        } else {
          const collage = await this.createCollage(coverPictures.slice(0, 4));
          if (collage) {
            const generatedCoverPicture = await MediaLibraryService.processPicture({
              image_data: collage,
              image_data_type: MediaEnums.MediaTrackCoverPictureImageDataType.Buffer,
            });
            if (generatedCoverPicture) {
              await MediaAlbumService.updateMediaAlbum({ id: album.id }, { album_cover_picture: generatedCoverPicture });
            }
          }
        }
      } else if (coverPictures.length === 1) {
        const primaryCover = coverPictures[0];
        await MediaAlbumService.updateMediaAlbum({ id: album.id }, { album_cover_picture: primaryCover });
      }
    }, { concurrency: 4 });
  }

  private async processHiddenAlbumPlaylistCovers(): Promise<void> {
    const hiddenAlbums = await MediaAlbumDatastore.findMediaAlbums({
      hidden: true,
    });

    await Promise.map(hiddenAlbums, async (album) => {
      const tracks = await MediaTrackService.getMediaAlbumTracks(album.id);
      if (isEmpty(tracks)) {
        return;
      }

      const coverPicturesRaw = tracks
        .map(track => (
          track.track_cover_picture
          || track.track_album?.album_cover_picture
        ))
        .filter((picture: IMediaPicture | undefined) => picture?.image_data_type === MediaEnums.MediaTrackCoverPictureImageDataType.Path) as IMediaPicture[];
      const clusters = await this.getCoverClusters(coverPicturesRaw, 10);
      const coverPictures = clusters.map(c => c.pictures[0]).slice(0, 4);

      if (isEmpty(coverPictures)) {
        return;
      }

      if (coverPictures.length > 1) {
        const collage = await this.createCollage(coverPictures);
        if (!collage) {
          return;
        }
        const generatedCoverPicture = await MediaLibraryService.processPicture({
          image_data: collage,
          image_data_type: MediaEnums.MediaTrackCoverPictureImageDataType.Buffer,
        });
        if (!generatedCoverPicture) {
          return;
        }
        await MediaAlbumService.updateMediaAlbum({ id: album.id }, { album_cover_picture: generatedCoverPicture });
        return;
      }

      await MediaAlbumService.updateMediaAlbum({ id: album.id }, { album_cover_picture: coverPictures[0] });
    }, { concurrency: 4 });
  }

  private async processArtistFeaturePictures(): Promise<void> {
    const mediaArtists = await MediaArtistDatastore.findMediaArtists({
      provider: MediaLocalConstants.Provider,
    });
    const artistsWithoutPicture = mediaArtists.filter(artist => !artist.artist_feature_picture && !!String(artist.artist_name || '').trim());

    await Promise.map(artistsWithoutPicture, async (artist) => {
      await MediaArtistService.updateMediaArtists({
        id: artist.id,
      }, {
        extra: {
          ...(artist.extra as Record<string, unknown> | undefined),
          artist_feature_picture_loading: true,
        },
      });

      const artistPicture = await this.fetchArtistFeaturePicture(artist.artist_name);
      await MediaArtistService.updateMediaArtists({
        id: artist.id,
      }, {
        ...(artistPicture ? {
          artist_feature_picture: artistPicture,
        } : {}),
        extra: {
          ...(artist.extra as Record<string, unknown> | undefined),
          artist_feature_picture_loading: false,
        },
      });
    }, { concurrency: 3 });
  }

  private async fetchArtistFeaturePicture(artistName: string): Promise<IMediaPicture | undefined> {
    const normalizedArtistName = String(artistName || '').trim();
    if (!normalizedArtistName) {
      return undefined;
    }

    const requestAbortController = new AbortController();
    const requestTimeout = setTimeout(() => requestAbortController.abort(), 15000);
    try {
      const deezerApiUrl = new URL('https://api.deezer.com/search/artist');
      deezerApiUrl.searchParams.set('q', normalizedArtistName);
      deezerApiUrl.searchParams.set('limit', '1');
      const deezerResponse = await fetch(deezerApiUrl.toString(), {
        signal: requestAbortController.signal,
      });
      if (!deezerResponse.ok) {
        return undefined;
      }

      const deezerPayload = await deezerResponse.json();
      const deezerArtist = Array.isArray(deezerPayload?.data) ? deezerPayload.data[0] : undefined;
      const artistImageUrl = String(
        deezerArtist?.picture_xl
        || deezerArtist?.picture_big
        || deezerArtist?.picture_medium
        || deezerArtist?.picture
        || '',
      ).trim();
      if (!artistImageUrl) {
        return undefined;
      }

      const imageResponse = await fetch(artistImageUrl, {
        signal: requestAbortController.signal,
      });
      if (!imageResponse.ok) {
        return undefined;
      }

      const imageArrayBuffer = await imageResponse.arrayBuffer();
      const imageBuffer = Buffer.from(imageArrayBuffer);
      const processedPicture = await MediaLibraryService.processPicture({
        image_data: imageBuffer,
        image_data_type: MediaEnums.MediaTrackCoverPictureImageDataType.Buffer,
      });
      return processedPicture;
    } catch (error) {
      debug('processArtistFeaturePictures - failed for %s - %o', normalizedArtistName, error);
      return undefined;
    } finally {
      clearTimeout(requestTimeout);
    }
  }

  private async processSmartPlaylistCovers(): Promise<void> {
    // Generate/refresh covers for all playlists:
    // - If multiple distinct covers: create a collage
    // - If one distinct cover: use that single cover
    // - Do NOT overwrite if an existing cover looks like a previously generated collage
    //   (i.e., it's not equal to any track cover path)
    const playlists = await MediaPlaylistDatastore.findMediaPlaylists();

    await Promise.map(playlists, async (playlist) => {
      if (isEmpty(playlist.tracks)) {
        return;
      }

      const playlistTracks = await Promise.map(playlist.tracks, playlistTrack => MediaTrackService.getMediaTrackForProvider(
        playlistTrack.provider,
        playlistTrack.provider_id,
      ));
      const trackCoversRaw = (playlistTracks as any[])
        .filter(Boolean)
        .map((playlistTrack: any) => (
          playlistTrack.track_cover_picture
          || playlistTrack.track_album?.album_cover_picture
        ))
        .filter((picture: IMediaPicture | undefined) => picture?.image_data_type === MediaEnums.MediaTrackCoverPictureImageDataType.Path) as IMediaPicture[];
      // Für Playlists bevorzugen wir Pfad-Eindeutigkeit (zeigt Vielfalt), ohne über-aggressive visuelle Deduplikation
      const trackCoversByPath = _.uniqBy(trackCoversRaw, 'image_data').slice(0, 4) as IMediaPicture[];

      if (isEmpty(trackCoversByPath)) {
        return;
      }

      const currentCover = playlist.cover_picture;
      // If more than one distinct cover (nach Pfad): always generate a collage to reflect variety.
      // This ensures newly created playlists immediately show a grid without requiring a full sync.
      if (trackCoversByPath.length > 1) {
        const collageBuffer = await this.createCollage(trackCoversByPath);
        if (!collageBuffer) {
          return;
        }
        const generatedCoverPicture = await MediaLibraryService.processPicture({
          image_data: collageBuffer,
          image_data_type: MediaEnums.MediaTrackCoverPictureImageDataType.Buffer,
        });
        if (!generatedCoverPicture) {
          return;
        }
        await MediaPlaylistService.updateMediaPlaylist(playlist.id, {
          cover_picture: generatedCoverPicture,
        });
        return;
      }

      // Exactly one distinct cover: set it if different or missing
      const [singleCover] = trackCoversByPath;
      if (!currentCover || currentCover.image_data !== singleCover.image_data) {
        await MediaPlaylistService.updateMediaPlaylist(playlist.id, {
          cover_picture: singleCover,
        });
      }
    }, { concurrency: 3 });
  }

  // Cluster pictures by perceptual similarity
  private getCoverClusters(pictures: IMediaPicture[], threshold = 8): Promise<{ hash: string; pictures: IMediaPicture[] }[]> {
    return new Promise((resolve) => {
      if (!pictures.length) {
        resolve([]);
        return;
      }

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        // Fallback: cluster by path equality
        const groups = _.groupBy(pictures, 'image_data');
        resolve(Object.keys(groups).map(hash => ({ hash, pictures: groups[hash] })));
        return;
      }

      const HASH_SIZE = 8;
      canvas.width = HASH_SIZE;
      canvas.height = HASH_SIZE;

      const entries: { pic: IMediaPicture; hash: string }[] = [];
      let loaded = 0;

      const done = () => {
        if (loaded !== pictures.length) return;
        const clusters: { hash: string; pictures: IMediaPicture[] }[] = [];
        const hamming = (a: string, b: string) => {
          let d = 0;
          const len = Math.min(a.length, b.length);
          for (let i = 0; i < len; i += 1) {
            if (a[i] !== b[i]) d += 1;
          }
          return d + Math.abs(a.length - b.length);
        };
        entries.forEach(({ pic, hash }) => {
          let found = false;
          for (let i = 0; i < clusters.length; i += 1) {
            if (hamming(clusters[i].hash, hash) <= threshold) {
              clusters[i].pictures.push(pic);
              found = true;
              break;
            }
          }
          if (!found) {
            clusters.push({ hash, pictures: [pic] });
          }
        });
        resolve(clusters);
      };

      pictures.forEach((picture) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            ctx.clearRect(0, 0, HASH_SIZE, HASH_SIZE);
            ctx.drawImage(img, 0, 0, HASH_SIZE, HASH_SIZE);
            const imageData = ctx.getImageData(0, 0, HASH_SIZE, HASH_SIZE);
            const pixels = imageData.data;
            const grays: number[] = [];
            for (let i = 0; i < pixels.length; i += 4) {
              const r = pixels[i];
              const g = pixels[i + 1];
              const b = pixels[i + 2];
              const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
              grays.push(gray);
            }
            const avg = grays.reduce((a, b) => a + b, 0) / grays.length;
            let bits = '';
            for (let i = 0; i < grays.length; i += 1) {
              bits += grays[i] > avg ? '1' : '0';
            }
            entries.push({ pic: picture, hash: bits });
          } catch (_e) {
            entries.push({ pic: picture, hash: picture.image_data });
          } finally {
            loaded += 1;
            done();
          }
        };
        img.onerror = () => {
          entries.push({ pic: picture, hash: picture.image_data });
          loaded += 1;
          done();
        };
        img.src = `file://${picture.image_data}`;
      });
    });
  }

  public async refreshPlaylistCovers(): Promise<void> {
    await this.processHiddenAlbumPlaylistCovers();
    await this.processSmartPlaylistCovers();
    MediaPlaylistService.loadMediaPlaylists();
  }

  public async refreshPlaylistCoversOncePerSession(): Promise<void> {
    if (this.playlistCoversRefreshedThisSession) {
      return;
    }
    if (this.playlistCoversRefreshPromise) {
      await this.playlistCoversRefreshPromise;
      return;
    }

    this.playlistCoversRefreshPromise = (async () => {
      await this.refreshPlaylistCovers();
      this.playlistCoversRefreshedThisSession = true;
    })();

    try {
      await this.playlistCoversRefreshPromise;
    } finally {
      this.playlistCoversRefreshPromise = null;
    }
  }

  public async rescanAlbum(albumId: string): Promise<boolean> {
    const settings = await MediaProviderService.getMediaProviderSettings(MediaLocalConstants.Provider) as IMediaLocalSettings;
    const targetDirectories = await this.resolveRescanDirectoriesForAlbum(albumId);
    if (targetDirectories.length === 0) {
      return false;
    }

    const { signal } = new AbortController();
    await Promise.all(targetDirectories.map(directory => this.addTracksFromDirectory(directory, {
      signal,
      settings,
      forceRescan: true,
    })));
    await this.syncAddFileQueue.onIdle();
    await this.syncFolderPlaylists(settings);

    MediaAlbumService.loadMediaAlbums();
    MediaPlaylistService.loadMediaPlaylists();
    return true;
  }

  private async resolveRescanDirectoriesForAlbum(albumId: string): Promise<string[]> {
    const album = await MediaAlbumDatastore.findMediaAlbumById(albumId);
    if (!album) {
      return [];
    }

    const sourceFingerprint = String((album.extra as any)?.source_fingerprint || '').trim();
    const albums = sourceFingerprint
      ? await MediaAlbumDatastore.findMediaAlbums({
        provider: MediaLocalConstants.Provider,
        // @ts-ignore
        'extra.source_fingerprint': sourceFingerprint,
      } as any)
      : [album];
    const albumIds = _.uniq([albumId, ...albums.map(entry => entry.id)]);
    const tracks = await MediaTrackDatastore.findMediaTracks({
      track_album_id: {
        $in: albumIds,
      },
    } as any);
    const directories = tracks
      .map((track) => {
        const extra = (track.extra as any) || {};
        const source = String(extra.file_source || '').trim();
        if (source) {
          return source;
        }
        const filePath = String(extra.file_path || '').trim();
        if (filePath) {
          return path.dirname(filePath);
        }
        return '';
      })
      .filter(Boolean);

    return _.uniq(directories);
  }

  private createCollage(pictures: IMediaPicture[]): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(null);
        return;
      }

      const size = 500;
      canvas.width = size;
      canvas.height = size;

      // Draw background
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, size, size);

      const count = pictures.length;
      let loadedCount = 0;
      const images: HTMLImageElement[] = [];

      const onImageLoad = () => {
        loadedCount += 1;
        if (loadedCount === count) {
          // All images loaded, draw them
          if (count === 4) {
            ctx.drawImage(images[0], 0, 0, size / 2, size / 2);
            ctx.drawImage(images[1], size / 2, 0, size / 2, size / 2);
            ctx.drawImage(images[2], 0, size / 2, size / 2, size / 2);
            ctx.drawImage(images[3], size / 2, size / 2, size / 2, size / 2);
          } else if (count === 3) {
            ctx.drawImage(images[0], 0, 0, size / 2, size / 2);
            ctx.drawImage(images[1], size / 2, 0, size / 2, size / 2);
            ctx.drawImage(images[2], 0, size / 2, size, size / 2);
          } else if (count === 2) {
            ctx.drawImage(images[0], 0, 0, size / 2, size);
            ctx.drawImage(images[1], size / 2, 0, size / 2, size);
          }

          const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
          const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
          resolve(buffer);
        }
      };

      pictures.forEach((picture) => {
        const img = new Image();
        images.push(img); // Push before setting src to avoid race condition
        img.onload = onImageLoad;
        img.onerror = onImageLoad; // Continue even if error
        img.src = `file://${picture.image_data}`;
      });
    });
  }
}

export default new MediaLocalLibraryService();
