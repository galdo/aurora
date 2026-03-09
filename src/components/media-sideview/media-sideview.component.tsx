import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import classNames from 'classnames/bind';
import { isEmpty } from 'lodash';
import { useSelector } from 'react-redux';
import { Icons } from '../../constants';
import {
  IPodcastEpisode,
  IPodcastSubscription,
  IMediaAlbum,
  IMediaPlaylist,
  IMediaPlaylistTrack,
  IMediaTrack,
} from '../../interfaces';
import { RootState } from '../../reducers';
import {
  MediaAlbumService,
  MediaCollectionService,
  I18nService,
  MediaPlayerService,
  MediaPlaylistService,
  MediaTrackService,
  PodcastService,
} from '../../services';
import { Button } from '../button/button.component';
import { Icon } from '../icon/icon.component';
import { MediaCollectionActions } from '../media-collection-actions/media-collection-actions.component';
import { MediaCoverPicture } from '../media-cover-picture/media-cover-picture.component';
import { MediaTrackList } from '../media-track-list/media-track-list.component';
import styles from './media-sideview.component.css';

const cx = classNames.bind(styles);

type MediaSideViewAlbumProps = {
  albumId: string;
  onClose: () => void;
};

type MediaSideViewPlaylistProps = {
  playlistId: string;
  onClose: () => void;
};

type MediaSideViewPodcastProps = {
  podcastId: string;
  onClose: () => void;
};

function getAlbumDisplayTitle(albumName?: string, artistName?: string) {
  if (!artistName || !albumName) {
    return albumName;
  }

  const artistPrefix = `${artistName} - `;
  if (albumName.startsWith(artistPrefix)) {
    return albumName.substring(artistPrefix.length);
  }

  return albumName;
}

function toPlainText(value?: string): string {
  const input = String(value || '').trim();
  if (!input) {
    return '';
  }
  const parser = new DOMParser();
  const parsed = parser.parseFromString(input, 'text/html');
  return String(parsed.body?.textContent || '').replace(/\s+/g, ' ').trim();
}

export function MediaAlbumSideView({ albumId, onClose }: MediaSideViewAlbumProps) {
  const [loadedAlbum, setLoadedAlbum] = useState<IMediaAlbum | undefined>();
  const [tracks, setTracks] = useState<IMediaTrack[]>([]);
  const mediaAlbums = useSelector((state: RootState) => state.mediaLibrary.mediaAlbums);
  const album = mediaAlbums.find(mediaAlbum => mediaAlbum.id === albumId) || loadedAlbum;

  useEffect(() => {
    MediaAlbumService.getMediaAlbum(albumId).then(setLoadedAlbum);
    MediaTrackService.getMediaAlbumTracks(albumId).then(setTracks);

    document.body.classList.add('sideview-open');
    return () => {
      document.body.classList.remove('sideview-open');
    };
  }, [albumId]);

  if (!album) {
    return null;
  }

  const albumDisplayTitle = getAlbumDisplayTitle(album.album_name, album.album_artist?.artist_name);

  return (
    <>
      <div
        className={cx('sideview-backdrop')}
        role="button"
        tabIndex={0}
        aria-label="Sideview schließen"
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onClose();
          if (e.key === 'Escape') onClose();
        }}
      />
      <aside className={cx('sideview')}>
        <div className={cx('sideview-header')}>
          <div className={cx('sideview-title')}>
            {albumDisplayTitle}
          </div>
          <button type="button" className={cx('sideview-close')} onClick={onClose} title="Close">
            <Icon name={Icons.Close}/>
          </button>
        </div>
        <div className={cx('sideview-cover')}>
          <MediaCoverPicture
            mediaPicture={album.album_cover_picture}
            mediaPictureAltText={album.album_name}
            className={cx('sideview-cover-picture')}
          />
          <div className={cx('sideview-meta')}>
            <div className={cx('sideview-meta-title')}>{albumDisplayTitle}</div>
            <div className={cx('sideview-meta-artist')}>{album.album_artist.artist_name}</div>
            <div className={cx('sideview-meta-details')}>
              {album.album_year ? <span>{album.album_year}</span> : null}
              {album.album_year && album.album_genre ? <span> • </span> : null}
              {album.album_genre ? <span>{album.album_genre}</span> : null}
            </div>
          </div>
        </div>
        <div className={cx('sideview-actions')}>
          <MediaCollectionActions
            mediaItem={MediaCollectionService.getMediaItemFromAlbum(album)}
            hasTracks={!isEmpty(tracks)}
          />
        </div>
        {!isEmpty(tracks) && (
          <div className={cx('sideview-tracklist')}>
            <MediaTrackList
              mediaTracks={tracks}
              mediaTrackList={{ id: album.id }}
              disableCovers
              disableAlbumLinks
              variant="sideview"
            />
          </div>
        )}
      </aside>
    </>
  );
}

