import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import classNames from 'classnames/bind';
import _ from 'lodash';
import { useSelector } from 'react-redux';
import { useHistory, useLocation } from 'react-router-dom';

import routes from '../app.routes';
import { MediaTrackDatastore } from '../../datastores';

import {
  Icon,
  MediaLibraryStatsModal,
  MediaPlaylistWizardModal,
  MediaPodcastSubscribeModal,
  TextInput,
  RouterSwitchComponent,
  TopMenuBar,
} from '../../components';
import { TopMenuBarConfig, TopMenuBarSegment, TopMenuBarAction } from '../../components/top-menu-bar/top-menu-bar.types';
import { useModal } from '../../contexts';
import { IMediaTrack } from '../../interfaces';
import { usePersistentScroll } from '../../hooks';
import { RootState } from '../../reducers';
import {
  AppService,
  I18nService,
  MediaLibraryService,
  MediaPlayerService,
  MediaTrackService,
} from '../../services';
import { Icons, Routes } from '../../constants';
import { PlatformOS } from '../../modules/platform/platform.enums';
import MediaLocalLibraryService from '../../providers/media-local/media-local-library.service';
import { StringUtils } from '../../utils';

import {
  getCollectionCoverSize,
  setCollectionCoverSize,
  COLLECTION_COVER_SIZE_MIN,
  COLLECTION_COVER_SIZE_MAX,
} from '../../utils/collection-cover-size.utils';
import libraryRoutes from '../../pages/library/library.routes';

import styles from './browser.component.css';

const cx = classNames.bind(styles);
const TopBarSearchMinQueryLength = 3;
const TopBarSearchResultLimit = 8;
const TopBarSearchDebounceMs = 150;
const TopBarSearchStateKey = 'aurora:topbar-search-query';
const TopBarSearchChangeEvent = 'aurora:topbar-search-changed';

// Event for LibraryHeader visibility (kept for backward compat)
export const HeaderOverflowEvent = 'aurora:header-overflow-changed';

/**
 * Search overlay component (renders in the search slot)
 */
