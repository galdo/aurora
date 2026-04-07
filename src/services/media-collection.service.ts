import {
  IMediaAlbum,
  IMediaArtist,
  IMediaCollectionItem,
  IMediaCollectionSearchResults,
  IMediaPlaylist,
  IMediaTrack,
} from '../interfaces';

import { Icons, Routes } from '../constants';
import { MediaCollectionItemType } from '../enums';
import { StringUtils } from '../utils';

import { I18nService } from './i18n.service';
import { MediaAlbumService } from './media-album.service';
import { MediaArtistService } from './media-artist.service';
import { MediaTrackService } from './media-track.service';
import { MediaLikedTrackService } from './media-liked-track.service';
import { MediaPlaylistService } from './media-playlist.service';

export class MediaCollectionService {
  private static readonly tracksCacheTtlMs = 15000;
  private static readonly tracksCache = new Map<string, { expiresAt: number; tracks: IMediaTrack[] }>();
  private static readonly tracksInFlight = new Map<string, Promise<IMediaTrack[]>>();
  private static readonly searchCacheTtlMs = 5000;
  private static readonly searchCache = new Map<string, { expiresAt: number; result: IMediaCollectionSearchResults }>();
  private static readonly searchInFlight = new Map<string, Promise<IMediaCollectionSearchResults>>();

  static async searchCollection(query: string): Promise<IMediaCollectionSearchResults> {
    const searchQuery = String(query || '').trim();
    if (!searchQuery) {
      return {
        tracks: [],
        albums: [],
        artists: [],
        playlists: [],
      };
    }
    const cacheKey = searchQuery.toLowerCase();
    const now = Date.now();
    const cachedEntry = this.searchCache.get(cacheKey);
    if (cachedEntry && cachedEntry.expiresAt > now) {
      return cachedEntry.result;
    }
    const inFlightSearch = this.searchInFlight.get(cacheKey);
    if (inFlightSearch) {
      return inFlightSearch;
    }

    const requestPromise = Promise.all([
      MediaTrackService.searchTracksByName(searchQuery),
      MediaAlbumService.searchAlbumsByName(searchQuery),
      MediaArtistService.searchArtistsByName(searchQuery),
      MediaPlaylistService.searchPlaylistsByName(searchQuery),
    ])
      .then(([tracks, albums, artists, playlists]) => {
        const result: IMediaCollectionSearchResults = {
          tracks,
          albums,
          artists,
          playlists,
        };
        this.searchCache.set(cacheKey, {
          result,
          expiresAt: Date.now() + this.searchCacheTtlMs,
        });
        this.searchInFlight.delete(cacheKey);
        return result;
      })
      .catch((error) => {
        this.searchInFlight.delete(cacheKey);
        throw error;
      });
    this.searchInFlight.set(cacheKey, requestPromise);
    return requestPromise;
  }

  static async getMediaCollectionTracks(mediaCollectionItem: IMediaCollectionItem): Promise<IMediaTrack[]> {
    const cacheKey = `${mediaCollectionItem.type}:${mediaCollectionItem.id}`;
    const now = Date.now();
    const cachedEntry = this.tracksCache.get(cacheKey);
    if (cachedEntry && cachedEntry.expiresAt > now) {
      return cachedEntry.tracks;
    }
    const inFlight = this.tracksInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const requestPromise = this.resolveMediaCollectionTracks(mediaCollectionItem)
      .then((tracks) => {
        this.tracksCache.set(cacheKey, {
          tracks,
          expiresAt: Date.now() + this.tracksCacheTtlMs,
        });
        this.tracksInFlight.delete(cacheKey);
        return tracks;
      })
      .catch((error) => {
        this.tracksInFlight.delete(cacheKey);
        throw error;
      });

    this.tracksInFlight.set(cacheKey, requestPromise);
    return requestPromise;
  }

  private static async resolveMediaCollectionTracks(mediaCollectionItem: IMediaCollectionItem): Promise<IMediaTrack[]> {
    switch (mediaCollectionItem.type) {
      case MediaCollectionItemType.Album:
        return MediaTrackService.getMediaAlbumTracks(mediaCollectionItem.id);
      case MediaCollectionItemType.Artist:
        return MediaTrackService.getMediaArtistTracks(mediaCollectionItem.id);
      case MediaCollectionItemType.Playlist:
        return MediaPlaylistService.resolveMediaPlaylistTracks(mediaCollectionItem.id);
      case MediaCollectionItemType.LikedTracks:
        return MediaLikedTrackService.resolveLikedTracks();
      default:
        throw new Error(`Unsupported media collection type - ${mediaCollectionItem.type}`);
    }
  }

