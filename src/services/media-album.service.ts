import fs from 'fs';
import _ from 'lodash';
import NodeID3 from 'node-id3';

import { MediaAlbumDatastore, MediaArtistDatastore, MediaTrackDatastore } from '../datastores';
import { MediaLibraryActions } from '../enums';
import { IMediaAlbum, IMediaAlbumData } from '../interfaces';
import { MediaUtils } from '../utils';
import store from '../store';

import { MediaArtistService } from './media-artist.service';
import { DataStoreFilterData, DataStoreUpdateData } from '../modules/datastore';
import { IPCRenderer, IPCCommChannel } from '../modules/ipc';

export class MediaAlbumService {
  static async searchAlbumsByName(query: string): Promise<IMediaAlbum[]> {
    const normalizedQuery = this.normalizeSearchValue(query);
    if (!normalizedQuery) {
      return [];
    }

    const escapedNormalizedQuery = _.escapeRegExp(normalizedQuery);
    const escapedRawQuery = _.escapeRegExp(query);
    const prefixRegex = new RegExp(`^${escapedNormalizedQuery}`);
    const containsRegex = new RegExp(escapedNormalizedQuery);
    const containsRawRegex = new RegExp(escapedRawQuery, 'i');
    const limit = 120;

    const albumsPrefix = await MediaAlbumDatastore.findMediaAlbums({
      album_name_normalized: {
        $regex: prefixRegex,
      },
    } as any);

    const albumsContains = albumsPrefix.length < limit
      ? await MediaAlbumDatastore.findMediaAlbums({
        album_name_normalized: {
          $regex: containsRegex,
        },
      } as any)
      : [];

    const albumsFallback = albumsPrefix.length === 0 && albumsContains.length === 0
      ? await MediaAlbumDatastore.findMediaAlbums({
        album_name: {
          $regex: containsRawRegex,
        },
      })
      : [];

    const albumsById = new Map<string, IMediaAlbumData>();
    [...albumsPrefix, ...albumsContains, ...albumsFallback].forEach((album) => {
      albumsById.set(album.id, album);
    });

    const mediaAlbums = await this.buildMediaAlbums(Array.from(albumsById.values()));
    return _.orderBy(
      mediaAlbums,
      [album => this.normalizeSearchValue(album.album_name)],
      ['asc'],
    ).slice(0, limit);
  }

  private static normalizeSearchValue(value: string): string {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');
  }

  static async getMediaAlbum(albumId: string): Promise<IMediaAlbum | undefined> {
    const albumData = await MediaAlbumDatastore.findMediaAlbumById(albumId);
    return albumData ? this.buildMediaAlbum(albumData) : undefined;
  }

  static async getMediaAlbums(): Promise<IMediaAlbum[]> {
    const mediaAlbumDataList = await MediaAlbumDatastore.findMediaAlbums();

    const mediaAlbums = await Promise.all(mediaAlbumDataList.map(mediaAlbumData => this.buildMediaAlbum(mediaAlbumData)));
    return MediaUtils.sortMediaAlbums(mediaAlbums);
  }

  static async getMediaArtistAlbums(mediaArtistId: string): Promise<IMediaAlbum[]> {
    const mediaAlbumDataList = await MediaAlbumDatastore.findMediaAlbums({
      album_artist_id: mediaArtistId,
    });

    const mediaAlbums = await Promise.all(mediaAlbumDataList.map(mediaAlbumData => this.buildMediaAlbum(mediaAlbumData)));
    return MediaUtils.sortMediaAlbums(mediaAlbums);
  }

  static async updateMediaAlbum(mediaAlbumFilterData: DataStoreFilterData<IMediaAlbumData>, mediaAlbumUpdateData: DataStoreUpdateData<IMediaAlbumData>): Promise<IMediaAlbum | undefined> {
    const mediaAlbumData = await MediaAlbumDatastore.updateMediaAlbum(mediaAlbumFilterData, {
      ...mediaAlbumUpdateData,
      ...(mediaAlbumUpdateData.album_name ? {
        album_name_normalized: this.normalizeSearchValue(mediaAlbumUpdateData.album_name),
      } : {}),
    });
    if (!mediaAlbumData) {
      return undefined;
    }

    return this.buildMediaAlbum(mediaAlbumData, true);
  }

