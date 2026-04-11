import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import { MediaEnums } from '../../enums';
import { RootState } from '../../reducers';
import { MediaPlayerService, PodcastService } from '../../services';
import { IMediaTrack } from '../../interfaces';
import { IPCRenderer, IPCCommChannel, IPCRendererCommChannel } from '../../modules/ipc';

const debug = require('debug')('aurora:component:media_session');

const getSessionArtworkForMediaTrack = (mediaTrack: IMediaTrack): MediaImage | undefined => {
  const mediaTrackPicture = mediaTrack.track_cover_picture;
  if (!mediaTrackPicture) {
    return undefined;
  }

  let mediaTrackPictureBuffer: Buffer;

  switch (mediaTrackPicture?.image_data_type) {
    case MediaEnums.MediaTrackCoverPictureImageDataType.Path: {
      const image = IPCRenderer.sendSyncMessage(IPCCommChannel.FSReadFile, mediaTrackPicture.image_data);
      mediaTrackPictureBuffer = Buffer.from(image);
      break;
    }
    case MediaEnums.MediaTrackCoverPictureImageDataType.Buffer: {
      mediaTrackPictureBuffer = mediaTrackPicture.image_data;
      break;
    }
    default: {
      throw new Error(`MediaSession encountered error at getSessionArtworkForMediaTrack - Unsupported image data type - ${mediaTrackPicture.image_data_type}`);
    }
  }

  const base64Image = mediaTrackPictureBuffer.toString('base64');
  const dataUri = `data:image/png;base64,${base64Image}`;

  return {
    src: dataUri,
  };
};