  static getMediaItemFromAlbum(mediaAlbum: IMediaAlbum): IMediaCollectionItem {
    return {
      id: mediaAlbum.id,
      type: MediaCollectionItemType.Album,
      name: mediaAlbum.album_name,
      picture: mediaAlbum.album_cover_picture,
      hidden: mediaAlbum.hidden,
    };
  }

  static getMediaItemFromArtist(mediaArtist: IMediaArtist): IMediaCollectionItem {
    const artistExtra = mediaArtist.extra as { artist_feature_picture_loading?: boolean } | undefined;
    return {
      id: mediaArtist.id,
      name: mediaArtist.artist_name,
      type: MediaCollectionItemType.Artist,
      picture: mediaArtist.artist_feature_picture,
      pictureLoading: !mediaArtist.artist_feature_picture && !!artistExtra?.artist_feature_picture_loading,
    };
  }

  static getMediaItemFromPlaylist(mediaPlaylist: IMediaPlaylist): IMediaCollectionItem {
    return {
      id: mediaPlaylist.id,
      name: mediaPlaylist.name,
      type: MediaCollectionItemType.Playlist,
      picture: mediaPlaylist.cover_picture,
      hidden: mediaPlaylist.is_hidden_album,
    };
  }

  static getMediaItemForLikedTracks() {
    return {
      id: 'liked-tracks',
      name: I18nService.getString('label_liked_tracks_collection_name'),
      type: MediaCollectionItemType.LikedTracks,
      picture: undefined,
    };
  }

  static getItemCoverPlaceholderIcon(mediaCollectionItem: IMediaCollectionItem): string {
    switch (mediaCollectionItem.type) {
      case MediaCollectionItemType.Artist:
        return Icons.ArtistPlaceholder;
      case MediaCollectionItemType.Album:
        return Icons.AlbumPlaceholder;
      case MediaCollectionItemType.Playlist:
        if (mediaCollectionItem.id === MediaPlaylistService.mostPlayedPlaylistId) {
          return Icons.PlaylistMostPlayed;
        }
        return Icons.PlaylistPlaceholder;
      case MediaCollectionItemType.LikedTracks:
        return Icons.MediaLike;
      default:
        return Icons.AlbumPlaceholder;
    }
  }

  static getItemRouterLink(mediaCollectionItem: IMediaCollectionItem): string {
    switch (mediaCollectionItem.type) {
      case MediaCollectionItemType.Album:
        return StringUtils.buildRoute(Routes.LibraryAlbum, {
          albumId: mediaCollectionItem.id,
        });
      case MediaCollectionItemType.Artist:
        return StringUtils.buildRoute(Routes.LibraryArtist, {
          artistId: mediaCollectionItem.id,
        });
      case MediaCollectionItemType.Playlist:
        return StringUtils.buildRoute(Routes.LibraryPlaylist, {
          playlistId: mediaCollectionItem.id,
        });
      case MediaCollectionItemType.LikedTracks:
        return Routes.LibraryLikedTracks;
      default:
        throw new Error(`Unsupported media collection type - ${mediaCollectionItem.type}`);
    }
  }

  static getItemSubtitle(mediaCollectionItem: IMediaCollectionItem): string {
    switch (mediaCollectionItem.type) {
      case MediaCollectionItemType.Artist:
        return I18nService.getString('label_artist_header');
      case MediaCollectionItemType.Album:
        return I18nService.getString('label_album_header');
      case MediaCollectionItemType.Playlist:
      case MediaCollectionItemType.LikedTracks:
        return I18nService.getString('label_playlist_header');
      default:
        throw new Error(`Unsupported media collection type - ${mediaCollectionItem.type}`);
    }
  }

  static async getMediaItem(id: string, type: MediaCollectionItemType): Promise<IMediaCollectionItem | undefined> {
    switch (type) {
      case MediaCollectionItemType.Album: {
        const album = await MediaAlbumService.getMediaAlbum(id);
        return album ? this.getMediaItemFromAlbum(album) : undefined;
      }
      case MediaCollectionItemType.Artist: {
        const artist = await MediaArtistService.getMediaArtist(id);
        return artist ? this.getMediaItemFromArtist(artist) : undefined;
      }
      case MediaCollectionItemType.Playlist: {
        const playlist = await MediaPlaylistService.getMediaPlaylist(id);
        return playlist ? this.getMediaItemFromPlaylist(playlist) : undefined;
      }
      case MediaCollectionItemType.LikedTracks: {
        return this.getMediaItemForLikedTracks();
      }
      default:
        throw new Error(`Unsupported media collection type - ${type}`);
    }
  }
}
