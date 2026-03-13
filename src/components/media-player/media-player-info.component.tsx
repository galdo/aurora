import React, { useCallback, useEffect, useState } from 'react';
import { Col, Row } from 'react-bootstrap';
import classNames from 'classnames/bind';
import { useSelector } from 'react-redux';

import { Icons } from '../../constants';
import { useContextMenu } from '../../contexts';
import { RootState } from '../../reducers';
import { PodcastService } from '../../services';

import { MediaCoverPicture } from '../media-cover-picture/media-cover-picture.component';
import { MediaTrackInfo } from '../media-track-info/media-track-info.component';
import { MediaTrackContextMenu, MediaTrackContextMenuItem } from '../media-track-context-menu/media-track-context-menu.component';

import styles from './media-player.component.css';

const cx = classNames.bind(styles);

export function MediaPlayerInfo({ onShowAlbum }: { onShowAlbum: (albumId: string) => void }) {
  const { showMenu } = useContextMenu();
  const mediaPlaybackCurrentMediaTrack = useSelector((state: RootState) => state.mediaPlayer.mediaPlaybackCurrentMediaTrack);
  const [podcastPlaybackSnapshot, setPodcastPlaybackSnapshot] = useState(() => PodcastService.getPlaybackSnapshot());
  const mediaTrackContextMenuId = 'media_player_playing_track_context_menu';
  const getAudioDetailsLabel = (mediaTrack: any): string => {
    const format = (mediaTrack?.format || {}) as {
      sampleRate?: number;
      bitsPerSample?: number;
      bitrate?: number;
      codec?: string;
      container?: string;
    };
    const extra = (mediaTrack?.extra || {}) as {
      file_path?: string;
    };

    const sampleRateHz = Number(format.sampleRate);
    const bitDepth = Number(format.bitsPerSample);
    const bitrateKbps = format.bitrate ? Math.round(format.bitrate / 1000) : 0;
    const fileType = String(
      format.container
      || String(extra.file_path || '').split('.').pop()
      || '',
    ).trim().toLowerCase();

    const details: string[] = [];
    if (Number.isFinite(bitDepth) && bitDepth > 0) {
      details.push(`${bitDepth} Bit`);
    }
    if (Number.isFinite(sampleRateHz) && sampleRateHz > 0) {
      details.push(`${(sampleRateHz / 1000).toFixed(1).replace('.', ',')} kHz`);
    }
    if (Number.isFinite(bitrateKbps) && bitrateKbps > 0) {
      details.push(`${bitrateKbps} kbps`);
    }
    if (fileType) {
      details.push(fileType.toUpperCase());
    }

    if (details.length <= 1 && fileType) {
      return 'Detailinformationen nicht verfügbar';
    }

    return details.join(' • ');
  };

  useEffect(() => {
    const unsubscribePlayback = PodcastService.subscribePlayback(() => {
      setPodcastPlaybackSnapshot(PodcastService.getPlaybackSnapshot());
    });
    setPodcastPlaybackSnapshot(PodcastService.getPlaybackSnapshot());
    return () => {
      unsubscribePlayback();
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

  if (!mediaPlaybackCurrentMediaTrack && !podcastPlaybackSnapshot.isActive) {
    return (<></>);
  }

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
  if (!currentMediaTrack) {
    return (<></>);
  }
  const audioDetailsLabel = getAudioDetailsLabel(currentMediaTrack);

  return (
    <Row className={cx('media-player-info-container')}>
      <Col className={cx('col-12', 'media-player-info-column')}>
        <MediaCoverPicture
          mediaPicture={currentMediaTrack.track_album.album_cover_picture}
          mediaPictureAltText={currentMediaTrack.track_album.album_name}
          mediaCoverPlaceholderIcon={Icons.TrackPlaceholder}
          className={cx('media-player-track-cover-image')}
          onContextMenu={handleContextMenu}
        />
        <MediaTrackInfo
          marquee
          mediaTrack={currentMediaTrack}
          disableAlbumLink
          className={cx('media-player-track-info-container')}
          onContextMenu={handleContextMenu}
          onTitleClick={() => onShowAlbum(currentMediaTrack.track_album.id)}
        />
        {!!audioDetailsLabel && (
          <div className={cx('media-player-track-audio-details')}>
            {audioDetailsLabel}
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
