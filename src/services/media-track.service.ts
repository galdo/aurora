import _ from 'lodash';
import NodeID3 from 'node-id3';

import { MediaAlbumDatastore, MediaArtistDatastore, MediaTrackDatastore } from '../datastores';
import { IMediaArtist, IMediaTrack, IMediaTrackData } from '../interfaces';
import { MediaLibraryActions } from '../enums';
import { MediaUtils } from '../utils';
import { DataStoreFilterData, DataStoreUpdateData } from '../modules/datastore';
import store from '../store';
import { IPCRenderer, IPCCommChannel } from '../modules/ipc';

import { MediaArtistService } from './media-artist.service';
import { MediaAlbumService } from './media-album.service';

export class MediaTrackService {
  private static readonly collectionCacheTtlMs = 15000;
  private static readonly albumTracksCache = new Map<string, { expiresAt: number; tracks: IMediaTrack[] }>();
  private static readonly albumTracksInFlight = new Map<string, Promise<IMediaTrack[]>>();

  static async searchTracksByName(query: string): Promise<IMediaTrack[]> {
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

    const tracksPrefix = await MediaTrackDatastore.findMediaTracks({
      track_name_normalized: {
        $regex: prefixRegex,
      },
    } as any);

    const tracksContains = tracksPrefix.length < limit
      ? await MediaTrackDatastore.findMediaTracks({
        track_name_normalized: {
          $regex: containsRegex,
        },
      } as any)
      : [];

    const tracksFallback = tracksPrefix.length === 0 && tracksContains.length === 0
      ? await MediaTrackDatastore.findMediaTracks({
        track_name: {
          $regex: containsRawRegex,
        },
      })
      : [];

    const tracksById = new Map<string, IMediaTrackData>();
    [...tracksPrefix, ...tracksContains, ...tracksFallback].forEach((track) => {
      tracksById.set(track.id, track);
    });

    const mediaTracks = await this.buildMediaTracks(Array.from(tracksById.values()));
    const queryTerms = normalizedQuery
      .split(/\s+/)
      .map(value => value.trim())
      .filter(Boolean);

    return _.orderBy(
      mediaTracks,
      [
        track => this.getTrackSearchScore(track, normalizedQuery, queryTerms),
        track => this.normalizeSearchValue(track.track_name),
      ],
      ['desc', 'asc'],
    ).slice(0, limit);
  }

  static async searchTracksByQuery(query: string, limit = 20): Promise<IMediaTrack[]> {
    const normalizedQuery = this.normalizeSearchValue(query);
    if (!normalizedQuery) {
      return [];
    }

    const queryTerms = normalizedQuery
      .split(/\s+/)
      .map(value => value.trim())
      .filter(Boolean);

    if (!queryTerms.length) {
      return [];
    }

    const mediaTrackDataList = await MediaTrackDatastore.findMediaTracks();
    const mediaTracks = await this.buildMediaTracks(mediaTrackDataList);

    const scoredTracks = mediaTracks
      .map((track) => {
        const score = this.getTrackSearchScore(track, normalizedQuery, queryTerms);
        return {
          score,
          track,
        };
      })
      .filter(item => item.score > 0);

    return _.orderBy(
      scoredTracks,
      [
        'score',
        item => this.normalizeSearchValue(item.track.track_name),
      ],
      ['desc', 'asc'],
    )
      .slice(0, limit)
      .map(item => item.track);
  }

  static async getMediaTrack(mediaTrackId: string): Promise<IMediaTrack | undefined> {
    const mediaTrackData = await MediaTrackDatastore.findMediaTrack({
      id: mediaTrackId,
    });

    return mediaTrackData ? this.buildMediaTrack(mediaTrackData) : undefined;
  }

  static async getMediaTrackForProvider(provider: string, provider_id: string): Promise<IMediaTrack | undefined> {
    const mediaTrackData = await MediaTrackDatastore.findMediaTrack({
      provider,
      provider_id,
    });

    return mediaTrackData ? this.buildMediaTrack(mediaTrackData) : undefined;
  }

  static async getMediaAlbumTracks(mediaAlbumId: string): Promise<IMediaTrack[]> {
    const now = Date.now();
    const cachedEntry = this.albumTracksCache.get(mediaAlbumId);
    if (cachedEntry && cachedEntry.expiresAt > now) {
      return cachedEntry.tracks;
    }
    const inFlight = this.albumTracksInFlight.get(mediaAlbumId);
    if (inFlight) {
      return inFlight;
    }

    const requestPromise = this.resolveMediaAlbumTracks(mediaAlbumId)
      .then((tracks) => {
        this.albumTracksCache.set(mediaAlbumId, {
          tracks,
          expiresAt: Date.now() + this.collectionCacheTtlMs,
        });
        this.albumTracksInFlight.delete(mediaAlbumId);
        return tracks;
      })
      .catch((error) => {
        this.albumTracksInFlight.delete(mediaAlbumId);
        throw error;
      });

    this.albumTracksInFlight.set(mediaAlbumId, requestPromise);
    return requestPromise;
  }