export function MediaSession() {
  const mediaPlayer = useSelector((state: RootState) => state.mediaPlayer);
  const { mediaSession } = navigator;
  const [podcastPlaybackSnapshot, setPodcastPlaybackSnapshot] = useState(() => PodcastService.getPlaybackSnapshot());

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
    const messageListener = IPCRenderer.addMessageHandler(IPCRendererCommChannel.MediaHardwareControl, (
      action: 'play_pause' | 'next_track' | 'previous_track' | 'stop' | 'volume_up' | 'volume_down' | 'volume_mute',
    ) => {
      const currentPodcastPlaybackSnapshot = PodcastService.getPlaybackSnapshot();
      const isPodcastMode = currentPodcastPlaybackSnapshot.isActive && !mediaPlayer.mediaPlaybackCurrentMediaTrack;
      const volumeStep = 5;

      if (action === 'volume_up' || action === 'volume_down') {
        const direction = action === 'volume_up' ? 1 : -1;
        const nextVolume = Math.max(
          0,
          Math.min(
            mediaPlayer.mediaPlaybackVolumeMaxLimit,
            mediaPlayer.mediaPlaybackVolumeCurrent + (direction * volumeStep),
          ),
        );
        MediaPlayerService.changeMediaPlayerVolume(nextVolume);
        return;
      }

      if (action === 'volume_mute') {
        if (mediaPlayer.mediaPlaybackVolumeMuted) {
          MediaPlayerService.unmuteMediaPlayerVolume();
        } else {
          MediaPlayerService.muteMediaPlayerVolume();
        }
        return;
      }

      if (action === 'play_pause') {
        if (isPodcastMode) {
          if (currentPodcastPlaybackSnapshot.isPlaying) {
            PodcastService.pausePlayback();
          } else {
            PodcastService.resumePlayback();
          }
          return;
        }

        MediaPlayerService.toggleMediaPlayback();
        return;
      }

      if (isPodcastMode) {
        if (action === 'next_track') {
          PodcastService.seekPlayback(currentPodcastPlaybackSnapshot.currentTime + 15);
        } else if (action === 'previous_track') {
          PodcastService.seekPlayback(currentPodcastPlaybackSnapshot.currentTime - 15);
        } else if (action === 'stop') {
          PodcastService.stopPlayback();
          if (mediaSession) {
            mediaSession.playbackState = 'none';
          }
        }
        return;
      }

      if (action === 'next_track') {
        MediaPlayerService.playNextTrack();
      } else if (action === 'previous_track') {
        MediaPlayerService.playPreviousTrack(true);
      } else if (action === 'stop') {
        MediaPlayerService.stopMediaPlayer();
        if (mediaSession) {
          mediaSession.playbackState = 'none';
        }
      }
    });

    return () => {
      IPCRenderer.removeMessageHandler(IPCRendererCommChannel.MediaHardwareControl, messageListener);
    };
  }, [
    mediaSession,
    mediaPlayer.mediaPlaybackCurrentMediaTrack,
    mediaPlayer.mediaPlaybackVolumeCurrent,
    mediaPlayer.mediaPlaybackVolumeMaxLimit,
    mediaPlayer.mediaPlaybackVolumeMuted,
  ]);

  useEffect(() => {
    if (!mediaSession) {
      return;
    }

    debug('registering media action handlers');

    mediaSession.setActionHandler('play', () => {
      debug('received action - %s', 'play');
      const snapshot = PodcastService.getPlaybackSnapshot();
      if (snapshot.isActive) {
        PodcastService.resumePlayback();
      } else {
        MediaPlayerService.resumeMediaPlayer();
      }
      mediaSession.playbackState = 'playing';
    });

    mediaSession.setActionHandler('pause', () => {
      debug('received action - %s', 'pause');
      const snapshot = PodcastService.getPlaybackSnapshot();
      if (snapshot.isActive) {
        PodcastService.pausePlayback();
      } else {
        MediaPlayerService.pauseMediaPlayer();
      }
      mediaSession.playbackState = 'paused';
    });

    mediaSession.setActionHandler('stop', () => {
      debug('received action - %s', 'stop');
      const snapshot = PodcastService.getPlaybackSnapshot();
      if (snapshot.isActive) {
        PodcastService.stopPlayback();
      } else {
        MediaPlayerService.stopMediaPlayer();
      }
      mediaSession.playbackState = 'none';
    });

    mediaSession.setActionHandler('seekto', (event) => {
      debug('received action - %s, fast seek? %s, seek time - %f', 'seekto', event.fastSeek, event.seekTime);
      const snapshot = PodcastService.getPlaybackSnapshot();
      if (snapshot.isActive) {
        PodcastService.seekPlayback(event.seekTime);
      } else {
        MediaPlayerService.seekMediaTrack(event.seekTime);
      }
    });

    mediaSession.setActionHandler('seekbackward', (event) => {
      debug('received action - %s, seek offset - %f', 'seekbackward', event.seekOffset);
      const snapshot = PodcastService.getPlaybackSnapshot();
      const seekOffset = Number(event.seekOffset || 10);
      if (snapshot.isActive) {
        PodcastService.seekPlayback(snapshot.currentTime - seekOffset);
      } else {
        const currentProgress = Number(mediaPlayer.mediaPlaybackCurrentMediaProgress || 0);
        MediaPlayerService.seekMediaTrack(currentProgress - seekOffset);
      }
    });

    mediaSession.setActionHandler('seekforward', (event) => {
      debug('received action - %s, seek offset - %f', 'seekforward', event.seekOffset);
      const snapshot = PodcastService.getPlaybackSnapshot();
      const seekOffset = Number(event.seekOffset || 10);
      if (snapshot.isActive) {
        PodcastService.seekPlayback(snapshot.currentTime + seekOffset);
      } else {
        const currentProgress = Number(mediaPlayer.mediaPlaybackCurrentMediaProgress || 0);
        MediaPlayerService.seekMediaTrack(currentProgress + seekOffset);
      }
    });

    mediaSession.setActionHandler('previoustrack', () => {
      debug('received action - %s', 'previoustrack');
      const snapshot = PodcastService.getPlaybackSnapshot();
      if (snapshot.isActive) {
        PodcastService.seekPlayback(snapshot.currentTime - 15);
      } else {
        MediaPlayerService.playPreviousTrack();
      }
    });

    mediaSession.setActionHandler('nexttrack', () => {
      debug('received action - %s', 'nexttrack');
      const snapshot = PodcastService.getPlaybackSnapshot();
      if (snapshot.isActive) {
        PodcastService.seekPlayback(snapshot.currentTime + 15);
      } else {
        MediaPlayerService.playNextTrack();
      }
    });
  }, [
    mediaSession,
    mediaPlayer.mediaPlaybackCurrentMediaProgress,
  ]);

  useEffect(() => {
    if (!mediaSession) {
      return;
    }

    if (podcastPlaybackSnapshot.isActive) {
      const artwork = podcastPlaybackSnapshot.subscription?.imageUrl
        ? [{ src: podcastPlaybackSnapshot.subscription.imageUrl }]
        : undefined;
      mediaSession.metadata = new MediaMetadata({
        title: podcastPlaybackSnapshot.episode?.title || 'Podcast',
        artist: podcastPlaybackSnapshot.subscription?.publisher || '',
        album: podcastPlaybackSnapshot.subscription?.title || 'Podcast',
        artwork,
      });
      return;
    }

    if (!mediaPlayer.mediaPlaybackCurrentMediaTrack) {
      mediaSession.metadata = null;
      return;
    }

    const mediaTrack = mediaPlayer.mediaPlaybackCurrentMediaTrack;
    const mediaTrackArtwork = getSessionArtworkForMediaTrack(mediaTrack);

    const mediaSessionMetadata = new MediaMetadata({
      title: mediaTrack.track_name,
      artist: mediaTrack.track_album.album_artist.artist_name,
      album: mediaTrack.track_album.album_name,
      artwork: mediaTrackArtwork && [mediaTrackArtwork],
    });

    debug('updating metadata - %o', mediaSessionMetadata);

    mediaSession.metadata = mediaSessionMetadata;
  }, [
    mediaSession,
    podcastPlaybackSnapshot.isActive,
    podcastPlaybackSnapshot.episode?.title,
    podcastPlaybackSnapshot.subscription?.title,
    podcastPlaybackSnapshot.subscription?.publisher,
    podcastPlaybackSnapshot.subscription?.imageUrl,
    mediaPlayer.mediaPlaybackCurrentMediaTrack,
    mediaPlayer.mediaPlaybackState,
  ]);

  useEffect(() => {
    if (!mediaSession) {
      return;
    }

    let state: MediaSessionPlaybackState = 'none';
    if (podcastPlaybackSnapshot.isActive) {
      state = podcastPlaybackSnapshot.isPlaying ? 'playing' : 'paused';
    } else if (mediaPlayer.mediaPlaybackState === MediaEnums.MediaPlaybackState.Playing) {
      state = 'playing';
    } else if (mediaPlayer.mediaPlaybackState === MediaEnums.MediaPlaybackState.Paused) {
      state = 'paused';
    }
    mediaSession.playbackState = state;
  }, [
    mediaSession,
    podcastPlaybackSnapshot.isActive,
    podcastPlaybackSnapshot.isPlaying,
    mediaPlayer.mediaPlaybackState,
  ]);

  useEffect(() => {
    if (!mediaSession
      || !mediaSession.setPositionState
    ) {
      return;
    }

    let mediaSessionPlaybackState;
    if (podcastPlaybackSnapshot.isActive) {
      if (!Number.isFinite(podcastPlaybackSnapshot.duration) || podcastPlaybackSnapshot.duration <= 0) {
        return;
      }
      mediaSessionPlaybackState = {
        duration: podcastPlaybackSnapshot.duration,
        playbackRate: 1.0,
        position: podcastPlaybackSnapshot.currentTime,
      };
    } else {
      if (!mediaPlayer.mediaPlaybackCurrentMediaTrack
        || mediaPlayer.mediaPlaybackState !== MediaEnums.MediaPlaybackState.Playing) {
        return;
      }
      const duration = Number(mediaPlayer.mediaPlaybackCurrentMediaTrack.track_duration || 0);
      if (!Number.isFinite(duration) || duration <= 0) {
        return;
      }
      const positionRaw = Number(mediaPlayer.mediaPlaybackCurrentMediaProgress || 0);
      const position = Math.min(
        Math.max(0, Number.isFinite(positionRaw) ? positionRaw : 0),
        duration,
      );
      mediaSessionPlaybackState = {
        duration,
        playbackRate: 1.0,
        position,
      };
    }

    debug('updating position state - %o', mediaSessionPlaybackState);

    mediaSession.setPositionState(mediaSessionPlaybackState);
  }, [
    mediaSession,
    podcastPlaybackSnapshot.isActive,
    podcastPlaybackSnapshot.duration,
    podcastPlaybackSnapshot.currentTime,
    mediaPlayer.mediaPlaybackState,
    mediaPlayer.mediaPlaybackCurrentMediaTrack,
    mediaPlayer.mediaPlaybackCurrentMediaProgress,
  ]);

  // important - this component does not render anything
  return (
    <></>
  );
}