export function MediaPlaylistSideView({ playlistId, onClose }: MediaSideViewPlaylistProps) {
  const [playlist, setPlaylist] = useState<IMediaPlaylist | undefined>();
  const [tracks, setTracks] = useState<IMediaPlaylistTrack[]>([]);

  useEffect(() => {
    MediaPlaylistService.getMediaPlaylist(playlistId).then(setPlaylist);
    MediaPlaylistService.resolveMediaPlaylistTracks(playlistId).then(setTracks);

    document.body.classList.add('sideview-open');
    return () => {
      document.body.classList.remove('sideview-open');
    };
  }, [playlistId]);

  if (!playlist) {
    return null;
  }

  return (
    <>
      <div
        className={cx('sideview-backdrop')}
        role="button"
        tabIndex={0}
        aria-label="Sideview schließen"
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onClose();
          if (e.key === 'Escape') onClose();
        }}
      />
      <aside className={cx('sideview')}>
        <div className={cx('sideview-header')}>
          <div className={cx('sideview-title')}>
            {playlist.name}
          </div>
          <button type="button" className={cx('sideview-close')} onClick={onClose} title="Close">
            <Icon name={Icons.Close}/>
          </button>
        </div>
        <div className={cx('sideview-cover')}>
          <MediaCoverPicture
            mediaPicture={playlist.cover_picture}
            mediaPictureAltText={playlist.name}
            className={cx('sideview-cover-picture')}
          />
          <div className={cx('sideview-meta')}>
            <div className={cx('sideview-meta-title')}>{playlist.name}</div>
            <div className={cx('sideview-meta-details')}>
              {playlist.tracks.length}
              {' '}
              Tracks
            </div>
          </div>
        </div>
        {!isEmpty(tracks) && (
          <div className={cx('sideview-tracklist')}>
            <MediaTrackList
              mediaTracks={tracks}
              mediaTrackList={{ id: playlist.id }}
              getMediaTrackId={t => t.playlist_track_id}
              disableCovers
              variant="sideview"
            />
          </div>
        )}
      </aside>
    </>
  );
}

