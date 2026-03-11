import React, { useEffect, useState } from 'react';
import { Col, Row } from 'react-bootstrap';
import { useSelector } from 'react-redux';
import classNames from 'classnames/bind';
import _ from 'lodash';

import { Icons } from '../../constants';
import { RootState } from '../../reducers';
import { MediaPlayerService, PodcastService } from '../../services';
import { MediaEnums } from '../../enums';
import { DOM, Events } from '../../utils';

import { Icon } from '../icon/icon.component';
import { Button } from '../button/button.component';
import { MediaPlaybackButton } from '../media-playback-button/media-playback-button.component';

import styles from './media-player.component.css';

const cx = classNames.bind(styles);

export function MediaPlayerControls() {
  const {
    mediaPlaybackState,
    mediaPlaybackQueueOnShuffle,
    mediaPlaybackQueueRepeatType,
  } = useSelector((state: RootState) => state.mediaPlayer);
  const [podcastPlaybackSnapshot, setPodcastPlaybackSnapshot] = useState(() => PodcastService.getPlaybackSnapshot());
  const isPodcastMode = podcastPlaybackSnapshot.isActive;

  const isPlaybackDisabled = mediaPlaybackState === MediaEnums.MediaPlaybackState.Loading;
  const isPlaying = isPodcastMode
    ? podcastPlaybackSnapshot.isPlaying
    : mediaPlaybackState === MediaEnums.MediaPlaybackState.Playing;

  useEffect(() => {
    const handleOnKeyDown = (event: KeyboardEvent) => {
      if (
        Events.isSpaceKey(event)
        && !DOM.isElementEditable(document.activeElement)
        && !isPlaybackDisabled
      ) {
        event.preventDefault();
        MediaPlayerService.toggleMediaPlayback();
      }
    };

    window.addEventListener('keydown', handleOnKeyDown);

    return () => {
      window.removeEventListener('keydown', handleOnKeyDown);
    };
  }, [
    isPlaybackDisabled,
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

  return (
    <Row className={cx('media-player-controls-container')}>
      <Col className={cx('col-12', 'media-player-controls-column')}>
        <Button
          className={cx('media-player-control', 'media-player-control-sm', 'media-player-toggle', {
            active: mediaPlaybackQueueOnShuffle,
          })}
          disabled={isPodcastMode}
          onButtonSubmit={() => {
            MediaPlayerService.toggleShuffle();
          }}
        >
          <Icon name={Icons.PlayerShuffle}/>
        </Button>
        <Button
          className={cx('media-player-control', 'media-player-control-md')}
          disabled={isPodcastMode}
          onButtonSubmit={() => {
            MediaPlayerService.playPreviousTrack();
          }}
        >
          <Icon name={Icons.PlayerPrevious}/>
        </Button>
        <MediaPlaybackButton
          className={cx('media-player-control', 'media-player-control-lg')}
          variant={['rounded', 'primary', 'lg']}
          isPlaying={isPlaying}
          onPlay={() => {
            if (isPodcastMode) {
              PodcastService.resumePlayback();
            } else {
              MediaPlayerService.resumeMediaPlayer();
            }
          }}
          onPause={() => {
            if (isPodcastMode) {
              PodcastService.pausePlayback();
            } else {
              MediaPlayerService.pauseMediaPlayer();
            }
          }}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          aria-disabled={isPlaybackDisabled}
        />
        <Button
          className={cx('media-player-control', 'media-player-control-md')}
          disabled={isPodcastMode || !MediaPlayerService.hasNextTrack()}
          onButtonSubmit={() => {
            MediaPlayerService.playNextTrack();
          }}
        >
          <Icon name={Icons.PlayerNext}/>
        </Button>
        <Button
          className={cx('media-player-control', 'media-player-control-sm', 'media-player-toggle', 'media-player-repeat-toggle', {
            active: !_.isNil(mediaPlaybackQueueRepeatType),
          })}
          disabled={isPodcastMode}
          onButtonSubmit={() => {
            MediaPlayerService.toggleRepeat();
          }}
        >
          <Icon name={Icons.PlayerRepeat}/>
          <span className={cx('media-player-repeat-track-indicator', {
            active: mediaPlaybackQueueRepeatType === MediaEnums.MediaPlaybackRepeatType.Track,
          })}
          >
            1
          </span>
        </Button>
      </Col>
    </Row>
  );
}
