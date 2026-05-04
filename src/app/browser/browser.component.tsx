import React, {
  useCallback,
  useEffect,
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
  BrowserNavigation,
  Button,
  Icon,
  MediaLibraryStatsModal,
  MediaPlaylistWizardModal,
  MediaPodcastSubscribeModal,
  TextInput,
  RouterSwitchComponent,
} from '../../components';
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

import styles from './browser.component.css';

const cx = classNames.bind(styles);
const TopBarSearchMinQueryLength = 3;
const TopBarSearchResultLimit = 8;
const TopBarSearchDebounceMs = 150;
const TopBarSearchStateKey = 'aurora:topbar-search-query';
const TopBarSearchChangeEvent = 'aurora:topbar-search-changed';

function getWindowsControlsSafeWidth() {
  // Windows title bar buttons have a base width of ~138px at 96 DPI (1x scale).
  // They scale proportionally with the display scale factor.
  const scaleFactor = Math.max(1, Number(window.devicePixelRatio || 1));
  const baseControlsWidth = 138;
  const safetyMargin = 16;
  return Math.ceil(baseControlsWidth * scaleFactor) + safetyMargin;
}

function getWindowsControlsSafeHeight() {
  // Windows title bar height scales with DPI. Base ~54px at 1x.
  const scaleFactor = Math.max(1, Number(window.devicePixelRatio || 1));
  const baseHeight = 54;
  const minHeight = 62;
  return Math.max(minHeight, Math.ceil(baseHeight * scaleFactor));
}