export function MediaPodcastSideView({ podcastId, onClose }: MediaSideViewPodcastProps) {
  const [subscription, setSubscription] = useState<IPodcastSubscription | undefined>();
  const [channelDescription, setChannelDescription] = useState('');
  const [podcastPlaybackSnapshot, setPodcastPlaybackSnapshot] = useState(() => PodcastService.getPlaybackSnapshot());

  useEffect(() => {
    const updateSubscription = () => {
      const current = PodcastService
        .getSubscriptions()
        .find(entry => entry.id === podcastId || entry.feedUrl === podcastId);
      setSubscription(current);
    };

    updateSubscription();
    const unsubscribe = PodcastService.subscribe(updateSubscription);
    const unsubscribePlayback = PodcastService.subscribePlayback(() => {
      setPodcastPlaybackSnapshot(PodcastService.getPlaybackSnapshot());
    });
    setPodcastPlaybackSnapshot(PodcastService.getPlaybackSnapshot());
    PodcastService.refreshSubscriptions().catch(() => undefined);

    document.body.classList.add('sideview-open');
    return () => {
      document.body.classList.remove('sideview-open');
      unsubscribe();
      unsubscribePlayback();
    };
  }, [podcastId]);

  useEffect(() => {
    if (!subscription?.feedUrl) {
      setChannelDescription('');
      return;
    }

    fetch(subscription.feedUrl)
      .then(response => (response.ok ? response.text() : ''))
      .then((xmlText) => {
        if (!xmlText) {
          setChannelDescription('');
          return;
        }
        const parser = new DOMParser();
        const documentParsed = parser.parseFromString(xmlText, 'text/xml');
        const description = documentParsed.querySelector('channel > description')?.textContent?.trim()
          || documentParsed.querySelector('channel > itunes\\:summary')?.textContent?.trim()
          || '';
        setChannelDescription(toPlainText(description));
      })
      .catch(() => setChannelDescription(''));
  }, [subscription?.feedUrl]);

  const toggleEpisodePlayback = useCallback((episode: IPodcastEpisode) => {
    if (!subscription) {
      return;
    }
    MediaPlayerService.stopMediaPlayer();
    PodcastService.toggleEpisodePlayback(subscription, episode)
      .then(() => {
        setPodcastPlaybackSnapshot(PodcastService.getPlaybackSnapshot());
      })
      .catch(() => undefined);
  }, [subscription]);

  const latestEpisodes = useMemo(
    () => (subscription?.episodes || []).slice(0, 8),
    [subscription?.episodes],
  );

  if (!subscription) {
    return null;
  }

  const resolvedDescription = channelDescription || toPlainText(latestEpisodes[0]?.description) || '-';

  return (
    <>
      <div
        className={cx('sideview-backdrop')}
        role="button"
        tabIndex={0}
        aria-label="Sideview schließen"
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onClose();
          if (e.key === 'Escape') onClose();
        }}
      />
      <aside className={cx('sideview')}>
        <div className={cx('sideview-header')}>
          <div className={cx('sideview-title')}>
            {subscription.title}
          </div>
          <button type="button" className={cx('sideview-close')} onClick={onClose} title="Close">
            <Icon name={Icons.Close}/>
          </button>
        </div>
        <div className={cx('sideview-cover')}>
          {subscription.imageUrl ? (
            <img
              src={subscription.imageUrl}
              alt={subscription.title}
              className={cx('sideview-cover-picture')}
            />
          ) : (
            <div className={cx('sideview-cover-picture', 'sideview-cover-placeholder')}>
              <Icon name={Icons.Podcast}/>
            </div>
          )}
          <div className={cx('sideview-meta')}>
            <div className={cx('sideview-meta-title')}>{subscription.title}</div>
            <div className={cx('sideview-meta-artist')}>{subscription.publisher || '-'}</div>
            <div className={cx('sideview-meta-details')}>
              {subscription.genre || 'Podcast'}
              {subscription.rating > 0 ? ` • ${subscription.rating.toFixed(1)}` : ''}
            </div>
          </div>
        </div>
        <div className={cx('sideview-description-section')}>
          <div className={cx('sideview-section-title')}>{I18nService.getString('label_podcast_sideview_description')}</div>
          <div className={cx('sideview-description-text')}>
            {resolvedDescription}
          </div>
        </div>
        <div className={cx('sideview-podcast-episodes')}>
          <div className={cx('sideview-section-title')}>{I18nService.getString('label_podcast_sideview_latest_episodes')}</div>
          {latestEpisodes.length === 0 && (
            <div className={cx('sideview-empty')}>
              {I18nService.getString('label_podcast_sideview_no_episodes')}
            </div>
          )}
          {latestEpisodes.map((episode) => {
            const dateLabel = episode.publishedAt ? new Date(episode.publishedAt).toLocaleDateString() : '';
            const summary = toPlainText(episode.description);
            const isEpisodeActive = podcastPlaybackSnapshot.episode?.id === episode.id;
            const isEpisodePlaying = isEpisodeActive && podcastPlaybackSnapshot.isPlaying;
            return (
              <div key={episode.id} className={cx('sideview-episode-item')}>
                <Button
                  className={cx('sideview-episode-play')}
                  variant={['rounded', 'outline']}
                  onButtonSubmit={() => toggleEpisodePlayback(episode)}
                >
                  <Icon name={isEpisodePlaying ? Icons.MediaPause : Icons.MediaPlay}/>
                </Button>
                <div className={cx('sideview-episode-content')}>
                  <div className={cx('sideview-episode-title')}>{episode.title}</div>
                  {dateLabel && (
                    <div className={cx('sideview-episode-date')}>{dateLabel}</div>
                  )}
                  {summary && (
                    <div className={cx('sideview-episode-description')}>{summary}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </aside>
    </>
  );
}
