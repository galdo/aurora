import _ from 'lodash';

import { MediaAlbumDatastore, MediaArtistDatastore, MediaTrackDatastore } from '../datastores';
import { MediaLibraryActions } from '../enums';
import { IMediaArtist, IMediaArtistData } from '../interfaces';
import { MediaUtils } from '../utils';
import { DataStoreFilterData, DataStoreUpdateData } from '../modules/datastore';
import store from '../store';

export type ArtistViewMode = 'off' | 'artists' | 'album_artists';

export class MediaArtistService {
  static async searchArtistsByName(query: string): Promise<IMediaArtist[]> {
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

    const artistsPrefix = await MediaArtistDatastore.findMediaArtists({
      artist_name_normalized: {
        $regex: prefixRegex,
      },
    } as any);

    const artistsContains = artistsPrefix.length < limit
      ? await MediaArtistDatastore.findMediaArtists({
        artist_name_normalized: {
          $regex: containsRegex,
        },
      } as any)
      : [];

    const artistsFallback = artistsPrefix.length === 0 && artistsContains.length === 0
      ? await MediaArtistDatastore.findMediaArtists({
        artist_name: {
          $regex: containsRawRegex,
        },
      })
      : [];

    const artistsById = new Map<string, IMediaArtistData>();
    [...artistsPrefix, ...artistsContains, ...artistsFallback].forEach((artist) => {
      artistsById.set(artist.id, artist);
    });

    const mediaArtists = await this.buildMediaArtists(Array.from(artistsById.values()));
    return _.orderBy(
      mediaArtists,
      [artist => this.normalizeSearchValue(artist.artist_name)],
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

  static async getMediaArtist(artistId: string): Promise<IMediaArtist | undefined> {
    const artistData = await MediaArtistDatastore.findMediaArtistById(artistId);
    return artistData ? this.buildMediaArtist(artistData) : undefined;
  }

  static async getMediaArtists(mode: ArtistViewMode = 'artists'): Promise<IMediaArtist[]> {
    if (mode === 'off') {
      return [];
    }

    const mediaArtistDataList = await MediaArtistDatastore.findMediaArtists();
    if (mode === 'album_artists') {
      const visibleAlbums = await MediaAlbumDatastore.findMediaAlbums({
        hidden: { $ne: true },
      } as any);
      const albumArtistIdSet = new Set<string>(
        visibleAlbums
          .map(album => String(album.album_artist_id || '').trim())
          .filter(Boolean),
      );
      const compilationAlbumIds = visibleAlbums
        .filter(album => this.isCompilationAlbumArtistName(album))
        .map(album => album.id);
      if (compilationAlbumIds.length > 0) {
        const compilationTracks = await MediaTrackDatastore.findMediaTracks({
          track_album_id: {
            $in: compilationAlbumIds,
          },
        } as any);
        compilationTracks.forEach((track) => {
          (track.track_artist_ids || []).forEach((artistId) => {
            const normalizedArtistId = String(artistId || '').trim();
            if (normalizedArtistId) {
              albumArtistIdSet.add(normalizedArtistId);
            }
          });
        });
      }

      const filteredArtistDataList = mediaArtistDataList.filter(artist => albumArtistIdSet.has(String(artist.id || '').trim()));
      const mediaArtists = await Promise.all(filteredArtistDataList.map(mediaArtistData => this.buildMediaArtist(mediaArtistData)));
      return MediaUtils.sortMediaArtists(mediaArtists);
    }

    const mediaArtists = await Promise.all(mediaArtistDataList.map(mediaArtistData => this.buildMediaArtist(mediaArtistData)));
    return MediaUtils.sortMediaArtists(mediaArtists);
  }

  static async updateMediaArtists(mediaArtistFilterData: DataStoreFilterData<IMediaArtistData>, mediaArtistUpdateData: DataStoreUpdateData<IMediaArtistData>): Promise<IMediaArtist[] | undefined> {
    const mediaAlbumDataList = await MediaArtistDatastore.updateArtists(mediaArtistFilterData, {
      ...mediaArtistUpdateData,
      ...(mediaArtistUpdateData.artist_name ? {
        artist_name_normalized: this.normalizeSearchValue(mediaArtistUpdateData.artist_name),
      } : {}),
    });
    return this.buildMediaArtists(mediaAlbumDataList, true);
  }

  static loadMediaArtists(mode: ArtistViewMode = 'artists'): void {
    this
      .getMediaArtists(mode)
      .then((mediaArtists) => {
        store.dispatch({
          type: MediaLibraryActions.SetArtists,
          data: {
            mediaArtists,
          },
        });
      });
  }

  static unloadMediaArtist(): void {
    store.dispatch({
      type: MediaLibraryActions.SetArtist,
      data: {
        mediaArtist: undefined,
        mediaArtistAlbums: undefined,
      },
    });
  }

  static async buildMediaArtist(mediaArtist: string | IMediaArtistData, loadMediaArtist = false): Promise<IMediaArtist> {
    // info - no further processing required for MediaArtistData -> MediaArtist
    let mediaArtistData;
    if (typeof mediaArtist === 'string') {
      mediaArtistData = await MediaArtistDatastore.findMediaArtistById(mediaArtist);

      if (!mediaArtistData) {
        throw new Error(`MediaLibraryService encountered error at buildMediaArtist - Could not find artist - ${mediaArtist}`);
      }
    } else {
      mediaArtistData = mediaArtist;
    }

    if (loadMediaArtist) {
      store.dispatch({
        type: MediaLibraryActions.AddArtist,
        data: {
          mediaArtist: mediaArtistData,
        },
      });
    }

    return mediaArtistData;
  }

  static async buildMediaArtists(mediaArtists: string[] | IMediaArtistData[], loadMediaArtists = false): Promise<IMediaArtist[]> {
    return Promise.all(mediaArtists.map((mediaArtist: any) => this.buildMediaArtist(mediaArtist, loadMediaArtists)));
  }

  private static isCompilationAlbumArtistName(album: any): boolean {
    const albumArtistName = String(album?.album_artist?.artist_name || '').toLowerCase().trim();
    if (!albumArtistName) {
      return false;
    }

    return [
      'various artists',
      'various artist',
      'various',
      'v.a.',
      'va',
      'sampler',
      'compilation',
      'anthology',
      'soundtrack',
      'ost',
    ].includes(albumArtistName);
  }
}