function BrowserLinks() {
  return (
    <RouterSwitchComponent routes={routes.header}/>
  );
}

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
    history.push(StringUtils.buildRoute(Routes.Search, {}, {
      q: searchQuery,
    }));
  }, [history]);

  useEffect(() => {
    if (!canSearch) {
      setResults([]);
      setIsLoading(false);
      return () => {};
    }

    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    setIsLoading(true);
    setIsOpen(true);

    const timeoutId = window.setTimeout(() => {
      MediaTrackService.searchTracksByQuery(trimmedQuery, TopBarSearchResultLimit)
        .then((tracks) => {
          if (searchRequestRef.current === requestId) {
            setResults(tracks);
          }
        })
        .finally(() => {
          if (searchRequestRef.current === requestId) {
            setIsLoading(false);
          }
        });
    }, TopBarSearchDebounceMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    canSearch,
    trimmedQuery,
  ]);

  useEffect(() => {
    if (isSettingsPage) {
      setIsOpen(false);
      return;
    }

    const queryToBroadcast = canSearch ? trimmedQuery : '';
    localStorage.setItem(TopBarSearchStateKey, queryToBroadcast);
    window.dispatchEvent(new CustomEvent(TopBarSearchChangeEvent, {
      detail: {
        query: queryToBroadcast,
      },
    }));
  }, [
    canSearch,
    isSettingsPage,
    trimmedQuery,
  ]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  useEffect(() => {
    setIsOpen(false);
  }, [
    location.pathname,
    location.search,
  ]);

  if (isSettingsPage) {
    return null;
  }

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
          if (event.key === 'Escape') {
            setIsOpen(false);
            return;
          }

          if (event.key === 'Enter' && canSearch) {
            submitSearchRoute(trimmedQuery);
            setIsOpen(false);
          }
        }}
      />
      {isOpen && canSearch && (
        <div className={cx('browser-search-results')}>
          {isLoading && (
            <div className={cx('browser-search-status')}>
              ...
            </div>
          )}
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
                history.push(StringUtils.buildRoute(Routes.LibraryAlbum, {
                  albumId: track.track_album.id,
                }));
                setIsOpen(false);
              }}
            >
              <span className={cx('browser-search-result-title')}>
                {track.track_name}
              </span>
              <span className={cx('browser-search-result-meta')}>
                {track.track_artists.map(artist => artist.artist_name).join(', ')}
                {' • '}
                {track.track_album.album_name}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function BrowserHeader() {
  const mediaAlbumsCount = useSelector((state: RootState) => state.mediaLibrary.mediaAlbums.length);
  const mediaPlaylistsCount = useSelector((state: RootState) => state.mediaLibrary.mediaPlaylists.length);
  const currentTrackId = useSelector((state: RootState) => state.mediaPlayer.mediaPlaybackCurrentMediaTrack?.id);
  const [isSyncRunning, setIsSyncRunning] = useState(false);
  const [windowsControlsSafeWidth, setWindowsControlsSafeWidth] = useState(getWindowsControlsSafeWidth());
  const [windowsControlsSafeHeight, setWindowsControlsSafeHeight] = useState(getWindowsControlsSafeHeight());
  const history = useHistory();
  const location = useLocation();
  const { showModal } = useModal();
  const isWindows = AppService.details.platform === PlatformOS.Windows;
  const isPlaylistModule = location.pathname.startsWith(Routes.LibraryPlaylists);
  const isPodcastModule = location.pathname.startsWith(Routes.Podcasts);
  const shouldShowCreateButton = isPlaylistModule || isPodcastModule;

  useEffect(() => {
    if (!isWindows) {
      return () => {};
    }

    const updateWindowsControlsSafeWidth = () => {
      setWindowsControlsSafeWidth(getWindowsControlsSafeWidth());
      setWindowsControlsSafeHeight(getWindowsControlsSafeHeight());
    };

    updateWindowsControlsSafeWidth();
    window.addEventListener('resize', updateWindowsControlsSafeWidth);

    return () => {
      window.removeEventListener('resize', updateWindowsControlsSafeWidth);
    };
  }, [isWindows]);

  return (
    <div
      className={cx('browser-header', 'app-window-drag', {
        'browser-header-windows': isWindows,
      })}
      style={isWindows
        ? {
          '--windows-controls-safe-width': `${windowsControlsSafeWidth}px`,
          '--windows-controls-safe-height': `${windowsControlsSafeHeight}px`,
        } as React.CSSProperties
        : undefined}
    >
      <BrowserNavigation/>
      <BrowserSearch/>
      <BrowserLinks/>
      <div
        className={cx('browser-header-actions', {
          'browser-header-actions-windows': isWindows,
        })}
      >
        <div id="browser-header-context-actions" className={cx('browser-header-context-actions')}/>
        <div id="browser-header-inline-controls" className={cx('browser-header-inline-controls')}/>
        {shouldShowCreateButton && (
          <Button
            variant={['rounded', 'outline']}
            tooltip={isPodcastModule
              ? I18nService.getString('tooltip_podcast_add')
              : I18nService.getString('button_create_playlist')}
            onButtonSubmit={() => {
              if (isPodcastModule) {
                showModal(MediaPodcastSubscribeModal, {}, {
                  dialogClassName: 'podcast-discover-modal-dialog',
                  backdropClassName: 'podcast-discover-modal-backdrop',
                });
                return;
              }

              showModal(MediaPlaylistWizardModal, {}, {
                onComplete: (result) => {
                  if (!result?.createdPlaylist) {
                    return;
                  }

                  history.push(StringUtils.buildRoute(Routes.LibraryPlaylist, {
                    playlistId: result.createdPlaylist.id,
                  }));
                },
              });
            }}
          >
            <Icon name={Icons.Add}/>
          </Button>
        )}
        <Button
          variant={['rounded', 'outline']}
          tooltip={I18nService.getString('tooltip_global_shuffle') || 'Alle Titel zufällig wiedergeben'}
          onButtonSubmit={async () => {
            const trackDataList = await MediaTrackDatastore.findMediaTracks({});
            const tracks = await MediaTrackService.buildMediaTracks(trackDataList);
            if (tracks && tracks.length > 0) {
              const shuffledTracks = _.shuffle(tracks);
              if (currentTrackId && shuffledTracks.length > 1 && shuffledTracks[0].id === currentTrackId) {
                const replacementTrackPointer = shuffledTracks.findIndex(mediaTrack => mediaTrack.id !== currentTrackId);
                if (replacementTrackPointer > 0) {
                  [shuffledTracks[0], shuffledTracks[replacementTrackPointer]] = [
                    shuffledTracks[replacementTrackPointer],
                    shuffledTracks[0],
                  ];
                }
              }
              MediaPlayerService.playMediaTracks(shuffledTracks);
            }
          }}
        >
          <Icon name={Icons.PlayerShuffle}/>
        </Button>
        <Button
          variant={['rounded', 'outline']}
          tooltip="Lokale Bibliotheksstatistiken anzeigen"
          onButtonSubmit={() => {
            showModal(MediaLibraryStatsModal, {
              albumsCount: mediaAlbumsCount,
              playlistsCount: mediaPlaylistsCount,
            }, {
              dialogClassName: 'library-stats-modal-dialog',
            });
          }}
        >
          <Icon name={Icons.Info}/>
        </Button>
        <Button
          variant={['rounded', 'outline']}
          tooltip="Bibliothek und DAP synchronisieren"
          disabled={isSyncRunning}
          onButtonSubmit={() => {
            if (isSyncRunning) {
              return;
            }

            setIsSyncRunning(true);
            MediaLocalLibraryService.syncMediaTracks()
              .then(async () => {
                const dapSettings = MediaLibraryService.getDapSyncSettings();
                if (dapSettings.transport === 'filesystem' && !dapSettings.targetDirectory) {
                  return;
                }

                await MediaLibraryService.syncDapLibrary({
                  targetDirectory: dapSettings.targetDirectory,
                  deleteMissingOnDevice: dapSettings.deleteMissingOnDevice,
                  transport: dapSettings.transport,
                });
              })
              .catch((error) => {
                console.error('Kombinierte Synchronisierung fehlgeschlagen', error);
              })
              .finally(() => {
                setIsSyncRunning(false);
              });
          }}
        >
          <Icon name={isSyncRunning ? Icons.Refreshing : Icons.Refresh}/>
        </Button>
      </div>
    </div>
  );
}

function BrowserViewport() {
  const viewportRef = useRef(null);
  usePersistentScroll({ viewportRef });

  return (
    <div ref={viewportRef} className={cx('browser-viewport', 'app-scrollable')}>
      <RouterSwitchComponent routes={routes.main}/>
    </div>
  );
}

export function Browser() {
  return (
    <div className={cx('browser')}>
      <BrowserHeader/>
      <BrowserViewport/>
    </div>
  );
}