function BrowserSearch() {
  const history = useHistory();
  const location = useLocation();
  const isSettingsPage = location.pathname === Routes.Settings;
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRequestRef = useRef(0);

  const [query, setQuery] = useState(() => localStorage.getItem(TopBarSearchStateKey) || '');
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [results, setResults] = useState<IMediaTrack[]>([]);

  const trimmedQuery = query.trim();
  const canSearch = trimmedQuery.length >= TopBarSearchMinQueryLength;

  const submitSearchRoute = useCallback((searchQuery: string) => {
    history.push(StringUtils.buildRoute(Routes.Search, {}, { q: searchQuery }));
  }, [history]);

  useEffect(() => {
    if (!canSearch) { setResults([]); setIsLoading(false); return () => {}; }
    const requestId = ++searchRequestRef.current;
    setIsLoading(true); setIsOpen(true);
    const tid = window.setTimeout(() => {
      MediaTrackService.searchTracksByQuery(trimmedQuery, TopBarSearchResultLimit)
        .then((tracks) => { if (searchRequestRef.current === requestId) setResults(tracks); })
        .finally(() => { if (searchRequestRef.current === requestId) setIsLoading(false); });
    }, TopBarSearchDebounceMs);
    return () => window.clearTimeout(tid);
  }, [canSearch, trimmedQuery]);

  useEffect(() => {
    if (isSettingsPage) { setIsOpen(false); return; }
    const q = canSearch ? trimmedQuery : '';
    localStorage.setItem(TopBarSearchStateKey, q);
    window.dispatchEvent(new CustomEvent(TopBarSearchChangeEvent, { detail: { query: q } }));
  }, [canSearch, isSettingsPage, trimmedQuery]);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (!containerRef.current?.contains(e.target as Node)) setIsOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  useEffect(() => { setIsOpen(false); }, [location.pathname, location.search]);

  if (isSettingsPage) return null;

  return (
    <div ref={containerRef} className={cx('browser-search')}>
      <TextInput
        clearable
        className={cx('browser-search-input')}
        placeholder={I18nService.getString('placeholder_search_input')}
        icon={Icons.Search}
        onInputValue={value => setQuery(value)}
        onFocus={() => setIsOpen(canSearch)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { setIsOpen(false); return; }
          if (event.key === 'Enter' && canSearch) { submitSearchRoute(trimmedQuery); setIsOpen(false); }
        }}
      />
      {isOpen && canSearch && (
        <div className={cx('browser-search-results')}>
          {isLoading && <div className={cx('browser-search-status')}>...</div>}
          {!isLoading && results.length === 0 && (
            <div className={cx('browser-search-status')}>
              {I18nService.getString('search_result_heading_tracks')}
              : 0
            </div>
          )}
          {!isLoading && results.map(track => (
            <button
              key={track.id}
              type="button"
              className={cx('browser-search-result')}
              onClick={() => {
                MediaPlayerService.playMediaTrack(track);
                history.push(StringUtils.buildRoute(Routes.LibraryAlbum, { albumId: track.track_album.id }));
                setIsOpen(false);
              }}
            >
              <span className={cx('browser-search-result-title')}>{track.track_name}</span>
              <span className={cx('browser-search-result-meta')}>
                {track.track_artists.map(a => a.artist_name).join(', ')}
                {' '}
                •
                {track.track_album.album_name}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Hook that builds a TopMenuBarConfig based on the current route.
 */
function useTopMenuBarConfig(): TopMenuBarConfig {
  const history = useHistory();
  const location = useLocation();
  const { showModal } = useModal();
  const mediaAlbumsCount = useSelector((state: RootState) => state.mediaLibrary.mediaAlbums.length);
  const mediaPlaylistsCount = useSelector((state: RootState) => state.mediaLibrary.mediaPlaylists.length);
  const currentTrackId = useSelector((state: RootState) => state.mediaPlayer.mediaPlaybackCurrentMediaTrack?.id);
  const [isSyncRunning, setIsSyncRunning] = useState(false);

  const isLibrary = location.pathname.startsWith(Routes.Library);
  const isSettings = location.pathname === Routes.Settings;
  const isEqualizer = location.pathname === Routes.Equalizer;
  const isPodcasts = location.pathname.startsWith(Routes.Podcasts);
  const isPlaylists = location.pathname.startsWith(Routes.LibraryPlaylists);
  const isPlayerQueue = location.pathname.startsWith(Routes.PlayerQueue);

  // --- Artist view mode from settings ---
  const [artistViewMode, setArtistViewMode] = useState<'off' | 'artists' | 'album_artists'>(() => {
    try {
      const saved = localStorage.getItem('aurora:ui-settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        const mode = String(parsed.artistViewMode || '').trim();
        if (mode === 'off' || mode === 'artists' || mode === 'album_artists') return mode;
        return parsed.hideArtist ? 'off' : 'artists';
      }
    } catch (e) {}
    return 'artists';
  });

  useEffect(() => {
    const checkSettings = () => {
      try {
        const saved = localStorage.getItem('aurora:ui-settings');
        if (saved) {
          const parsed = JSON.parse(saved);
          const mode = String(parsed.artistViewMode || '').trim();
          if (mode === 'off' || mode === 'artists' || mode === 'album_artists') {
            setArtistViewMode(mode);
          } else {
            setArtistViewMode(parsed.hideArtist ? 'off' : 'artists');
          }
        }
      } catch (e) {}
    };
    checkSettings();
    window.addEventListener('aurora:settings-changed', checkSettings);
    return () => window.removeEventListener('aurora:settings-changed', checkSettings);
  }, []);

  // --- Navigation segments for Library ---
  const segments: TopMenuBarSegment[] | undefined = useMemo(() => {
    if (!isLibrary) return undefined;
    return libraryRoutes
      .filter((r) => {
        if (!r.tHeaderName) return false;
        // Hide "Künstler" tab when artistViewMode is "off"
        if (artistViewMode === 'off' && r.path === Routes.LibraryArtists) return false;
        return true;
      })
      .map(r => ({
        id: r.path,
        label: I18nService.getString(r.tHeaderName!) || r.tHeaderName!,
        isActive: location.pathname === r.path,
        onSelect: () => history.push(r.path),
      }));
  }, [isLibrary, location.pathname, history, artistViewMode]);

  // --- Actions ---
  const handleShuffle = useCallback(async () => {
    const trackDataList = await MediaTrackDatastore.findMediaTracks({});
    const tracks = await MediaTrackService.buildMediaTracks(trackDataList);
    if (tracks && tracks.length > 0) {
      const shuffled = _.shuffle(tracks);
      if (currentTrackId && shuffled.length > 1 && shuffled[0].id === currentTrackId) {
        const idx = shuffled.findIndex(t => t.id !== currentTrackId);
        if (idx > 0) [shuffled[0], shuffled[idx]] = [shuffled[idx], shuffled[0]];
      }
      MediaPlayerService.playMediaTracks(shuffled);
    }
  }, [currentTrackId]);

  const handleStats = useCallback(() => {
    showModal(MediaLibraryStatsModal, { albumsCount: mediaAlbumsCount, playlistsCount: mediaPlaylistsCount }, { dialogClassName: 'library-stats-modal-dialog' });
  }, [showModal, mediaAlbumsCount, mediaPlaylistsCount]);

  const handleSync = useCallback(() => {
    if (isSyncRunning) return;
    setIsSyncRunning(true);
    MediaLocalLibraryService.syncMediaTracks()
      .then(async () => {
        const s = MediaLibraryService.getDapSyncSettings();
        if (s.transport === 'filesystem' && !s.targetDirectory) return;
        await MediaLibraryService.syncDapLibrary({ targetDirectory: s.targetDirectory, deleteMissingOnDevice: s.deleteMissingOnDevice, transport: s.transport });
      })
      .catch(() => {})
      .finally(() => setIsSyncRunning(false));
  }, [isSyncRunning]);

  const handleCreate = useCallback(() => {
    if (isPodcasts) {
      showModal(MediaPodcastSubscribeModal, {}, { dialogClassName: 'podcast-discover-modal-dialog', backdropClassName: 'podcast-discover-modal-backdrop' });
      return;
    }
    showModal(MediaPlaylistWizardModal, {}, {
      onComplete: (result) => {
        if (result?.createdPlaylist) history.push(StringUtils.buildRoute(Routes.LibraryPlaylist, { playlistId: result.createdPlaylist.id }));
      },
    });
  }, [history, isPodcasts, showModal]);

  const actions: TopMenuBarAction[] = useMemo(() => {
    const result: TopMenuBarAction[] = [];

    // Cover size decrease/increase — adjusts album cover grid size (left-most)
    if (isLibrary) {
      const coverSizeStep = 30;

      result.push({
        id: 'zoom-out',
        label: I18nService.getString('label_zoom_out'),
        icon: Icons.ZoomOut,
        priority: 50,
        onAction: () => {
          const current = getCollectionCoverSize();
          setCollectionCoverSize(Math.max(COLLECTION_COVER_SIZE_MIN, current - coverSizeStep));
        },
      });

      result.push({
        id: 'zoom-in',
        label: I18nService.getString('label_zoom_in'),
        icon: Icons.ZoomIn,
        priority: 45,
        onAction: () => {
          const current = getCollectionCoverSize();
          setCollectionCoverSize(Math.min(COLLECTION_COVER_SIZE_MAX, current + coverSizeStep));
        },
      });
    }

    // Shuffle - for Library, Playlists, Player (after zoom buttons)
    if (isLibrary || isPlayerQueue) {
      result.push({
        id: 'shuffle',
        label: I18nService.getString('tooltip_global_shuffle') || 'Alle Titel zufällig wiedergeben',
        icon: Icons.PlayerShuffle,
        priority: 40,
        onAction: handleShuffle,
      });
    }

    // Sync - for Library
    if (isLibrary) {
      result.push({
        id: 'sync',
        label: I18nService.getString('label_sync_library'),
        icon: isSyncRunning ? Icons.Refreshing : Icons.Refresh,
        disabled: isSyncRunning,
        priority: 30,
        onAction: handleSync,
      });
    }

    // Info - for Library (right-most)
    if (isLibrary) {
      result.push({
        id: 'stats',
        label: I18nService.getString('label_library_stats'),
        icon: Icons.Info,
        priority: 10,
        onAction: handleStats,
      });
    }

    // Create - for Playlists and Podcasts
    if (isPlaylists || isPodcasts) {
      result.push({
        id: 'create',
        label: isPodcasts
          ? (I18nService.getString('tooltip_podcast_add') || 'Podcast hinzufügen')
          : (I18nService.getString('button_create_playlist') || 'Playlist erstellen'),
        icon: Icons.Add,
        priority: 8,
        onAction: handleCreate,
      });
    }

    return result;
  }, [isLibrary, isPlayerQueue, isPlaylists, isPodcasts, isSyncRunning, handleShuffle, handleStats, handleSync, handleCreate]);

  // --- Config per view ---
  const config: TopMenuBarConfig = useMemo(() => {
    if (isSettings) {
      // Settings: minimal — only navigation, no search, no zoom
      return {
        showNavigation: true,
        showSearch: false,
        showZoom: false,
        actions: [],
      };
    }

    if (isEqualizer) {
      // Equalizer: navigation only
      return {
        showNavigation: true,
        showSearch: false,
        showZoom: false,
        actions: [],
      };
    }

    if (isLibrary) {
      return {
        showNavigation: true,
        showSearch: true,
        segments,
        actions,
        showZoom: false, // Zoom is now part of actions
      };
    }

    if (isPodcasts) {
      return {
        showNavigation: true,
        showSearch: true,
        actions,
        showZoom: false,
      };
    }

    // Default (Player, Search Results, Audio CD, etc.)
    return {
      showNavigation: true,
      showSearch: true,
      actions,
      showZoom: false,
    };
  }, [isSettings, isEqualizer, isLibrary, isPodcasts, segments, actions]);

  return config;
}

/**
 * Browser viewport (scrollable content area)
 */
function BrowserViewport() {
  const viewportRef = useRef(null);
  usePersistentScroll({ viewportRef });
  return (
    <div ref={viewportRef} className={cx('browser-viewport', 'app-scrollable')}>
      <RouterSwitchComponent routes={routes.main}/>
    </div>
  );
}

/**
 * Browser — Main content area with TopMenuBar and viewport.
 */
export function Browser() {
  const config = useTopMenuBarConfig();

  return (
    <div className={cx('browser')}>
      <TopMenuBar config={config}>
        {config.showSearch && <BrowserSearch/>}
      </TopMenuBar>
      <BrowserViewport/>
    </div>
  );
}
