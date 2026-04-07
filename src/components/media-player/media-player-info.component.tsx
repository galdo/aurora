import React, { useCallback, useEffect, useState } from 'react';
import { Col, Row } from 'react-bootstrap';
import classNames from 'classnames/bind';
import { useSelector } from 'react-redux';

import { Icons } from '../../constants';
import { useContextMenu } from '../../contexts';
import { RootState } from '../../reducers';
import { DlnaService, PodcastService } from '../../services';

import { MediaCoverPicture } from '../media-cover-picture/media-cover-picture.component';
import { MediaTrackInfo } from '../media-track-info/media-track-info.component';
import { MediaTrackContextMenu, MediaTrackContextMenuItem } from '../media-track-context-menu/media-track-context-menu.component';

import styles from './media-player.component.css';

const cx = classNames.bind(styles);

export function MediaPlayerInfo({ onShowAlbum }: { onShowAlbum: (albumId: string) => void }) {
  const { showMenu } = useContextMenu();
  const mediaPlaybackCurrentMediaTrack = useSelector((state: RootState) => state.mediaPlayer.mediaPlaybackCurrentMediaTrack);
  const mediaPlaybackState = useSelector((state: RootState) => state.mediaPlayer.mediaPlaybackState);
  const [podcastPlaybackSnapshot, setPodcastPlaybackSnapshot] = useState(() => PodcastService.getPlaybackSnapshot());
  const [dlnaState, setDlnaState] = useState(() => DlnaService.getState());
  const mediaTrackContextMenuId = 'media_player_playing_track_context_menu';

  useEffect(() => {
    const unsubscribePlayback = PodcastService.subscribePlayback(() => {
      setPodcastPlaybackSnapshot(PodcastService.getPlaybackSnapshot());
    });
    setPodcastPlaybackSnapshot(PodcastService.getPlaybackSnapshot());
    return () => {
      unsubscribePlayback();
    };
  }, []);

  useEffect(() => {
    const unsubscribeDlna = DlnaService.subscribe((state) => {
      setDlnaState(state);
    });
    setDlnaState(DlnaService.getState());
    return () => {
      unsubscribeDlna();
    };
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!mediaPlaybackCurrentMediaTrack) {
      return;
    }

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();

    showMenu({
      id: mediaTrackContextMenuId,
      event: e,
      props: {
        mediaTrack: mediaPlaybackCurrentMediaTrack,
      },
      position: {
        x: rect.left,
        y: rect.top - 155, // TODO: Hack to place menu just above element
      },
    });
  }, [
    showMenu,
    mediaPlaybackCurrentMediaTrack,
  ]);

  if (podcastPlaybackSnapshot.isActive) {
    return (
      <Row className={cx('media-player-info-container')}>
        <Col className={cx('col-12', 'media-player-info-column')}>
          {podcastPlaybackSnapshot.subscription?.imageUrl ? (
            <img
              src={podcastPlaybackSnapshot.subscription.imageUrl}
              alt={podcastPlaybackSnapshot.subscription.title}
              className={cx('media-player-track-cover-image')}
            />
          ) : (
            <MediaCoverPicture
              mediaPicture={undefined}
              mediaPictureAltText={podcastPlaybackSnapshot.subscription?.title || 'Podcast'}
              mediaCoverPlaceholderIcon={Icons.Podcast}
              className={cx('media-player-track-cover-image')}
            />
          )}
          <div className={cx('media-player-track-info-container')}>
            <div className={cx('media-player-podcast-episode')}>
              {podcastPlaybackSnapshot.episode?.title || 'Podcast'}
            </div>
            <div className={cx('media-player-podcast-show')}>
              {podcastPlaybackSnapshot.subscription?.title || '-'}
            </div>
          </div>
        </Col>
      </Row>
    );
  }

  const currentMediaTrack = mediaPlaybackCurrentMediaTrack;
  const isRemotePlaybackWithoutTrack = !currentMediaTrack
    && dlnaState.outputMode === 'remote'
    && !!dlnaState.selectedRendererId;
  const selectedRendererName = dlnaState.rendererDevices.find(renderer => renderer.id === dlnaState.selectedRendererId)?.name
    || 'Remote Renderer';
  let playbackStateLabel = 'Stopped';
  if (mediaPlaybackState === 'media/playback/playing') {
    playbackStateLabel = 'Playing';
  } else if (mediaPlaybackState === 'media/playback/loading') {
    playbackStateLabel = 'Loading';
  } else if (mediaPlaybackState === 'media/playback/paused') {
    playbackStateLabel = 'Paused';
  }
  return (
    <Row className={cx('media-player-info-container')}>
      <Col className={cx('col-12', 'media-player-info-column')}>
        <MediaCoverPicture
          mediaPicture={currentMediaTrack?.track_album?.album_cover_picture}
          mediaPictureAltText={currentMediaTrack?.track_album?.album_name || 'No track selected'}
          mediaCoverPlaceholderIcon={Icons.TrackPlaceholder}
          className={cx('media-player-track-cover-image')}
          onContextMenu={handleContextMenu}
        />
        {currentMediaTrack ? (
          <MediaTrackInfo
            marquee
            mediaTrack={currentMediaTrack}
            disableAlbumLink
            className={cx('media-player-track-info-container')}
            onContextMenu={handleContextMenu}
            onTitleClick={() => onShowAlbum(currentMediaTrack.track_album.id)}
          />
        ) : (
          <div className={cx('media-player-track-info-container')}>
            <div className={cx('media-player-podcast-episode')}>
              {isRemotePlaybackWithoutTrack ? selectedRendererName : 'No track selected'}
            </div>
            <div className={cx('media-player-podcast-show')}>
              {isRemotePlaybackWithoutTrack ? playbackStateLabel : '-'}
            </div>
          </div>
        )}
        <MediaTrackContextMenu
          id={mediaTrackContextMenuId}
          menuItems={[
            MediaTrackContextMenuItem.Like,
            MediaTrackContextMenuItem.AddToQueue,
            MediaTrackContextMenuItem.AddToPlaylist,
          ]}
        />
      </Col>
    </Row>
  );
}
