import React, { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import _ from 'lodash';

import {
  COLLECTION_COVER_SIZE_DEFAULT,
  COLLECTION_COVER_SIZE_EVENT,
  getCollectionCoverSize,
  setCollectionCoverSize,
  clampCollectionCoverSize,
} from '../../utils/collection-cover-size.utils';

import {
  CollectionViewControls,
  MediaAlbums,
} from '../../components';
import { MediaTrackDatastore } from '../../datastores';
import { RootState } from '../../reducers';
import { I18nService, MediaAlbumService } from '../../services';
import { IMediaAlbum } from '../../interfaces';

type SortOption = 'artist' | 'album' | 'year' | 'genre' | 'added';
type SortDirection = 'asc' | 'desc';

interface IAlbumsViewSettings {
  sortBy: SortOption;
  sortDirection: SortDirection;
  coverSize: number;
}

const SETTINGS_KEY = 'aurora:albums-view-settings';
const TOP_BAR_SEARCH_MIN_QUERY_LENGTH = 5;
const TOP_BAR_SEARCH_STATE_KEY = 'aurora:topbar-search-query';
const TOP_BAR_SEARCH_CHANGE_EVENT = 'aurora:topbar-search-changed';

const DEFAULT_SETTINGS: IAlbumsViewSettings = {
  sortBy: 'artist',
  sortDirection: 'asc',
  coverSize: COLLECTION_COVER_SIZE_DEFAULT,
};

export function AlbumsPage() {
  const { mediaAlbums } = useSelector((state: RootState) => state.mediaLibrary);
  const [settings, setSettings] = useState<IAlbumsViewSettings>(DEFAULT_SETTINGS);
  const [topBarSearchQuery, setTopBarSearchQuery] = useState(() => localStorage.getItem(TOP_BAR_SEARCH_STATE_KEY) || '');
  const [trackMatchedAlbumIds, setTrackMatchedAlbumIds] = useState<string[]>([]);

  useEffect(() => {
    MediaAlbumService.loadMediaAlbums();
    const saved = localStorage.getItem(SETTINGS_KEY);
    const sharedCoverSize = getCollectionCoverSize();
    if (saved) {
      try {
        const parsedSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
        setSettings({ ...parsedSettings, coverSize: sharedCoverSize });
      } catch (e) {
        setSettings(prev => ({ ...prev, coverSize: sharedCoverSize }));
      }
    } else {
      setSettings(prev => ({ ...prev, coverSize: sharedCoverSize }));
    }
  }, []);

  useEffect(() => {
    const handleCoverSizeChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ coverSize?: number }>;
      const nextSize = clampCollectionCoverSize(Number(customEvent.detail?.coverSize || COLLECTION_COVER_SIZE_DEFAULT));
      setSettings(prev => ({ ...prev, coverSize: nextSize }));
    };
    window.addEventListener(COLLECTION_COVER_SIZE_EVENT, handleCoverSizeChange as EventListener);
    return () => window.removeEventListener(COLLECTION_COVER_SIZE_EVENT, handleCoverSizeChange as EventListener);
  }, []);

  useEffect(() => {
    const handleTopBarSearchChange = (event: Event) => {
      const searchEvent = event as CustomEvent<{ query?: string }>;
      const nextQuery = String(searchEvent.detail?.query || '');
      setTopBarSearchQuery(nextQuery);
    };

    window.addEventListener(TOP_BAR_SEARCH_CHANGE_EVENT, handleTopBarSearchChange as EventListener);
    return () => window.removeEventListener(TOP_BAR_SEARCH_CHANGE_EVENT, handleTopBarSearchChange as EventListener);
  }, []);

  const normalizedTopBarSearchQuery = topBarSearchQuery.toLowerCase().trim();
  const canApplyTopBarFilter = normalizedTopBarSearchQuery.length >= TOP_BAR_SEARCH_MIN_QUERY_LENGTH;
  const topBarSearchTerms = useMemo(() => normalizedTopBarSearchQuery
    .split(/\s+/)
    .map(term => term.trim())
    .filter(Boolean), [normalizedTopBarSearchQuery]);

  useEffect(() => {
    if (!canApplyTopBarFilter) {
      setTrackMatchedAlbumIds([]);
      return () => {};
    }

    let isCancelled = false;
    const timeoutId = window.setTimeout(() => {
      MediaTrackDatastore.findMediaTracks().then((mediaTrackDataList) => {
        if (isCancelled) {
          return;
        }

        const matchedAlbumIds = _.uniq(
          mediaTrackDataList
            .filter((mediaTrackData) => {
              const trackName = String(mediaTrackData.track_name || '').toLowerCase().trim();
              if (!trackName) {
                return false;
              }

              if (trackName.includes(normalizedTopBarSearchQuery)) {
                return true;
              }

              return topBarSearchTerms.every(term => trackName.includes(term));
            })
            .map(mediaTrackData => mediaTrackData.track_album_id),
        );

        setTrackMatchedAlbumIds(matchedAlbumIds);
      });
    }, 130);

    return () => {
      isCancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [
    canApplyTopBarFilter,
    normalizedTopBarSearchQuery,
    topBarSearchTerms,
  ]);

  const updateSettings = (partial: Partial<IAlbumsViewSettings>) => {
    const newSettings = { ...settings, ...partial } as IAlbumsViewSettings;
    if (partial.sortBy === 'added' && _.isNil(partial.sortDirection)) {
      newSettings.sortDirection = 'desc';
    }
    if (!_.isNil(partial.coverSize)) {
      const nextSize = setCollectionCoverSize(partial.coverSize);
      newSettings.coverSize = nextSize;
    }
    setSettings(newSettings);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      sortBy: newSettings.sortBy,
      sortDirection: newSettings.sortDirection,
    }));
  };

  const filteredAlbums = useMemo(() => {
    if (!canApplyTopBarFilter) {
      return mediaAlbums;
    }

    const matchedAlbumIdSet = new Set(trackMatchedAlbumIds);

    return mediaAlbums.filter((album) => {
      const albumName = String(album.album_name || '').toLowerCase().trim();
      const artistName = String(album.album_artist?.artist_name || '').toLowerCase().trim();
      const combined = `${albumName} ${artistName}`.trim();
      if (combined.includes(normalizedTopBarSearchQuery)) {
        return true;
      }

      if (topBarSearchTerms.every(term => combined.includes(term))) {
        return true;
      }

      return matchedAlbumIdSet.has(album.id);
    });
  }, [
    canApplyTopBarFilter,
    mediaAlbums,
    normalizedTopBarSearchQuery,
    topBarSearchTerms,
    trackMatchedAlbumIds,
  ]);

  const sortedAlbums = useMemo(() => {
    let iteratee: any;
    switch (settings.sortBy) {
      case 'artist':
        iteratee = (a: any) => a.album_artist.artist_name.toLowerCase();
        break;
      case 'album':
        iteratee = (a: any) => a.album_name.toLowerCase();
        break;
      case 'year':
        iteratee = 'album_year';
        break;
      case 'genre':
        iteratee = (album: IMediaAlbum) => String(album.album_genre || '').toLowerCase();
        break;
      case 'added':
        iteratee = (album: IMediaAlbum) => Number((album.extra as any)?.added_at || album.sync_timestamp || 0);
        break;
      default:
        iteratee = (a: any) => a.album_artist.artist_name.toLowerCase();
    }

    return (_.orderBy(filteredAlbums, [iteratee], [settings.sortDirection]) || []) as IMediaAlbum[];
  }, [
    filteredAlbums,
    settings.sortBy,
    settings.sortDirection,
  ]);

  return (
    <div className="container-fluid">
      <CollectionViewControls
        coverSize={settings.coverSize}
        onCoverSizeChange={nextValue => updateSettings({ coverSize: nextValue })}
        sortBy={settings.sortBy}
        sortDirection={settings.sortDirection}
        onSortByChange={value => updateSettings({ sortBy: value as SortOption })}
        onSortDirectionToggle={() => updateSettings({
          sortDirection: settings.sortDirection === 'asc' ? 'desc' : 'asc',
        })}
        sortToggleTooltip={I18nService.getString('tooltip_album_sort_toggle')}
        sortOptions={[
          { value: 'artist', label: I18nService.getString('label_album_sort_artist') },
          { value: 'album', label: I18nService.getString('label_album_sort_album') },
          { value: 'year', label: I18nService.getString('label_album_sort_year') },
          { value: 'genre', label: I18nService.getString('label_genre') },
          { value: 'added', label: I18nService.getString('label_album_sort_added') },
        ]}
      />
      <MediaAlbums mediaAlbums={sortedAlbums} coverSize={settings.coverSize} hideArtist={false}/>
    </div>
  );
}
