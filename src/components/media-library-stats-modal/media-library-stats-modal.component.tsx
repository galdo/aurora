import React from 'react';
import classNames from 'classnames/bind';
import { Modal } from 'react-bootstrap';

import { MediaAlbumDatastore, MediaTrackDatastore } from '../../datastores';
import { ModalComponent } from '../../contexts';
import { I18nService } from '../../services';

import { Icon } from '../icon/icon.component';
import { Button } from '../button/button.component';
import { Icons } from '../../constants';

import styles from './media-library-stats-modal.component.css';

const cx = classNames.bind(styles);

type MediaLibraryStatsModalProps = {
  albumsCount: number;
  playlistsCount: number;
};

type MediaLibraryStats = {
  tracksCount: number;
  totalDurationSeconds: number;
  playedTracksCount: number;
  playedDurationSeconds: number;
  topSongs: Array<{ name: string; plays: number }>;
  topAlbums: Array<{ name: string; plays: number }>;
};

function formatDurationHHMM(durationSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(Number(durationSeconds || 0)));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function compactLabel(value: string, maxLength = 28): string {
  const normalizedValue = String(value || '').trim();
  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }
  return `${normalizedValue.slice(0, maxLength - 1)}…`;
}

export const MediaLibraryStatsModal: ModalComponent<MediaLibraryStatsModalProps> = (props) => {
  const {
    albumsCount,
    playlistsCount,
    onComplete,
  } = props;

  const [isLoading, setIsLoading] = React.useState(true);
  const [toplistPage, setToplistPage] = React.useState(0);
  const toplistSwipeStartXRef = React.useRef<number | null>(null);
  const [stats, setStats] = React.useState<MediaLibraryStats>({
    tracksCount: 0,
    totalDurationSeconds: 0,
    playedTracksCount: 0,
    playedDurationSeconds: 0,
    topSongs: [],
    topAlbums: [],
  });

  React.useEffect(() => {
    let isSubscribed = true;
    setIsLoading(true);

    MediaTrackDatastore.findMediaTracks({})
      .then(async (tracks) => {
        if (!isSubscribed) {
          return;
        }
        const albums = await MediaAlbumDatastore.findMediaAlbums({});
        const albumNameById = albums.reduce((result, album) => {
          result.set(album.id, String(album.album_name || '').trim());
          return result;
        }, new Map<string, string>());

        const nextTracksCount = tracks.length;
        const nextTotalDurationSeconds = tracks.reduce((result, track) => result + Number(track.track_duration || 0), 0);
        const nextPlayedTracksCount = tracks.filter((track) => {
          const playCount = Number((track.extra as any)?.play_count || 0);
          return playCount > 0;
        }).length;
        const nextPlayedDurationSeconds = tracks.reduce((result, track) => {
          const playCount = Number((track.extra as any)?.play_count || 0);
          const trackDuration = Number(track.track_duration || 0);
          if (playCount <= 0 || trackDuration <= 0) {
            return result;
          }
          return result + (playCount * trackDuration);
        }, 0);
        const nextTopSongs = tracks
          .map(track => ({
            name: String(track.track_name || '').trim(),
            plays: Number((track.extra as any)?.play_count || 0),
          }))
          .filter(track => track.name && track.plays > 0)
          .sort((trackA, trackB) => {
            if (trackB.plays !== trackA.plays) {
              return trackB.plays - trackA.plays;
            }
            return trackA.name.localeCompare(trackB.name, undefined, {
              sensitivity: 'base',
            });
          })
          .slice(0, 12);
        const albumPlayCountByName = tracks.reduce((result, track) => {
          const albumName = String(albumNameById.get(String(track.track_album_id || '')) || '').trim();
          const playCount = Number((track.extra as any)?.play_count || 0);
          if (!albumName || playCount <= 0) {
            return result;
          }
          result.set(albumName, (result.get(albumName) || 0) + playCount);
          return result;
        }, new Map<string, number>());
        const nextTopAlbums = Array.from(albumPlayCountByName.entries())
          .map(([name, plays]) => ({
            name,
            plays,
          }))
          .sort((albumA, albumB) => {
            if (albumB.plays !== albumA.plays) {
              return albumB.plays - albumA.plays;
            }
            return albumA.name.localeCompare(albumB.name, undefined, {
              sensitivity: 'base',
            });
          })
          .slice(0, 12);

        setStats({
          tracksCount: nextTracksCount,
          totalDurationSeconds: nextTotalDurationSeconds,
          playedTracksCount: nextPlayedTracksCount,
          playedDurationSeconds: nextPlayedDurationSeconds,
          topSongs: nextTopSongs,
          topAlbums: nextTopAlbums,
        });
      })
      .finally(() => {
        if (isSubscribed) {
          setIsLoading(false);
        }
      });

    return () => {
      isSubscribed = false;
    };
  }, []);

  const toplistPageSize = 5;
  const topSongsPage = stats.topSongs.slice(0, toplistPageSize);
  const topAlbumsPage = stats.topAlbums.slice(0, toplistPageSize);
  const toplistPages = [
    {
      key: 'songs',
      title: I18nService.getString('label_dashboard_top_songs'),
      items: topSongsPage,
    },
    {
      key: 'albums',
      title: I18nService.getString('label_dashboard_top_albums'),
      items: topAlbumsPage,
    },
  ] as const;
  const totalToplistPages = toplistPages.length;
  const normalizedToplistPage = Math.min(toplistPage, totalToplistPages - 1);
  const currentToplistPage = toplistPages[normalizedToplistPage];

  React.useEffect(() => {
    setToplistPage(currentPage => Math.min(currentPage, totalToplistPages - 1));
  }, [totalToplistPages]);

  const setNextToplistPage = React.useCallback(() => {
    setToplistPage(currentPage => (currentPage + 1) % totalToplistPages);
  }, [totalToplistPages]);

  const setPreviousToplistPage = React.useCallback(() => {
    setToplistPage(currentPage => (currentPage - 1 + totalToplistPages) % totalToplistPages);
  }, [totalToplistPages]);

  const onToplistPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    toplistSwipeStartXRef.current = event.clientX;
  }, []);

  const onToplistPointerUp = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (toplistSwipeStartXRef.current === null || totalToplistPages <= 1) {
      toplistSwipeStartXRef.current = null;
      return;
    }
    const deltaX = event.clientX - toplistSwipeStartXRef.current;
    toplistSwipeStartXRef.current = null;
    if (deltaX >= 40) {
      setPreviousToplistPage();
      return;
    }
    if (deltaX <= -40) {
      setNextToplistPage();
    }
  }, [setNextToplistPage, setPreviousToplistPage, totalToplistPages]);

  return (
    <>
      <Modal.Header className={cx('library-stats-header')}>
        <div className={cx('library-stats-header-copy')}>
          <Modal.Title>
            {I18nService.getString('label_dashboard_insights_title')}
          </Modal.Title>
          <div className={cx('library-stats-header-subtitle')}>
            {I18nService.getString('label_dashboard_insights_subtitle')}
          </div>
        </div>
        <Button
          variant={['rounded', 'outline']}
          className={cx('library-stats-close-button')}
          onButtonSubmit={() => onComplete()}
        >
          <Icon name={Icons.Close}/>
        </Button>
      </Modal.Header>
      <Modal.Body>
        <div className={cx('library-stats-modal')}>
          <div className={cx('library-stats-hero')}>
            <div className={cx('library-stats-hero-kicker')}>Aurora Pulse</div>
            <div className={cx('library-stats-hero-title')}>{I18nService.getString('label_dashboard_hero_title')}</div>
            <div className={cx('library-stats-hero-subtitle')}>
              {isLoading
                ? I18nService.getString('label_dashboard_hero_loading')
                : I18nService.getString('label_dashboard_hero_based_on_tracks', {
                  trackCount: stats.tracksCount,
                })}
            </div>
          </div>

          <div className={cx('library-stats-grid')}>
            <div className={cx('library-stats-card')}>
              <div className={cx('library-stats-card-topline')}>
                <div className={cx('library-stats-card-icon')}><Icon name={Icons.TrackPlaceholder}/></div>
                <div className={cx('library-stats-card-kicker')}>{I18nService.getString('label_dashboard_collection')}</div>
              </div>
              <div className={cx('library-stats-card-value')}>{stats.tracksCount}</div>
              <div className={cx('library-stats-card-chips')}>
                <div className={cx('library-stats-chip')}>
                  {`${formatDurationHHMM(stats.totalDurationSeconds)} ${I18nService.getString('label_dashboard_hours_suffix')}`}
                </div>
              </div>
            </div>

            <div className={cx('library-stats-card')}>
              <div className={cx('library-stats-card-topline')}>
                <div className={cx('library-stats-card-icon')}><Icon name={Icons.PlaylistPlaceholder}/></div>
                <div className={cx('library-stats-card-kicker')}>{I18nService.getString('label_dashboard_catalog')}</div>
              </div>
              <div className={cx('library-stats-card-value')}>{playlistsCount}</div>
              <div className={cx('library-stats-card-chips')}>
                <div className={cx('library-stats-chip')}>
                  {I18nService.getString('label_dashboard_albums_count', { count: albumsCount })}
                </div>
              </div>
            </div>

            <div className={cx('library-stats-card', 'library-stats-card-wide')}>
              <div className={cx('library-stats-card-topline')}>
                <div className={cx('library-stats-card-icon')}><Icon name={Icons.Completed}/></div>
                <div className={cx('library-stats-card-kicker')}>{I18nService.getString('label_dashboard_listened')}</div>
              </div>
              <div className={cx('library-stats-card-value')}>{stats.playedTracksCount}</div>
              <div className={cx('library-stats-card-chips')}>
                <div className={cx('library-stats-chip')}>
                  {`${formatDurationHHMM(stats.playedDurationSeconds)} ${I18nService.getString('label_dashboard_hours_suffix')}`}
                </div>
              </div>
            </div>

            <div
              className={cx('library-stats-card', 'library-stats-card-toplist')}
              onPointerDown={onToplistPointerDown}
              onPointerUp={onToplistPointerUp}
            >
              <div className={cx('library-stats-card-topline')}>
                <div className={cx('library-stats-card-icon')}><Icon name={Icons.TrackPlaceholder}/></div>
                <div className={cx('library-stats-card-kicker')}>{I18nService.getString('label_dashboard_top')}</div>
              </div>
              <div className={cx('library-stats-toplist-navigation')}>
                <button
                  type="button"
                  className={cx('library-stats-toplist-nav-button')}
                  onClick={setPreviousToplistPage}
                  aria-label={I18nService.getString('tooltip_dashboard_prev_page')}
                >
                  <Icon name={Icons.NavigationBack}/>
                </button>
                <div className={cx('library-stats-toplist-page-indicator')}>
                  {Array.from({ length: totalToplistPages }, (_value, pageIndex) => pageIndex + 1).map(pageNumber => (
                    <button
                      key={`toplist-page-${pageNumber}`}
                      type="button"
                      className={cx('library-stats-toplist-page-dot', {
                        active: (pageNumber - 1) === normalizedToplistPage,
                      })}
                      onClick={() => setToplistPage(pageNumber - 1)}
                      aria-label={I18nService.getString('label_dashboard_top_page_aria', { pageNumber })}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  className={cx('library-stats-toplist-nav-button')}
                  onClick={setNextToplistPage}
                  aria-label={I18nService.getString('tooltip_dashboard_next_page')}
                >
                  <Icon name={Icons.NavigationForward}/>
                </button>
              </div>
              <div className={cx('library-stats-toplist-layout')}>
                <div>
                  <div className={cx('library-stats-toplist-title')}>{currentToplistPage.title}</div>
                  <div className={cx('library-stats-toplist-items')}>
                    {currentToplistPage.items.length === 0 && (
                      <div className={cx('library-stats-toplist-item-empty')}>
                        {I18nService.getString('label_dashboard_no_plays')}
                      </div>
                    )}
                    {currentToplistPage.items.map((item, itemIndex) => (
                      <div key={`${currentToplistPage.key}-${item.name}`} className={cx('library-stats-toplist-item')}>
                        <span>{`${itemIndex + 1}. ${compactLabel(item.name)}`}</span>
                        <strong>{item.plays}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button onButtonSubmit={() => onComplete()}>
          {I18nService.getString('button_dialog_confirm')}
        </Button>
      </Modal.Footer>
    </>
  );
};