  private static async resolveMediaAlbumTracks(mediaAlbumId: string): Promise<IMediaTrack[]> {
    const mediaAlbum = await MediaAlbumService.getMediaAlbum(mediaAlbumId);
    if (!mediaAlbum) {
      return [];
    }

    const selectedAlbumSourceFingerprint = String((mediaAlbum.extra as any)?.source_fingerprint || '').trim();
    const matchingAlbumIds = selectedAlbumSourceFingerprint
      ? (await MediaAlbumDatastore.findMediaAlbums({
        provider: mediaAlbum.provider,
        // @ts-ignore
        'extra.source_fingerprint': selectedAlbumSourceFingerprint,
      } as any)).map(candidateAlbum => candidateAlbum.id)
      : [];

    const directAlbumTrackDataList = await MediaTrackDatastore.findMediaTracks({
      track_album_id: {
        $in: _.uniq([mediaAlbumId, ...matchingAlbumIds]),
      },
    } as any);

    const mediaAlbumTrackDataFromFileSource = selectedAlbumSourceFingerprint
      ? []
      : await this.getFallbackAlbumTracksByFileSource(directAlbumTrackDataList);

    const mediaAlbumTrackDataList = _.uniqBy([
      ...directAlbumTrackDataList,
      ...mediaAlbumTrackDataFromFileSource,
    ], track => track.id);

    const mediaAlbumTracks = await this.buildMediaTracks(mediaAlbumTrackDataList);
    return MediaUtils.sortMediaAlbumTracks(mediaAlbumTracks);
  }

  private static async getFallbackAlbumTracksByFileSource(mediaAlbumTrackDataList: IMediaTrackData[]): Promise<IMediaTrackData[]> {
    const albumTrackFileSources = mediaAlbumTrackDataList
      .map(track => String((track.extra as any)?.file_source || '').trim())
      .filter(Boolean);
    if (albumTrackFileSources.length === 0) {
      return [];
    }
    return MediaTrackDatastore.findMediaTracks({
      // @ts-ignore
      'extra.file_source': {
        $in: _.uniq(albumTrackFileSources),
      },
    } as any);
  }

  static async getMediaArtistTracks(mediaArtistId: string): Promise<IMediaTrack[]> {
    const mediaTrackDataList = await MediaTrackDatastore.findMediaTracks({
      track_artist_ids: [mediaArtistId],
    });

    const mediaTracks = await this.buildMediaTracks(mediaTrackDataList);
    return MediaUtils.sortMediaArtistTracks(mediaTracks);
  }

  static async updateMediaTrack(mediaTrackFilterData: DataStoreFilterData<IMediaTrackData>, mediaTrackUpdateData: DataStoreUpdateData<IMediaTrackData>): Promise<IMediaTrack | undefined> {
    const mediaTrackData = await MediaTrackDatastore.updateMediaTrack(mediaTrackFilterData, {
      ...mediaTrackUpdateData,
      ...(mediaTrackUpdateData.track_name ? {
        track_name_normalized: this.normalizeSearchValue(mediaTrackUpdateData.track_name),
      } : {}),
    });
    if (!mediaTrackData) {
      return undefined;
    }

    return this.buildMediaTrack(mediaTrackData, true);
  }

  static async incrementTrackPlayCount(mediaTrackId: string): Promise<void> {
    const mediaTrack = await this.getMediaTrack(mediaTrackId);
    if (!mediaTrack) {
      return;
    }

    const existingExtra = (mediaTrack.extra || {}) as Record<string, any>;
    const currentPlayCount = Number(existingExtra.play_count || 0);
    const nextPlayCount = Number.isFinite(currentPlayCount) && currentPlayCount > 0
      ? currentPlayCount + 1
      : 1;

    await this.updateMediaTrack({
      id: mediaTrackId,
    }, {
      extra: {
        ...existingExtra,
        play_count: nextPlayCount,
        last_played_at: Date.now(),
      } as any,
      sync_timestamp: Date.now(),
    } as any);
  }

