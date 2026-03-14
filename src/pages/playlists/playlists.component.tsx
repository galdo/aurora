import React, { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import classNames from 'classnames/bind';
import { useHistory } from 'react-router-dom';
import _ from 'lodash';

import { Icons, Routes } from '../../constants';
import { selectSortedPlaylists } from '../../selectors';
import { I18nService, MediaPlaylistService } from '../../services';
import MediaLocalLibraryService from '../../providers/media-local/media-local-library.service';
import { StringUtils } from '../../utils';
import { useModal } from '../../contexts';

import {
  Button,
  CollectionViewControls,
  MediaPlaylists,
  MediaLikedTracksCollectionItem,
  MediaMostPlayedCollectionItem,
  MediaPlaylistWizardModal,
} from '../../components';
import {
  COLLECTION_COVER_SIZE_DEFAULT,
  COLLECTION_COVER_SIZE_EVENT,
  clampCollectionCoverSize,
  getCollectionCoverSize,
  setCollectionCoverSize,
} from '../../utils/collection-cover-size.utils';

import styles from './playlists.component.css';

const cx = classNames.bind(styles);
type SortOption = 'album' | 'added';
type SortDirection = 'asc' | 'desc';
const SETTINGS_KEY = 'aurora:playlists-view-settings';

function PlaylistsEmptySection() {
  const history = useHistory();
  const { showModal } = useModal();

  return (
    <div className={cx('playlists-empty-section')}>
      <div className={cx('playlists-empty-label')}>
        {I18nService.getString('label_playlists_empty')}
      </div>
      <div className={cx('playlists-empty-create-button')}>
        <Button
          icon={Icons.AddCircle}
          onButtonSubmit={() => {
            showModal(MediaPlaylistWizardModal, {}, {
              onComplete: (result) => {
                if (!result?.createdPlaylist) {
                  return;
                }

                const pathToPlaylist = StringUtils.buildRoute(Routes.LibraryPlaylist, {
                  playlistId: result.createdPlaylist.id,
                });
                history.push(pathToPlaylist);
              },
            });
          }}
        >
          {I18nService.getString('button_create_playlist')}
        </Button>
      </div>
    </div>
  );
}

export function PlaylistsPage() {
  const mediaPlaylists = useSelector(selectSortedPlaylists);
  const [coverSize, setCoverSize] = useState(COLLECTION_COVER_SIZE_DEFAULT);
  const [sortBy, setSortBy] = useState<SortOption>('album');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  useEffect(() => {
    MediaPlaylistService.loadMediaPlaylists();
    MediaLocalLibraryService.refreshPlaylistCoversOncePerSession();
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.sortBy === 'album' || parsed.sortBy === 'added') {
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

  const sortedPlaylists = useMemo(() => {
    const iteratee = sortBy === 'added'
      ? (playlist: any) => Number(playlist.created_at || playlist.updated_at || 0)
      : (playlist: any) => String(playlist.name || '').toLowerCase();
    return _.orderBy(mediaPlaylists, [iteratee], [sortDirection]);
  }, [mediaPlaylists, sortBy, sortDirection]);
  const visiblePlaylists = useMemo(
    () => sortedPlaylists.filter(playlist => playlist.id !== MediaPlaylistService.mostPlayedPlaylistId),
    [sortedPlaylists],
  );

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

  return (
    <div className="container-fluid">
      <CollectionViewControls
        coverSize={coverSize}
        onCoverSizeChange={value => setCoverSize(setCollectionCoverSize(value))}
        sortBy={sortBy}
        sortDirection={sortDirection}
        onSortByChange={value => updateSort(value as SortOption, sortDirection)}
        onSortDirectionToggle={() => updateSort(sortBy, sortDirection === 'asc' ? 'desc' : 'asc')}
        sortToggleTooltip={I18nService.getString('tooltip_album_sort_toggle')}
        sortOptions={[
          { value: 'album', label: 'Playlist Titel' },
          { value: 'added', label: I18nService.getString('label_album_sort_added') },
        ]}
      />
      <div className={cx('playlist-liked-tracks')}>
        <MediaLikedTracksCollectionItem className={cx('playlist-liked-tracks-collection-item')}/>
        <MediaMostPlayedCollectionItem className={cx('playlist-liked-tracks-collection-item')}/>
      </div>
      {_.isEmpty(visiblePlaylists) && (
        <PlaylistsEmptySection/>
      )}
      <MediaPlaylists mediaPlaylists={visiblePlaylists} coverSize={coverSize}/>
    </div>
  );
}
