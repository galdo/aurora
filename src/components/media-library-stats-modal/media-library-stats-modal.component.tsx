import React from 'react';
import classNames from 'classnames/bind';
import { Modal } from 'react-bootstrap';

import { MediaTrackDatastore } from '../../datastores';
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
};

function formatDurationClock(durationSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(Number(durationSeconds || 0)));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatDurationHHMM(durationSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(Number(durationSeconds || 0)));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export const MediaLibraryStatsModal: ModalComponent<MediaLibraryStatsModalProps> = (props) => {
  const {
    albumsCount,
    playlistsCount,
    onComplete,
  } = props;

  const [isLoading, setIsLoading] = React.useState(true);
  const [stats, setStats] = React.useState<MediaLibraryStats>({
    tracksCount: 0,
    totalDurationSeconds: 0,
    playedTracksCount: 0,
    playedDurationSeconds: 0,
  });

  React.useEffect(() => {
    let isSubscribed = true;
    setIsLoading(true);

    MediaTrackDatastore.findMediaTracks({})
      .then((tracks) => {
        if (!isSubscribed) {
          return;
        }

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

        setStats({
          tracksCount: nextTracksCount,
          totalDurationSeconds: nextTotalDurationSeconds,
          playedTracksCount: nextPlayedTracksCount,
          playedDurationSeconds: nextPlayedDurationSeconds,
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

  return (
    <>
      <Modal.Header className={cx('library-stats-header')}>
        <div className={cx('library-stats-header-copy')}>
          <Modal.Title>
            Library Insights
          </Modal.Title>
          <div className={cx('library-stats-header-subtitle')}>
            Dashboard overview of your local music collection
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
            <div className={cx('library-stats-hero-title')}>Local Library Dashboard</div>
            <div className={cx('library-stats-hero-subtitle')}>
              {isLoading ? 'Loading current statistics…' : `Based on ${stats.tracksCount} local tracks`}
            </div>
          </div>

          <div className={cx('library-stats-grid')}>
            <div className={cx('library-stats-card')}>
              <div className={cx('library-stats-card-icon')}><Icon name={Icons.TrackPlaceholder}/></div>
              <div className={cx('library-stats-card-kicker')}>Sammlung</div>
              <div className={cx('library-stats-card-value')}>{stats.tracksCount}</div>
              <div className={cx('library-stats-card-label')}>Anzahl Titel</div>
              <div className={cx('library-stats-card-secondary')}>
                <strong>{formatDurationHHMM(stats.totalDurationSeconds)}</strong>
                {' '}
                Gesamtspielzeit (HH:MM)
              </div>
              <div className={cx('library-stats-card-detail')}>{formatDurationClock(stats.totalDurationSeconds)}</div>
            </div>

            <div className={cx('library-stats-card')}>
              <div className={cx('library-stats-card-icon')}><Icon name={Icons.PlaylistPlaceholder}/></div>
              <div className={cx('library-stats-card-kicker')}>Katalog</div>
              <div className={cx('library-stats-card-value')}>{playlistsCount}</div>
              <div className={cx('library-stats-card-label')}>Playlists</div>
              <div className={cx('library-stats-card-secondary')}>
                <strong>{albumsCount}</strong>
                {' '}
                Alben
              </div>
            </div>

            <div className={cx('library-stats-card', 'library-stats-card-wide')}>
              <div className={cx('library-stats-card-icon')}><Icon name={Icons.Completed}/></div>
              <div className={cx('library-stats-card-kicker')}>Bisher gehört</div>
              <div className={cx('library-stats-card-value')}>{stats.playedTracksCount}</div>
              <div className={cx('library-stats-card-label')}>Abgespielte Lieder</div>
              <div className={cx('library-stats-card-secondary')}>
                <strong>{formatDurationHHMM(stats.playedDurationSeconds)}</strong>
                {' '}
                Gespielte Zeit (HH:MM)
              </div>
              <div className={cx('library-stats-card-detail')}>{formatDurationClock(stats.playedDurationSeconds)}</div>
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