  static async syncTrackMetadata(mediaTrackId: string): Promise<void> {
    const mediaTrack = await this.getMediaTrack(mediaTrackId);
    if (!mediaTrack) {
      return;
    }

    const extra = (mediaTrack.extra as any);
    if (!extra || !extra.file_path) {
      return;
    }

    const filePath = extra.file_path;
    const isMp3 = filePath.toLowerCase().endsWith('.mp3');
    const isFlac = filePath.toLowerCase().endsWith('.flac');

    if (!isMp3 && !isFlac) {
      return;
    }

    const tags: any = {
      title: mediaTrack.track_name,
      trackNumber: mediaTrack.track_number ? String(mediaTrack.track_number) : undefined,
    };

    if (mediaTrack.track_artists && mediaTrack.track_artists.length > 0) {
      tags.artist = mediaTrack.track_artists.map(a => a.artist_name).join(', ');
      tags.performerInfo = tags.artist;
    }

    if (mediaTrack.track_album) {
      tags.album = mediaTrack.track_album.album_name;
      if (mediaTrack.track_album.album_year) {
        tags.year = String(mediaTrack.track_album.album_year);
      }
      if (mediaTrack.track_album.album_genre) {
        tags.genre = mediaTrack.track_album.album_genre;
      }
    }

    let coverImage: string | undefined;
    if (mediaTrack.track_cover_picture && mediaTrack.track_cover_picture.image_data) {
      coverImage = mediaTrack.track_cover_picture.image_data.replace(/^file:\/\//, '');
    } else if (mediaTrack.track_album && mediaTrack.track_album.album_cover_picture && mediaTrack.track_album.album_cover_picture.image_data) {
      coverImage = mediaTrack.track_album.album_cover_picture.image_data.replace(/^file:\/\//, '');
    }

    try {
      if (isMp3) {
        if (coverImage) {
          tags.image = coverImage;
        }
        const result = NodeID3.update(tags, filePath);
        if ((result as any) !== true) {
          console.warn(`Failed to update tags for ${filePath}`, result);
        }
      } else if (isFlac) {
        await IPCRenderer.sendAsyncMessage(IPCCommChannel.DeviceWriteFlacMetadata, {
          filePath,
          tags,
          coverImage,
        });
      }
    } catch (error) {
      console.error(`Error updating tags for ${filePath}`, error);
    }
  }

  static loadMediaAlbumTracks(mediaAlbumId: string): void {
    this
      .getMediaAlbumTracks(mediaAlbumId)
      .then(async (mediaAlbumTracks) => {
        store.dispatch({
          type: MediaLibraryActions.SetAlbum,
          data: {
            mediaAlbum: await MediaAlbumService.getMediaAlbum(mediaAlbumId),
            mediaAlbumTracks,
          },
        });
      });
  }

  static async buildMediaTrack(mediaTrackData: IMediaTrackData, loadMediaTrack = false): Promise<IMediaTrack> {
    const {
      mediaTrackArtists,
      mediaTrackArtistIds,
    } = await this.buildMediaTrackArtists(mediaTrackData);
    const mediaTrackAlbum = await this.resolveTrackAlbum(mediaTrackData, loadMediaTrack);
    const mediaTrack = _.assign({}, mediaTrackData, {
      track_artist_ids: mediaTrackArtistIds,
      track_artists: mediaTrackArtists,
      track_album: mediaTrackAlbum,
    });

    if (loadMediaTrack) {
      store.dispatch({
        type: MediaLibraryActions.AddTrack,
        data: {
          mediaTrack,
        },
      });
    }

    return mediaTrack;
  }

  static async buildMediaTracks(mediaTrackDataList: IMediaTrackData[], loadMediaTracks = false): Promise<IMediaTrack[]> {
    return Promise.all(mediaTrackDataList.map(mediaTrackData => this.buildMediaTrack(mediaTrackData, loadMediaTracks)));
  }

  private static async resolveTrackAlbum(mediaTrackData: IMediaTrackData, loadMediaTrack: boolean) {
    try {
      return await MediaAlbumService.buildMediaAlbum(mediaTrackData.track_album_id, loadMediaTrack);
    } catch (_error) {
      const recoveredAlbum = await this.recoverMissingAlbumForTrack(mediaTrackData);
      return MediaAlbumService.buildMediaAlbum(recoveredAlbum.id, loadMediaTrack);
    }
  }

  private static async recoverMissingAlbumForTrack(mediaTrackData: IMediaTrackData) {
    const extra = (mediaTrackData.extra as any) || {};
    const fileSource = String(extra.file_source || '').trim();
    const recoveredAlbumName = fileSource.split(/[\\/]/).filter(Boolean).pop() || 'Unknown Album';
    const recoveredArtistProviderId = `recovered-artist:${mediaTrackData.provider}:${mediaTrackData.id}`;
    const recoveredArtist = await MediaArtistDatastore.upsertMediaArtist({
      provider: mediaTrackData.provider,
      provider_id: recoveredArtistProviderId,
    }, {
      provider: mediaTrackData.provider,
      provider_id: recoveredArtistProviderId,
      artist_name: 'Unknown Artist',
      sync_timestamp: Date.now(),
    });

    const recoveredAlbumProviderId = `recovered-album:${mediaTrackData.provider}:${mediaTrackData.track_album_id}`;
    const recoveredAlbum = await MediaAlbumDatastore.upsertMediaAlbum({
      provider: mediaTrackData.provider,
      provider_id: recoveredAlbumProviderId,
    }, {
      provider: mediaTrackData.provider,
      provider_id: recoveredAlbumProviderId,
      album_name: recoveredAlbumName,
      album_artist_id: recoveredArtist.id,
      sync_timestamp: Date.now(),
      extra: {
        source_fingerprint: '',
      },
    } as any);

    await MediaTrackDatastore.updateMediaTrack({
      id: mediaTrackData.id,
    }, {
      track_album_id: recoveredAlbum.id,
      sync_timestamp: Date.now(),
    });

    return recoveredAlbum;
  }

  private static normalizeSearchValue(value: string): string {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');
  }

  private static getTrackSearchScore(track: IMediaTrack, normalizedQuery: string, queryTerms: string[]): number {
    const trackName = this.normalizeSearchValue(track.track_name);
    const albumName = this.normalizeSearchValue(track.track_album?.album_name || '');
    const artistName = this.normalizeSearchValue(track.track_artists.map(artist => artist.artist_name).join(' '));
    const combined = `${trackName} ${albumName} ${artistName}`.trim();

    let score = 0;
    if (combined.includes(normalizedQuery)) {
      score += 140;
    }
    if (trackName.includes(normalizedQuery)) {
      score += 180;
    }
    if (artistName.includes(normalizedQuery)) {
      score += 110;
    }
    if (albumName.includes(normalizedQuery)) {
      score += 90;
    }

    queryTerms.forEach((term) => {
      if (trackName === term) {
        score += 140;
      } else if (trackName.startsWith(term)) {
        score += 95;
      } else if (trackName.includes(term)) {
        score += 70;
      }

      if (artistName === term) {
        score += 90;
      } else if (artistName.startsWith(term)) {
        score += 65;
      } else if (artistName.includes(term)) {
        score += 55;
      }

      if (albumName === term) {
        score += 75;
      } else if (albumName.startsWith(term)) {
        score += 50;
      } else if (albumName.includes(term)) {
        score += 40;
      }
    });

    return score;
  }

  private static async buildMediaTrackArtists(mediaTrackData: IMediaTrackData): Promise<{ mediaTrackArtists: IMediaArtist[]; mediaTrackArtistIds: string[] }> {
    const mediaTrackArtists: IMediaArtist[] = [];
    const mediaTrackArtistIds: string[] = [];

    await Promise.all(mediaTrackData.track_artist_ids.map(async (mediaTrackArtistId) => {
      let mediaTrackArtist = await MediaArtistService.getMediaArtist(mediaTrackArtistId);
      if (!mediaTrackArtist) {
        const recoveredArtistProviderId = `recovered-artist:${mediaTrackData.provider}:${mediaTrackArtistId}`;
        const recoveredArtistData = await MediaArtistDatastore.upsertMediaArtist({
          provider: mediaTrackData.provider,
          provider_id: recoveredArtistProviderId,
        }, {
          provider: mediaTrackData.provider,
          provider_id: recoveredArtistProviderId,
          artist_name: 'Unknown Artist',
          sync_timestamp: mediaTrackData.sync_timestamp,
        });
        mediaTrackArtist = await MediaArtistService.getMediaArtist(recoveredArtistData.id);
      }

      if (mediaTrackArtist) {
        mediaTrackArtists.push(mediaTrackArtist);
        mediaTrackArtistIds.push(mediaTrackArtist.id);
      }
    }));

    if (mediaTrackArtists.length === 0) {
      throw new Error(`MediaTrackService encountered error at buildMediaTrackArtists - Could not resolve any artists for track - ${mediaTrackData.id}`);
    }

    const mediaTrackArtistIdsUnique = _.uniq(mediaTrackArtistIds);
    if (!_.isEqual(mediaTrackArtistIdsUnique, mediaTrackData.track_artist_ids)) {
      await MediaTrackDatastore.updateMediaTrack({
        id: mediaTrackData.id,
      }, {
        track_artist_ids: mediaTrackArtistIdsUnique,
      });
    }

    return {
      mediaTrackArtists,
      mediaTrackArtistIds: mediaTrackArtistIdsUnique,
    };
  }
}
