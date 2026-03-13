import React, { useCallback, useRef, useState } from 'react';
import { Row } from 'react-bootstrap';
import { useSelector } from 'react-redux';
import classNames from 'classnames/bind';

import { Icons, Routes } from '../../constants';
import { RootState } from '../../reducers';
import { MediaPlayerService } from '../../services';
import { I18nService } from '../../services/i18n.service';

import { Icon } from '../icon/icon.component';
import { Button } from '../button/button.component';
import { RouterLinkToggle } from '../router-link-toggle/router-link-toggle.component';
import { Slider } from '../slider/slider.component';
import { MediaTrackLikeButton } from '../media-track-like-button/media-track-like-button.component';

import styles from './media-player.component.css';

const cx = classNames.bind(styles);

export function MediaPlayerSide() {
  const {
    mediaPlaybackCurrentPlayingInstance,
    mediaPlaybackCurrentMediaTrack,
    mediaPlaybackVolumeCurrent,
    mediaPlaybackVolumeMaxLimit,
    mediaPlaybackVolumeMuted,
  } = useSelector((state: RootState) => state.mediaPlayer);

  const mediaPlaybackVolumeMidThreshold = useRef<number>(mediaPlaybackVolumeMaxLimit / 2);

  // TODO: Add implementation for setMediaVolumeDragStartValue
  const [mediaVolumeDragStartValue] = useState<number | undefined>(undefined);

  const handleVolumeChangeDragCommit = useCallback((value: number) => {
    MediaPlayerService.changeMediaPlayerVolume(value);
  }, []);

  const handleVolumeButtonSubmit = useCallback(() => {
    // in case the drag brought down the volume all the way to 0, we will try to raise the volume to either:
    // (a) maximum value from where the first drag started originally started, or
    // (b) maximum volume
    // otherwise in case we already have a volume > 0, simply unmute
    if (mediaPlaybackVolumeCurrent === 0) {
      MediaPlayerService.changeMediaPlayerVolume(mediaVolumeDragStartValue || mediaPlaybackVolumeMaxLimit);
    } else if (!mediaPlaybackVolumeMuted) {
      MediaPlayerService.muteMediaPlayerVolume();
    } else {
      MediaPlayerService.unmuteMediaPlayerVolume();
    }
  }, [
    mediaVolumeDragStartValue,
    mediaPlaybackVolumeCurrent,
    mediaPlaybackVolumeMaxLimit,
    mediaPlaybackVolumeMuted,
  ]);

  let mediaVolumeButtonIcon;
  if (!mediaPlaybackVolumeMuted && mediaPlaybackVolumeCurrent !== 0) {
    if (mediaPlaybackVolumeCurrent >= mediaPlaybackVolumeMidThreshold.current) {
      mediaVolumeButtonIcon = Icons.PlayerVolume1;
    } else {
      mediaVolumeButtonIcon = Icons.PlayerVolume2;
    }
  } else {
    mediaVolumeButtonIcon = Icons.PlayerVolumeMuted;
  }

  if (!mediaPlaybackCurrentPlayingInstance) {
    return (<></>);
  }

  const getAudioDetailsLabel = (mediaTrack: any): string => {
    const format = (mediaTrack?.format || {}) as {
      sampleRate?: number;
      bitsPerSample?: number;
      bitrate?: number;
      container?: string;
    };
    const extra = (mediaTrack?.extra || {}) as {
      file_path?: string;
      audio_sample_rate_hz?: number;
      audio_bit_depth?: number;
      audio_bitrate_kbps?: number;
      audio_file_type?: string;
    };

    const sampleRateHz = Number(extra.audio_sample_rate_hz || format.sampleRate);
    const bitDepth = Number(extra.audio_bit_depth || format.bitsPerSample);
    const bitrateKbps = Number(extra.audio_bitrate_kbps || (format.bitrate ? Math.round(format.bitrate / 1000) : 0));
    const fileType = String(
      extra.audio_file_type
      || format.container
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
      return I18nService.getString('label_player_audio_details_unavailable');
    }

    return details.join(' • ');
  };
  const audioDetailsLabel = mediaPlaybackCurrentMediaTrack
    ? getAudioDetailsLabel(mediaPlaybackCurrentMediaTrack)
    : '';

  return (
    <Row className={cx('media-player-side-container')}>
      <div className={cx('media-player-side-controls-column')}>
        <div className={cx('media-player-side-controls-row')}>
          {mediaPlaybackCurrentMediaTrack && (
            <MediaTrackLikeButton
              mediaTrack={mediaPlaybackCurrentMediaTrack}
              className={cx('media-player-control', 'media-player-control-sm', 'media-player-toggle', 'media-player-like-button')}
            />
          )}
          <RouterLinkToggle
            to={Routes.PlayerQueue}
            activeClassName={cx('active')}
            className={cx('media-player-control', 'media-player-control-sm', 'media-player-toggle', 'app-nav-link')}
          >
            <Icon name={Icons.PlayerQueue}/>
          </RouterLinkToggle>
          <Button
            className={cx('media-player-control', 'media-player-control-sm', 'media-player-volume-button')}
            onButtonSubmit={handleVolumeButtonSubmit}
          >
            <Icon name={mediaVolumeButtonIcon}/>
          </Button>
          <div className={cx('media-player-volume-bar-container')}>
            <Slider
              autoCommitOnUpdate
              value={mediaPlaybackVolumeMuted
                ? 0
                : mediaPlaybackVolumeCurrent}
              maxValue={mediaPlaybackVolumeMaxLimit}
              onDragCommit={handleVolumeChangeDragCommit}
            />
          </div>
        </div>
        {!!audioDetailsLabel && (
          <div className={cx('media-player-side-audio-details')}>
            {audioDetailsLabel}
          </div>
        )}
      </div>
    </Row>
  );
}