  static async updateMediaAlbums(mediaAlbumFilterData: DataStoreFilterData<IMediaAlbumData>, mediaAlbumUpdateData: DataStoreUpdateData<IMediaAlbumData>): Promise<IMediaAlbum[]> {
    const mediaAlbumDataList = await MediaAlbumDatastore.updateMediaAlbums(mediaAlbumFilterData, {
      ...mediaAlbumUpdateData,
      ...(mediaAlbumUpdateData.album_name ? {
        album_name_normalized: this.normalizeSearchValue(mediaAlbumUpdateData.album_name),
      } : {}),
    });
    return this.buildMediaAlbums(mediaAlbumDataList, true);
  }

  static loadMediaAlbums(): void {
    this
      .getMediaAlbums()
      .then((mediaAlbums) => {
        store.dispatch({
          type: MediaLibraryActions.SetAlbums,
          data: {
            mediaAlbums: mediaAlbums.filter(mediaAlbum => !mediaAlbum.hidden),
          },
        });
      });
  }

  static loadMediaArtistAlbums(mediaArtistId: string): void {
    this
      .getMediaArtistAlbums(mediaArtistId)
      .then(async (mediaArtistAlbums) => {
        store.dispatch({
          type: MediaLibraryActions.SetArtist,
          data: {
            mediaArtist: await MediaArtistService.getMediaArtist(mediaArtistId),
            mediaArtistAlbums,
          },
        });
      });
  }

  static unloadMediaAlbum(): void {
    store.dispatch({
      type: MediaLibraryActions.SetAlbum,
      data: {
        mediaAlbum: undefined,
        mediaAlbumTracks: undefined,
      },
    });
  }

  // Track in-flight album metadata sync jobs to prevent duplicate work + allow callers to await if needed.
  private static readonly albumMetadataSyncJobs = new Map<string, Promise<void>>();

  // Global serial queue for album-metadata writes. Without this, editing N
  // albums in a row spawns N parallel background syncs, all hammering the
  // disk at once — which is exactly what makes the UI laggy after a few
  // edits. We force them to run one after another, with explicit yields
  // between tracks, so the renderer thread can keep producing frames.
  private static albumMetadataSyncQueue: Promise<void> = Promise.resolve();

  /**
   * Schedules an album metadata sync to run on the global serial queue.
   *
   * IMPORTANT: This method performs heavy disk I/O and tag re-writing per
   * track. We run track updates one-at-a-time, yielding to the event loop
   * between each, so the UI thread can keep producing frames. Multiple
   * pending album syncs are queued and processed sequentially — never in
   * parallel — so editing several albums in a row doesn't degrade scroll
   * smoothness over time.
   *
   * Callers that don't need to await completion should use `syncAlbumMetadataInBackground`.
   */
  static async syncAlbumMetadata(mediaAlbumId: string): Promise<void> {
    const existingJob = this.albumMetadataSyncJobs.get(mediaAlbumId);
    if (existingJob) {
      return existingJob;
    }

    const job = this.albumMetadataSyncQueue
      .then(() => this.runAlbumMetadataSync(mediaAlbumId))
      .finally(() => {
        this.albumMetadataSyncJobs.delete(mediaAlbumId);
      });

    // Chain the next call onto the queue, swallowing errors so one failed
    // album sync doesn't poison the queue for the next one.
    this.albumMetadataSyncQueue = job.catch(() => undefined);
    this.albumMetadataSyncJobs.set(mediaAlbumId, job);
    return job;
  }

