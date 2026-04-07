import React, { useCallback, useEffect, useState } from 'react';
import { Col, Row } from 'react-bootstrap';
import classNames from 'classnames/bind';
import { useSelector } from 'react-redux';

import { MediaUtils } from '../../utils';
import { MediaEnums } from '../../enums';
import { RootState } from '../../reducers';
import { DlnaService, MediaPlayerService, PodcastService } from '../../services';

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
  const [dlnaState, setDlnaState] = useState(() => DlnaService.getState());
  const isPodcastMode = podcastPlaybackSnapshot.isActive && !mediaPlaybackCurrentMediaTrack;
  const isRemotePlaybackWithoutTrack = !isPodcastMode
    && !mediaPlaybackCurrentMediaTrack
    && dlnaState.outputMode === 'remote'
    && !!dlnaState.selectedRendererId;

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

  useEffect(() => {
    const unsubscribeDlna = DlnaService.subscribe((state) => {
      setDlnaState(state);
    });
    setDlnaState(DlnaService.getState());
    return () => {
      unsubscribeDlna();
    };
  }, []);

  const preparationProgress = Math.max(0, Math.min(100, mediaPlaybackPreparationStatus?.progress || 0));
  const isPreparingPlayback = !isPodcastMode && !!mediaPlaybackPreparationStatus;
  const mediaProgressValue = isPodcastMode
    ? podcastPlaybackSnapshot.currentTime
    : (mediaPlaybackCurrentMediaProgress || 0);
  let mediaDurationValue = mediaPlaybackCurrentMediaTrack?.track_duration || 0;
  if (isPodcastMode) {
    mediaDurationValue = podcastPlaybackSnapshot.duration;
  } else if (isRemotePlaybackWithoutTrack) {
    mediaDurationValue = Math.max(1, mediaProgressValue + 1);
  }
  const dragOrProgressValue = mediaProgressDragValue !== undefined
    ? mediaProgressDragValue
    : mediaProgressValue;
  let startCounter = MediaUtils.formatMediaTrackDuration(dragOrProgressValue);
  if (isPreparingPlayback) {
    const preparationLabel = mediaPlaybackPreparationStatus?.phase === 'converting' ? 'Converting' : 'Preparing';
    startCounter = `${preparationLabel} ${preparationProgress}%`;
  }
  let endCounter = MediaUtils.formatMediaTrackDuration(mediaDurationValue);
  if (isPreparingPlayback) {
    endCounter = '100%';
  } else if (isRemotePlaybackWithoutTrack) {
    endCounter = 'LIVE';
  }
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
              ((!isPodcastMode && !mediaPlaybackCurrentMediaTrack && !isRemotePlaybackWithoutTrack) || isPreparingPlayback || mediaPlaybackState === MediaEnums.MediaPlaybackState.Loading)
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
