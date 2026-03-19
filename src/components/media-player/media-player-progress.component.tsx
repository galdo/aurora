import React, { useCallback, useEffect, useState } from 'react';
import { Col, Row } from 'react-bootstrap';
import classNames from 'classnames/bind';
import { useSelector } from 'react-redux';

import { MediaUtils } from '../../utils';
import { MediaEnums } from '../../enums';
import { RootState } from '../../reducers';
import { MediaPlayerService, PodcastService } from '../../services';

import { Slider } from '../slider/slider.component';

import styles from './media-player.component.css';

const cx = classNames.bind(styles);

export function MediaPlayerProgress() {
  const {
    mediaPlaybackState,
    mediaPlaybackCurrentMediaTrack,
    mediaPlaybackCurrentMediaProgress,
    mediaPlaybackPreparationStatus,
  } = useSelector((state: RootState) => state.mediaPlayer);
  const [podcastPlaybackSnapshot, setPodcastPlaybackSnapshot] = useState(() => PodcastService.getPlaybackSnapshot());
  const isPodcastMode = podcastPlaybackSnapshot.isActive && !mediaPlaybackCurrentMediaTrack;

  const [mediaProgressDragValue, setMediaProgressDragValue] = useState<number | undefined>(undefined);

  const handleProgressDragUpdate = useCallback((value: number) => {
    setMediaProgressDragValue(value);
    // we don't want updated value to be committed
    return false;
  }, [
    setMediaProgressDragValue,
  ]);

  const handleProgressDragCommit = useCallback((value: number) => {
    if (isPodcastMode) {
      PodcastService.seekPlayback(value);
    } else {
      MediaPlayerService.seekMediaTrack(value);
    }
    setMediaProgressDragValue(undefined);
  }, [
    isPodcastMode,
    setMediaProgressDragValue,
  ]);

  useEffect(() => {
    const unsubscribePlayback = PodcastService.subscribePlayback(() => {
      setPodcastPlaybackSnapshot(PodcastService.getPlaybackSnapshot());
    });
    setPodcastPlaybackSnapshot(PodcastService.getPlaybackSnapshot());
    return () => {
      unsubscribePlayback();
    };
  }, []);

  const preparationProgress = Math.max(0, Math.min(100, mediaPlaybackPreparationStatus?.progress || 0));
  const isPreparingPlayback = !isPodcastMode && !!mediaPlaybackPreparationStatus;
  const mediaProgressValue = isPodcastMode
    ? podcastPlaybackSnapshot.currentTime
    : (mediaPlaybackCurrentMediaProgress || 0);
  const mediaDurationValue = isPodcastMode
    ? podcastPlaybackSnapshot.duration
    : (mediaPlaybackCurrentMediaTrack?.track_duration || 0);
  const dragOrProgressValue = mediaProgressDragValue !== undefined
    ? mediaProgressDragValue
    : mediaProgressValue;
  const startCounter = isPreparingPlayback
    ? `${mediaPlaybackPreparationStatus?.phase === 'converting' ? 'Converting' : 'Preparing'} ${preparationProgress}%`
    : MediaUtils.formatMediaTrackDuration(dragOrProgressValue);
  const endCounter = isPreparingPlayback
    ? '100%'
    : MediaUtils.formatMediaTrackDuration(mediaDurationValue);
  const sliderValue = isPreparingPlayback
    ? preparationProgress
    : mediaProgressValue;
  const sliderMaxValue = isPreparingPlayback
    ? 100
    : Math.max(1, mediaDurationValue);

  return (
    <Row className={cx('media-player-progress-container')}>
      <Col className={cx('col-12', 'media-player-progress-column')}>
        <div className={cx('media-player-progress-counter', 'start')}>
          {startCounter}
        </div>
        <div className={cx('media-player-progress-bar-container')}>
          <Slider
            disabled={
              ((!isPodcastMode && !mediaPlaybackCurrentMediaTrack) || isPreparingPlayback || mediaPlaybackState === MediaEnums.MediaPlaybackState.Loading)
            }
            value={sliderValue}
            maxValue={sliderMaxValue}
            onDragUpdate={handleProgressDragUpdate}
            onDragCommit={handleProgressDragCommit}
          />
        </div>
        <div className={cx('media-player-progress-counter', 'end')}>
          {endCounter}
        </div>
      </Col>
    </Row>
  );
}