  /**
   * Fire-and-forget variant of `syncAlbumMetadata` that schedules the heavy
   * tag-writing to run in the background without blocking the caller. Errors
   * are logged but not propagated, since the caller has already moved on.
   */
  static syncAlbumMetadataInBackground(mediaAlbumId: string): void {
    this.syncAlbumMetadata(mediaAlbumId).catch((error) => {
      console.error(`Background album metadata sync failed for ${mediaAlbumId}`, error);
    });
  }

  private static async runAlbumMetadataSync(mediaAlbumId: string): Promise<void> {
    const mediaAlbum = await this.getMediaAlbum(mediaAlbumId);
    if (!mediaAlbum) {
      return;
    }

    const mediaTracksData = await MediaTrackDatastore.findMediaTracks({
      track_album_id: mediaAlbumId,
    });

    // Read the cover image into a Buffer ONCE per album sync. Without this,
    // node-id3 would re-read and re-decode the same JPEG/PNG from disk for
    // every track, multiplied by the number of tracks (60+ for some
    // releases) — that's where the cumulative memory pressure and disk
    // churn after a few edits was coming from.
    const coverImageBuffer = await this.readAlbumCoverImageBuffer(mediaAlbum);

    // Process tracks sequentially with a yield between each so the event
    // loop can keep rendering UI frames while the disk I/O is happening.
    // eslint-disable-next-line no-restricted-syntax
    for (const mediaTrackData of mediaTracksData) {
      // eslint-disable-next-line no-await-in-loop
      await this.applyAlbumTagsToTrack(mediaAlbum, mediaTrackData, coverImageBuffer);
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  }

  private static async readAlbumCoverImageBuffer(mediaAlbum: IMediaAlbum): Promise<Buffer | undefined> {
    const albumCoverPicture = mediaAlbum.album_cover_picture;
    if (!albumCoverPicture || !albumCoverPicture.image_data) {
      return undefined;
    }
    const coverPath = String(albumCoverPicture.image_data).replace(/^file:\/\//, '');
    if (!coverPath) {
      return undefined;
    }
    try {
      return await fs.promises.readFile(coverPath);
    } catch (error) {
      console.warn(`Could not read album cover image for tag sync: ${coverPath}`, error);
      return undefined;
    }
  }

  /**
   * Writes the current album metadata (title, artist, genre, year, cover) to
   * a single track's audio file and refreshes the persisted file stats.
   *
   * Errors are caught and logged so that one bad track doesn't abort the
   * whole album sync.
   */
  private static async applyAlbumTagsToTrack(
    mediaAlbum: IMediaAlbum,
    mediaTrackData: any,
    coverImage: Buffer | undefined,
  ): Promise<void> {
    const extra = (mediaTrackData?.extra || {}) as any;
    if (!extra.file_path) {
      return;
    }

    const filePath = String(extra.file_path);
    const lowerCasePath = filePath.toLowerCase();
    const isMp3 = lowerCasePath.endsWith('.mp3');
    const isFlac = lowerCasePath.endsWith('.flac');

    if (!isMp3 && !isFlac) {
      return;
    }

    // We always send the *current* album metadata to the writers so that
    // clearing a tag in the UI propagates as "remove this tag" instead of
    // "leave the existing value alone". An empty string is the explicit
    // "clear" signal for both the FLAC writer (metaflac) and the MP3 writer
    // (we replace the empty TCON frame below).
    const tags: any = {
      albumArtist: String(mediaAlbum.album_artist.artist_name || '').trim(),
      album: String(mediaAlbum.album_name || '').trim(),
      genre: String(mediaAlbum.album_genre || '').trim(),
      year: mediaAlbum.album_year ? String(mediaAlbum.album_year) : '',
    };

    try {
      if (isMp3) {
        if (coverImage) {
          tags.image = coverImage;
        }
        await this.writeMp3TagsAsync(tags, filePath);
      } else if (isFlac) {
        await IPCRenderer.sendAsyncMessage(IPCCommChannel.DeviceWriteFlacMetadata, {
          filePath,
          tags: {
            ...tags,
            title: mediaTrackData.track_name,
          },
          coverImage,
        });
      }

      const fileStats = await fs.promises.stat(filePath);
      await MediaTrackDatastore.updateMediaTrack({
        id: mediaTrackData.id,
      }, {
        extra: {
          ...extra,
          file_mtime: fileStats.mtimeMs,
          file_size: fileStats.size,
        },
      });
    } catch (error) {
      console.error(`Error updating tags for ${filePath}`, error);
    }
  }

  /**
   * Wraps `NodeID3.update` in a Promise. Prefers the library's built-in
   * Promise API (which delegates to async fs internally); falls back to the
   * callback-based form when the runtime lacks `NodeID3.Promise`. Both paths
   * are non-blocking — they never call the synchronous `NodeID3.update(tags,
   * filepath)` overload that stalls the JS thread on disk I/O.
   */
  private static async writeMp3TagsAsync(tags: any, filePath: string): Promise<void> {
    const nodeId3Promise = (NodeID3 as any).Promise;
    if (nodeId3Promise && typeof nodeId3Promise.update === 'function') {
      await nodeId3Promise.update(tags, filePath);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      try {
        NodeID3.update(tags, filePath, (err: NodeJS.ErrnoException | null) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      } catch (syncError) {
        reject(syncError instanceof Error ? syncError : new Error(String(syncError)));
      }
    });
  }

  static async buildMediaAlbum(mediaAlbum: string | IMediaAlbumData, loadMediaAlbum = false): Promise<IMediaAlbum> {
    let mediaAlbumData;
    if (typeof mediaAlbum === 'string') {
      mediaAlbumData = await MediaAlbumDatastore.findMediaAlbumById(mediaAlbum);

      if (!mediaAlbumData) {
        throw new Error(`MediaLibraryService encountered error at buildMediaAlbum - Could not find album - ${mediaAlbum}`);
      }
    } else {
      mediaAlbumData = mediaAlbum;
    }

    let mediaAlbumArtist = await MediaArtistService.getMediaArtist(mediaAlbumData.album_artist_id);
    if (!mediaAlbumArtist) {
      const recoveredArtistProviderId = `recovered-artist:${mediaAlbumData.provider}:${mediaAlbumData.album_artist_id}`;
      const recoveredArtistData = await MediaArtistDatastore.upsertMediaArtist({
        provider: mediaAlbumData.provider,
        provider_id: recoveredArtistProviderId,
      }, {
        provider: mediaAlbumData.provider,
        provider_id: recoveredArtistProviderId,
        artist_name: 'Unknown Artist',
        sync_timestamp: Date.now(),
      });
      await MediaAlbumDatastore.updateMediaAlbum({
        id: mediaAlbumData.id,
      }, {
        album_artist_id: recoveredArtistData.id,
      });
      mediaAlbumArtist = await MediaArtistService.getMediaArtist(recoveredArtistData.id);
      if (!mediaAlbumArtist) {
        throw new Error(`Encountered error while build media album - ${mediaAlbumData.id} - Could not recover artist for id - ${mediaAlbumData.album_artist_id}`);
      }
    }

    const mediaAlbumBuilt = _.assign({}, mediaAlbumData, {
      album_artist: mediaAlbumArtist,
    });

    if (loadMediaAlbum) {
      store.dispatch({
        type: MediaLibraryActions.AddAlbum,
        data: {
          mediaAlbum: mediaAlbumBuilt,
        },
      });
    }

    return mediaAlbumBuilt;
  }

  static async buildMediaAlbums(mediaAlbums: string[] | IMediaAlbumData[], loadMediaAlbums = false): Promise<IMediaAlbum[]> {
    return Promise.all(mediaAlbums.map((mediaAlbum: any) => this.buildMediaAlbum(mediaAlbum, loadMediaAlbums)));
  }
}
