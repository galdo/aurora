import React, { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import _ from 'lodash';

import { MediaArtists } from '../../components';
import { useRegisterTopMenuBarSort } from '../../components/top-menu-bar/top-menu-bar.sort-store';
import { RootState } from '../../reducers';
import { I18nService, MediaArtistService } from '../../services';
import { ArtistViewMode } from '../../services/media-artist.service';
import { IMediaArtist } from '../../interfaces';
import {
  COLLECTION_COVER_SIZE_DEFAULT,
  COLLECTION_COVER_SIZE_EVENT,
  clampCollectionCoverSize,
  getCollectionCoverSize,
} from '../../utils/collection-cover-size.utils';

type SortOption = 'artist' | 'added' | 'genre';
type SortDirection = 'asc' | 'desc';

const SETTINGS_KEY = 'aurora:artists-view-settings';
const UI_SETTINGS_KEY = 'aurora:ui-settings';

const getArtistViewMode = (): ArtistViewMode => {
  const saved = localStorage.getItem(UI_SETTINGS_KEY);
  if (!saved) {
    return 'artists';
  }

  try {
    const parsed = JSON.parse(saved);
    const parsedMode = String(parsed.artistViewMode || '').trim();
    if (parsedMode === 'off' || parsedMode === 'artists' || parsedMode === 'album_artists') {
      return parsedMode;
    }
    return parsed.hideArtist ? 'off' : 'artists';
  } catch (_error) {
    return 'artists';
  }
};

export function ArtistsPage() {
  const { mediaArtists, mediaAlbums } = useSelector((state: RootState) => state.mediaLibrary);
  const [coverSize, setCoverSize] = useState(COLLECTION_COVER_SIZE_DEFAULT);
  const [sortBy, setSortBy] = useState<SortOption>('artist');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [artistViewMode, setArtistViewMode] = useState<ArtistViewMode>(() => getArtistViewMode());

  useEffect(() => {
    MediaArtistService.loadMediaArtists(artistViewMode);
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.sortBy === 'artist' || parsed.sortBy === 'added' || parsed.sortBy === 'genre') {
          setSortBy(parsed.sortBy);
        }
        if (parsed.sortDirection === 'asc' || parsed.sortDirection === 'desc') {
          setSortDirection(parsed.sortDirection);
        }
      } catch (_error) {
        localStorage.removeItem(SETTINGS_KEY);
      }
    }
    setCoverSize(getCollectionCoverSize());
  }, [artistViewMode]);

  useEffect(() => {
    const handleSettingsChanged = () => {
      setArtistViewMode(getArtistViewMode());
    };

    window.addEventListener('aurora:settings-changed', handleSettingsChanged);
    return () => window.removeEventListener('aurora:settings-changed', handleSettingsChanged);
  }, []);

  useEffect(() => {
    const handleCoverSizeChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ coverSize?: number }>;
      const nextSize = clampCollectionCoverSize(Number(customEvent.detail?.coverSize || COLLECTION_COVER_SIZE_DEFAULT));
      setCoverSize(nextSize);
    };
    window.addEventListener(COLLECTION_COVER_SIZE_EVENT, handleCoverSizeChange as EventListener);
    return () => window.removeEventListener(COLLECTION_COVER_SIZE_EVENT, handleCoverSizeChange as EventListener);
  }, []);

  const artistGenreById = useMemo(() => {
    const genreById = new Map<string, string>();
    mediaAlbums.forEach((album) => {
      const artistId = String(album.album_artist?.id || '').trim();
      const genre = String(album.album_genre || '').trim().toLowerCase();
      if (!artistId || !genre || genreById.has(artistId)) {
        return;
      }
      genreById.set(artistId, genre);
    });
    return genreById;
  }, [mediaAlbums]);

  const sortedArtists = useMemo(() => {
    let iteratee: any;
    switch (sortBy) {
      case 'added':
        iteratee = (artist: IMediaArtist) => Number((artist.extra as any)?.added_at || artist.sync_timestamp || 0);
        break;
      case 'genre':
        iteratee = (artist: IMediaArtist) => artistGenreById.get(artist.id) || '';
        break;
      case 'artist':
      default:
        iteratee = (artist: IMediaArtist) => String(artist.artist_name || '').toLowerCase();
    }
    return (_.orderBy(mediaArtists, [iteratee], [sortDirection]) || []) as IMediaArtist[];
  }, [artistGenreById, mediaArtists, sortBy, sortDirection]);

  const updateSort = (nextSortBy: SortOption, nextSortDirection: SortDirection) => {
    const effectiveSortDirection = nextSortBy === 'added' && nextSortDirection === 'asc'
      ? 'desc'
      : nextSortDirection;
    setSortBy(nextSortBy);
    setSortDirection(effectiveSortDirection);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      sortBy: nextSortBy,
      sortDirection: effectiveSortDirection,
    }));
  };

  // Artist label depends on the current view mode — the same control sorts
  // either "Artists" or "Album Artists" depending on what the user has
  // configured in the global UI settings. We surface that to the user via
  // a context-aware label (falls back to the generic "Artist" string if no
  // mode-specific i18n key is registered yet).
  const artistSortLabel = useMemo(() => {
    if (artistViewMode === 'album_artists') {
      return I18nService.getString('label_album_sort_album_artist')
        || I18nService.getString('label_album_sort_artist');
    }
    return I18nService.getString('label_album_sort_artist');
  }, [artistViewMode]);

  const topMenuBarSortConfig = useMemo(() => ({
    options: [
      { value: 'artist', label: artistSortLabel },
      { value: 'added', label: I18nService.getString('label_album_sort_added') },
      { value: 'genre', label: I18nService.getString('label_genre') },
    ],
    currentValue: sortBy,
    direction: sortDirection,
    onSortChange: (value: string) => updateSort(value as SortOption, sortDirection),
    onDirectionToggle: () => updateSort(sortBy, sortDirection === 'asc' ? 'desc' : 'asc'),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [artistSortLabel, sortBy, sortDirection]);

  useRegisterTopMenuBarSort(topMenuBarSortConfig);

  return (
    <div className="container-fluid">
      <div className="row">
        <MediaArtists mediaArtists={sortedArtists} coverSize={coverSize}/>
      </div>
    </div>
  );
}
