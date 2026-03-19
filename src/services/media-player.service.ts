import _ from 'lodash';
import { batch } from 'react-redux';

import { MediaEnums } from '../enums';
import store from '../store';
import { ArrayUtils, StringUtils } from '../utils';
import { MediaTrackDatastore } from '../datastores';

import {
  IMediaPlayback,
  IMediaPlaybackPreparationStatus,
  IMediaQueueTrack,
  IMediaTrack,
  IMediaTrackList,
} from '../interfaces';

import { I18nService } from './i18n.service';
import { MediaTrackService } from './media-track.service';
import { MediaProviderService } from './media-provider.service';
import { NotificationService } from './notification.service';
import { PodcastService } from './podcast.service';
import { DlnaService, DlnaState } from './dlna.service';
import { BitPerfectService } from './bit-perfect.service';

const debug = require('debug')('aurora:service:media_player');

class MediaPlayerService {
  private mediaProgressReportRetryCount = 15;
  private mediaProgressReportRetryDelayMS = 150;
  private mediaProgressReportCurrentRetryCount = 0;
  private remoteVolumeSyncIntervalMs = 1000;
  private lastRemoteVolumeSyncAt = 0;
  private remoteVolumeSyncInFlight = false;
  private gaplessPreloadLeadSeconds = 8;
  private preloadedPlaybackByQueueEntryId: Map<string, IMediaPlayback> = new Map();
  private preloadedQueueEntryId?: string;
  private dlnaLastState?: DlnaState;
  private outputSwitchInProgress = false;
  private dlnaNextTrackSyncIntervalMs = 4000;
  private lastDlnaNextTrackSyncAt = 0;
  private lastDlnaNextTrackQueueEntryId?: string;

  constructor() {
    DlnaService.initialize();
    this.dlnaLastState = DlnaService.getState();
    DlnaService.subscribe((nextState) => {
      this.handleDlnaStateChanged(nextState);
    });
  }

  // media queue control API

  playMediaTrack(mediaTrack: IMediaTrack): void {
    this.stopPodcastPlayback();
    if (this.shouldBlockDsdWithoutBitPerfect(mediaTrack)) {
      return;
    }

    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaPlaybackCurrentMediaTrack,
      mediaPlaybackCurrentPlayingInstance,
    } = mediaPlayer;

    if (mediaPlaybackCurrentMediaTrack && mediaPlaybackCurrentPlayingInstance) {
      // resume media playback if we are playing same track
      if (mediaPlaybackCurrentMediaTrack.id === mediaTrack.id) {
        debug('playMediaTrack - resuming - media track id - %s', mediaPlaybackCurrentMediaTrack.id);
        this.resumeMediaPlayer();
        return;
      }

      // pause media player
      debug('playMediaTrack - pausing - media track id - %s', mediaPlaybackCurrentMediaTrack.id);
      if (!DlnaService.isRemoteOutputRequested()) {
        this.pauseMediaPlayer();
      }
    }

    // add track to the queue
    // important - setting track will remove all existing ones
    this.loadMediaTrackToQueue(mediaTrack);

    // request media provider to load and play the track
    this.loadAndPlayMediaTrack();
  }

  playMediaTracks(mediaTracks: IMediaTrack[], mediaTrackList?: IMediaTrackList): void {
    if (_.isEmpty(mediaTracks)) {
      throw new Error('MediaPlayerService encountered error at playMediaTracks - Empty track list was provided');
    }

    this.stopPodcastPlayback();
    if (this.shouldBlockDsdWithoutBitPerfect(mediaTracks[0])) {
      return;
    }

    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaPlaybackCurrentMediaTrack,
      mediaPlaybackCurrentTrackList,
      mediaPlaybackCurrentPlayingInstance,
    } = mediaPlayer;

    if (mediaPlaybackCurrentMediaTrack && mediaPlaybackCurrentPlayingInstance) {
      // resume media playback if we are playing same tracklist
      if (mediaPlaybackCurrentTrackList?.id === mediaTrackList?.id) {
        debug('playMediaTrack - resuming - media track id - %s', mediaPlaybackCurrentMediaTrack.id);
        this.resumeMediaPlayer();
        return;
      }

      // pause media player
      debug('playMediaTrack - pausing - media track id - %s', mediaPlaybackCurrentMediaTrack.id);
      if (!DlnaService.isRemoteOutputRequested()) {
        this.pauseMediaPlayer();
      }
    }

    // add tracks to the queue
    // important - setting tracks will remove all existing ones
    this.loadMediaTracksToQueue(mediaTracks, mediaTrackList);

    // request media provider to load and play the track
    this.loadAndPlayMediaTrack();
  }

  playMediaTrackFromList(mediaTracks: IMediaTrack[], mediaTrackPointer: number, mediaTrackList?: IMediaTrackList): void {
    if (_.isEmpty(mediaTracks)) {
      throw new Error('MediaPlayerService encountered error at playMediaTracks - Empty track list was provided');
    }

    this.stopPodcastPlayback();

    const mediaTrack = mediaTracks[mediaTrackPointer];
    if (!mediaTrack) {
      throw new Error('MediaPlayerService encountered error at playMediaTracks - Provided media track does not exists in the list');
    }
    if (this.shouldBlockDsdWithoutBitPerfect(mediaTrack)) {
      return;
    }

    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaPlaybackCurrentMediaTrack,
      mediaPlaybackCurrentTrackList,
      mediaPlaybackCurrentPlayingInstance,
      mediaPlaybackQueueOnShuffle,
    } = mediaPlayer;

    if (mediaPlaybackCurrentMediaTrack && mediaPlaybackCurrentPlayingInstance) {
      // resume media playback if we are playing same tracklist
      if (mediaPlaybackCurrentTrackList?.id === mediaTrackList?.id && mediaPlaybackCurrentMediaTrack.id === mediaTrack.id) {
        debug('playMediaTrack - resuming - media track id - %s', mediaPlaybackCurrentMediaTrack.id);
        this.resumeMediaPlayer();
        return;
      }

      // pause media player
      debug('playMediaTrack - pausing - media track id - %s', mediaPlaybackCurrentMediaTrack.id);
      if (!DlnaService.isRemoteOutputRequested()) {
        this.pauseMediaPlayer();
      }
    }

    // add tracks to the queue
    // important - setting tracks will remove all existing ones
    // important - pass the pointer for the track whose position will be preserved in case shuffling is enabled
    // in case shuffling is enabled, track to load will be on top of the list
    const mediaQueueTracks = this.loadMediaTracksToQueue(mediaTracks, mediaTrackList, mediaTrackPointer);

    // request media provider to load and play the track
    const mediaQueueTrackToPlay = mediaPlaybackQueueOnShuffle ? mediaQueueTracks[0] : mediaQueueTracks[mediaTrackPointer];
    this.loadAndPlayMediaTrack(mediaQueueTrackToPlay);
  }

  playMediaTrackFromQueue(mediaQueueTrack: IMediaQueueTrack) {
    this.stopPodcastPlayback();
    if (this.shouldBlockDsdWithoutBitPerfect(mediaQueueTrack)) {
      return;
    }

    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaPlaybackCurrentMediaTrack,
    } = mediaPlayer;

    // if the current media track is same as provided one, simply resume and conclude
    if (mediaPlaybackCurrentMediaTrack && mediaPlaybackCurrentMediaTrack.queue_entry_id === mediaQueueTrack.queue_entry_id) {
      this.resumeMediaPlayer();
      return;
    }

    // pause current playing instance
    if (!DlnaService.isRemoteOutputRequested()) {
      this.pauseMediaPlayer();
    }

    // load up and play found track from queue
    this.loadAndPlayMediaTrack(mediaQueueTrack);
  }

  addMediaTrackToQueue(mediaTrack: IMediaTrack, mediaTrackAddToQueueOptions?: { skipUserNotification?: boolean }): void {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaTracks,
      mediaPlaybackCurrentTrackList,
      mediaPlaybackCurrentMediaTrack,
      mediaTrackLastInsertedQueueId,
    } = mediaPlayer;

    const mediaQueueTrack = this.getMediaQueueTrack(mediaTrack);

    // #1 - determine the track after which the new track will be inserted
    // by default, it will get inserted at start of the list
    // if mediaTrackLastInsertedQueueId is present, track will be inserted after that track
    // otherwise, if mediaPlaybackCurrentMediaTrack is present, track will be inserted after that track
    let mediaTrackExistingPointer;
    if (mediaTrackLastInsertedQueueId) {
      mediaTrackExistingPointer = _.findIndex(mediaTracks, track => track.queue_entry_id === mediaTrackLastInsertedQueueId);
    } else if (mediaPlaybackCurrentMediaTrack) {
      mediaTrackExistingPointer = _.findIndex(mediaTracks, track => track.queue_entry_id === mediaPlaybackCurrentMediaTrack.queue_entry_id);
    }

    // #2 - update the queue_insertion_index for the new track with that of obtained track
    // this will be a simple increment as we are inserting it after the obtained track
    let mediaTrackInsertPointer = 0;
    if (!_.isNil(mediaTrackExistingPointer)) {
      mediaTrackInsertPointer = mediaTrackExistingPointer + 1;

      const mediaTrackExisting = mediaTracks[mediaTrackExistingPointer];
      mediaQueueTrack.queue_insertion_index = mediaTrackExisting.queue_insertion_index + 1;
    }

    // #3 - insert the new track from the obtained pointer
    mediaTracks.splice(mediaTrackInsertPointer, 0, mediaQueueTrack);

    // #4 - update the queue_insertion_index for all the subsequent tracks in queue
    // this is as well is going to be a simple increment over the previous value as have inserted only one track
    for (let mediaTrackPointer = mediaTrackInsertPointer + 1; mediaTrackPointer < mediaTracks.length; mediaTrackPointer += 1) {
      const mediaTrackFromQueue = mediaTracks[mediaTrackPointer];
      if (mediaTrackFromQueue.queue_insertion_index >= mediaQueueTrack.queue_insertion_index) {
        mediaTrackFromQueue.queue_insertion_index += 1;
      }
    }

    // #5 - update state
    store.dispatch({
      type: MediaEnums.MediaPlayerActions.SetTracks,
      data: {
        mediaTracks,
        // important - adding a track outside current tracklist will reset it
        mediaTrackList: mediaPlaybackCurrentTrackList && mediaPlaybackCurrentTrackList.id === mediaQueueTrack.tracklist_id
          ? mediaPlaybackCurrentTrackList
          : undefined,
        // important to send the mediaTrackLastInsertedQueueId with that of track we inserted
        // this is to keep track of the inserted track when we are inserting a new one in the list
        mediaTrackLastInsertedQueueId: mediaQueueTrack.queue_entry_id,
      },
    });

    // #6 - if there's no loaded track currently, load the added track
    if (!mediaPlaybackCurrentMediaTrack) {
      this.loadMediaTrack(mediaQueueTrack);
    }

    // #7 - notify user
    if (!mediaTrackAddToQueueOptions?.skipUserNotification) {
      NotificationService.showMessage(I18nService.getString('message_added_to_queue'));
    }
  }

  addMediaTracksToQueue(mediaTracksToAdd: IMediaTrack[]): void {
    mediaTracksToAdd.forEach((mediaTrackToAdd) => {
      this.addMediaTrackToQueue(mediaTrackToAdd, {
        skipUserNotification: true,
      });
    });

    NotificationService.showMessage(I18nService.getString('message_added_to_queue'));
  }

  removeMediaTrackFromQueue(mediaQueueTrackId: string): void {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaTracks,
      mediaPlaybackCurrentTrackList,
    } = mediaPlayer;

    // #1 - get the track with position
    const mediaQueueTrackPointer = _.findIndex(mediaTracks, mediaTrack => mediaTrack.queue_entry_id === mediaQueueTrackId);
    const mediaQueueTrack = mediaTracks[mediaQueueTrackPointer];
    if (!mediaQueueTrack) {
      throw new Error('MediaPlayerService encountered error at removeMediaTrackFromQueue - Provided media track was not found in the list');
    }

    // #2 - remove track from the list using the obtained position
    _.pullAt(mediaTracks, mediaQueueTrackPointer);

    // #3 - update the queue_insertion_index for all the subsequent tracks in queue
    // this is as well is going to be a simple decrement over the previous value as have removed only one track
    for (let mediaTrackPointer = 0; mediaTrackPointer < mediaTracks.length; mediaTrackPointer += 1) {
      const mediaTrackFromQueue = mediaTracks[mediaTrackPointer];
      if (mediaTrackFromQueue.queue_insertion_index >= mediaQueueTrack.queue_insertion_index) {
        mediaTrackFromQueue.queue_insertion_index -= 1;
      }
    }

    // #4 - update state
    store.dispatch({
      type: MediaEnums.MediaPlayerActions.SetTracks,
      data: {
        mediaTracks,
        // important - retain existing tracklist when removing tracks
        mediaTrackList: mediaPlaybackCurrentTrackList,
      },
    });
  }

  removeMediaTracksFromQueue(mediaQueueTrackIds: string[]) {
    mediaQueueTrackIds.forEach((mediaQueueTrackId) => {
      this.removeMediaTrackFromQueue(mediaQueueTrackId);
    });
  }

  clearMediaQueueTracks(): void {
    const { mediaPlayer } = store.getState();
    const { mediaTracks, mediaPlaybackCurrentTrackList } = mediaPlayer;

    const queueTracks = this.getMediaQueueTracks();
    if (_.isEmpty(queueTracks)) {
      return;
    }

    // remove everything from current main list including and after the first track in queue
    const index = _.findIndex(mediaTracks, track => track.queue_entry_id === queueTracks[0].queue_entry_id);
    const updatedMediaTracks = mediaTracks.slice(0, index);

    store.dispatch({
      type: MediaEnums.MediaPlayerActions.SetTracks,
      data: {
        mediaTracks: updatedMediaTracks,
        mediaTrackList: mediaPlaybackCurrentTrackList,
        mediaTrackLastInsertedQueueId: undefined,
      },
    });
  }

  loadMediaTrack(mediaQueueTrack: IMediaQueueTrack): IMediaPlayback {
    // loading a media track will always remove the track repeat
    this.removeTrackRepeat();

    const preloadedPlayback = this.preloadedPlaybackByQueueEntryId.get(mediaQueueTrack.queue_entry_id);
    const mediaPlayback = preloadedPlayback || this.createMediaPlayback(mediaQueueTrack, true);
    this.preloadedPlaybackByQueueEntryId.delete(mediaQueueTrack.queue_entry_id);
    this.preloadedQueueEntryId = undefined;

    // load the track
    store.dispatch({
      type: MediaEnums.MediaPlayerActions.LoadTrack,
      data: {
        mediaQueueTrackEntryId: mediaQueueTrack.queue_entry_id,
        mediaPlayingInstance: mediaPlayback,
        // important - in order to prevent adding tracks to queue before the current playing track
        // loading a track would always reset the last inserted track pointer
        mediaTrackLastInsertedQueueId: undefined,
      },
    });

    return mediaPlayback;
  }

  loadMediaQueueTracks(mediaQueueTracks: IMediaQueueTrack[], mediaTrackList?: IMediaTrackList) {
    this.clearGaplessPreloads();
    store.dispatch({
      type: MediaEnums.MediaPlayerActions.SetTracks,
      data: {
        mediaTracks: mediaQueueTracks,
        mediaTrackList,
      },
    });
  }

  async revalidatePlayer(): Promise<void> {
    // this run revalidation on the current queued tracks
    // this removes / unloads track(s) which are not found in the datastore
    // important - this does not update any track in place

    const { mediaPlayer } = store.getState();
    const {
      mediaTracks,
      mediaPlaybackCurrentTrackList,
      mediaTrackLastInsertedQueueId,
      mediaPlaybackCurrentMediaTrack,
    } = mediaPlayer;

    // revalidate queue
    const mediaTrackIds = mediaTracks.map(mediaTrack => mediaTrack.id);
    const mediaTracksUpdated = await MediaTrackDatastore.findMediaTracks({
      id: {
        $in: mediaTrackIds,
      },
    });
    const mediaTracksUpdatedIds = mediaTracksUpdated.map(mediaTrack => mediaTrack.id);
    const mediaQueueTracksUpdated = mediaTracks.filter(mediaTrack => mediaTracksUpdatedIds.includes(mediaTrack.id));

    store.dispatch({
      type: MediaEnums.MediaPlayerActions.SetTracks,
      data: {
        mediaTracks: mediaQueueTracksUpdated,
        mediaTrackList: mediaPlaybackCurrentTrackList,
        mediaTrackLastInsertedQueueId,
      },
    });

    // revalidate current playing track
    // if the current track was not found in the updated list, pause and load next on player
    // if no tracks are in queue, stop the player
    if (mediaPlaybackCurrentMediaTrack && !mediaTracksUpdatedIds.includes(mediaPlaybackCurrentMediaTrack.id)) {
      const nextMediaTrack = this.getNextFromList();
      if (nextMediaTrack) {
        this.pauseMediaPlayer();
        this.loadMediaTrack(nextMediaTrack);
      } else {
        this.stopMediaPlayer();
      }
    }
  }

  // media playback control API

  pauseMediaPlayer(): void {
    const {
      mediaPlayer,
    } = store.getState();
    const {
      mediaPlaybackCurrentMediaTrack,
      mediaPlaybackCurrentPlayingInstance,
    } = mediaPlayer;

    if (!mediaPlaybackCurrentMediaTrack || !mediaPlaybackCurrentPlayingInstance) {
      return;
    }

    const playbackInstance = mediaPlaybackCurrentPlayingInstance;
    playbackInstance
      .pausePlayback()
      .then(async (mediaPlaybackPaused) => {
        let paused = mediaPlaybackPaused;
        if (!paused && DlnaService.isRemoteOutputRequested()) {
          const snapshot = await DlnaService.getSelectedRendererSnapshot().catch(() => undefined);
          const transportState = String(snapshot?.transportState || '').toUpperCase();
          paused = transportState === 'PAUSED_PLAYBACK' || transportState === 'PAUSED';
          if (!paused && transportState === 'STOPPED') {
            paused = true;
          }
          if (!paused && transportState === 'TRANSITIONING') {
            store.dispatch({
              type: MediaEnums.MediaPlayerActions.LoadingTrack,
            });
          }
        }
        if (!paused) {
          return;
        }
        const { mediaPlayer: currentMediaPlayer } = store.getState();
        if (currentMediaPlayer.mediaPlaybackCurrentPlayingInstance !== playbackInstance) {
          return;
        }

        store.dispatch({
          type: MediaEnums.MediaPlayerActions.PausePlayer,
        });
      });
  }

  resumeMediaPlayer(): void {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaPlaybackCurrentMediaTrack,
      mediaPlaybackCurrentPlayingInstance,
    } = mediaPlayer;

    if (!mediaPlaybackCurrentMediaTrack || !mediaPlaybackCurrentPlayingInstance) {
      return;
    }
    if (this.shouldBlockDsdWithoutBitPerfect(mediaPlaybackCurrentMediaTrack)) {
      return;
    }

    mediaPlaybackCurrentPlayingInstance
      .resumePlayback()
      .then(async (mediaPlaybackResumed) => {
        let resumed = mediaPlaybackResumed;
        if (!resumed && DlnaService.isRemoteOutputRequested()) {
          const snapshot = await DlnaService.getSelectedRendererSnapshot().catch(() => undefined);
          const transportState = String(snapshot?.transportState || '').toUpperCase();
          resumed = transportState === 'PLAYING';
        }
        if (!resumed) {
          return;
        }

        store.dispatch({
          type: MediaEnums.MediaPlayerActions.Play,
          data: {
            mediaPlaybackProgress: this.getCurrentPlaybackProgress(),
          },
        });

        this.reportMediaPlaybackProgress();
      });
  }

  toggleMediaPlayback(): void {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaPlaybackState,
    } = mediaPlayer;

    if (mediaPlaybackState === MediaEnums.MediaPlaybackState.Playing) {
      this.pauseMediaPlayer();
    } else {
      this.resumeMediaPlayer();
    }
  }

  async switchOutputDevice(outputDeviceId: string): Promise<void> {
    if (this.outputSwitchInProgress) {
      return;
    }
    const dlnaState = DlnaService.getState();
    const normalizedOutputDeviceId = String(outputDeviceId || 'local').trim() || 'local';
    const currentOutputDeviceId = dlnaState.outputMode === 'remote' && dlnaState.selectedRendererId
      ? dlnaState.selectedRendererId
      : 'local';
    if (normalizedOutputDeviceId === currentOutputDeviceId) {
      return;
    }
    this.outputSwitchInProgress = true;
    try {
      const { mediaPlayer } = store.getState();
      const {
        mediaPlaybackCurrentMediaTrack,
        mediaPlaybackCurrentPlayingInstance,
        mediaPlaybackState,
      } = mediaPlayer;

      const wasPlaying = mediaPlaybackState === MediaEnums.MediaPlaybackState.Playing
        || mediaPlaybackState === MediaEnums.MediaPlaybackState.Loading;
      const preserveProgress = mediaPlaybackCurrentPlayingInstance
        ? this.getCurrentPlaybackProgressSafe(mediaPlaybackCurrentPlayingInstance)
        : 0;

      if (mediaPlaybackCurrentPlayingInstance) {
        store.dispatch({
          type: MediaEnums.MediaPlayerActions.PausePlayer,
        });
        await mediaPlaybackCurrentPlayingInstance.stopPlayback().catch(() => false);
      }

      await DlnaService.setOutputDevice(normalizedOutputDeviceId).catch(async (error) => {
        if (normalizedOutputDeviceId === 'local') {
          throw error;
        }
        await DlnaService.refreshRendererDevices();
        await DlnaService.setOutputDevice(normalizedOutputDeviceId);
      });
      if (normalizedOutputDeviceId !== 'local') {
        this.syncPlaybackVolumeFromSelectedRenderer().catch((error) => {
          debug('switchOutputDevice - failed to sync renderer output state - %o', error);
        });
      }

      if (!mediaPlaybackCurrentMediaTrack) {
        return;
      }

      const mediaPlayback = this.loadMediaTrack(mediaPlaybackCurrentMediaTrack);
      if (wasPlaying) {
        let mediaPlayed = await mediaPlayback.play();
        if (!mediaPlayed && normalizedOutputDeviceId !== 'local') {
          await DlnaService.stopSelectedRenderer().catch(() => undefined);
          await new Promise((resolve) => {
            setTimeout(resolve, 250);
          });
          mediaPlayed = await mediaPlayback.play();
        }
        if (!mediaPlayed) {
          return;
        }
        if (preserveProgress > 0) {
          await mediaPlayback.seekPlayback(preserveProgress).catch(() => false);
        }
        store.dispatch({
          type: MediaEnums.MediaPlayerActions.Play,
          data: {
            mediaPlaybackProgress: this.getCurrentPlaybackProgressSafe(mediaPlayback),
          },
        });
        this.reportMediaPlaybackProgress();
        this.syncSelectedRendererNextTrack({ force: true });
      } else if (preserveProgress > 0) {
        await mediaPlayback.seekPlayback(preserveProgress).catch(() => false);
      }
    } finally {
      this.outputSwitchInProgress = false;
      const { mediaPlayer: currentMediaPlayer } = store.getState();
      if (currentMediaPlayer.mediaPlaybackState === MediaEnums.MediaPlaybackState.Playing
        && currentMediaPlayer.mediaPlaybackCurrentPlayingInstance) {
        this.startMediaProgressReporting();
      }
    }
  }

  stopMediaPlayer(): void {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaPlaybackCurrentMediaTrack,
      mediaPlaybackCurrentPlayingInstance,
    } = mediaPlayer;

    if (!mediaPlaybackCurrentMediaTrack || !mediaPlaybackCurrentPlayingInstance) {
      return;
    }

    const playbackInstance = mediaPlaybackCurrentPlayingInstance;
    playbackInstance
      .stopPlayback()
      .then((mediaPlaybackStopped) => {
        if (!mediaPlaybackStopped) {
          // TODO: Handle cases where media playback could not be stopped
          return;
        }
        const { mediaPlayer: currentMediaPlayer } = store.getState();
        if (currentMediaPlayer.mediaPlaybackCurrentPlayingInstance !== playbackInstance) {
          return;
        }

        store.dispatch({
          type: MediaEnums.MediaPlayerActions.StopPlayer,
        });
      });
  }

  toggleShuffle(): void {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaTracks,
      mediaPlaybackCurrentMediaTrack,
      mediaPlaybackCurrentTrackList,
      mediaPlaybackQueueOnShuffle,
    } = mediaPlayer;

    const mediaPlaybackQueueShuffleEnabled = !mediaPlaybackQueueOnShuffle;

    // important - when shuffle is requested, only the tracks except the current one are shuffled
    // the current one then is always placed first and rest of the list is filled with shuffled tracks
    let mediaQueueTracks: IMediaQueueTrack[] = [];
    if (mediaPlaybackQueueShuffleEnabled) {
      if (mediaPlaybackCurrentMediaTrack) {
        const mediaTracksToShuffle = _.filter(mediaTracks, mediaTrack => mediaTrack.queue_entry_id !== mediaPlaybackCurrentMediaTrack.queue_entry_id);
        const mediaTracksShuffled = this.getShuffledMediaTracks(mediaTracksToShuffle);

        mediaQueueTracks = [mediaPlaybackCurrentMediaTrack, ...mediaTracksShuffled];
      } else {
        mediaQueueTracks = this.getShuffledMediaTracks(mediaTracks);
      }
    } else {
      mediaQueueTracks = this.getSortedMediaTracks(mediaTracks);
    }

    // important - dispatch in batch to avoid re-renders
    // we are going to update tracks first, then the shuffle state
    batch(() => {
      this.loadMediaQueueTracks(mediaQueueTracks, mediaPlaybackCurrentTrackList);
      this.setShuffle(mediaPlaybackQueueShuffleEnabled);
    });
  }

  setShuffle(mediaPlaybackQueueOnShuffle: boolean): void {
    store.dispatch({
      type: MediaEnums.MediaPlayerActions.SetShuffle,
      data: {
        mediaPlaybackQueueOnShuffle,
      },
    });
  }

  toggleRepeat(): void {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaPlaybackQueueRepeatType,
    } = mediaPlayer;

    let mediaPlaybackQueueUpdatedRepeatType;
    if (!mediaPlaybackQueueRepeatType) {
      mediaPlaybackQueueUpdatedRepeatType = MediaEnums.MediaPlaybackRepeatType.Queue;
    } else if (mediaPlaybackQueueRepeatType === MediaEnums.MediaPlaybackRepeatType.Queue) {
      mediaPlaybackQueueUpdatedRepeatType = MediaEnums.MediaPlaybackRepeatType.Track;
    }

    this.setRepeat(mediaPlaybackQueueUpdatedRepeatType);
  }

  setRepeat(mediaPlaybackQueueRepeatType?: MediaEnums.MediaPlaybackRepeatType): void {
    store.dispatch({
      type: MediaEnums.MediaPlayerActions.SetRepeat,
      data: {
        mediaPlaybackQueueRepeatType,
      },
    });
  }

  // media volume control API

  changeMediaPlayerVolume(mediaPlaybackVolume: number): void {
    this.changePlaybackVolumeAsync(mediaPlaybackVolume)
      .then((mediaPlaybackVolumeChanged) => {
        if (!mediaPlaybackVolumeChanged) {
          // TODO: Handle cases where media playback volume could not be changed
        }
      });
  }

  muteMediaPlayerVolume(): void {
    this.mutePlaybackVolumeAsync()
      .then((mediaPlaybackVolumeMuted) => {
        if (!mediaPlaybackVolumeMuted) {
          // TODO: Handle cases where media playback could not be muted
        }
      });
  }

  unmuteMediaPlayerVolume(): void {
    this.unmutePlaybackVolumeAsync()
      .then((mediaPlaybackVolumeUnmuted) => {
        if (!mediaPlaybackVolumeUnmuted) {
          // TODO: Handle cases where media playback could not be un-muted
        }
      });
  }

  // media track control API

  seekMediaTrack(mediaTrackSeekPosition: number): void {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaPlaybackState,
      mediaPlaybackCurrentMediaTrack,
      mediaPlaybackCurrentPlayingInstance,
    } = mediaPlayer;

    if (!mediaPlaybackCurrentMediaTrack || !mediaPlaybackCurrentPlayingInstance) {
      return;
    }

    // update playback progress state to the requested one right away
    // this is being done in order to prevent delay between seek request and actual audio seek success response
    this.updateMediaPlaybackProgress(mediaTrackSeekPosition, true);

    mediaPlaybackCurrentPlayingInstance
      .seekPlayback(mediaTrackSeekPosition)
      .then((mediaPlaybackSeeked) => {
        if (!mediaPlaybackSeeked) {
          // TODO: Handle cases where media playback could not be seeked
          return;
        }

        if (mediaPlaybackState === MediaEnums.MediaPlaybackState.Playing) {
          // only request progress update if track is currently playing
          // this is being done in order to avoid progress updates if track is already ended
          this.startMediaProgressReporting();
        }
      });
  }

  playPreviousTrack(force?: boolean): void {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaPlaybackCurrentMediaTrack,
      mediaPlaybackCurrentMediaProgress,
    } = mediaPlayer;

    // we will be seeking current track to 0 if:
    // - we don't have any previous track in the queue
    // - or, action was not forced and the track has progressed for more than 15 seconds
    // otherwise, we will be playing the previous track in queue

    if (DlnaService.isRemoteOutputRequested()) {
      if (!this.hasPreviousTrack() || (!force
        && mediaPlaybackCurrentMediaTrack
        && mediaPlaybackCurrentMediaProgress
        && mediaPlaybackCurrentMediaProgress > 15)) {
        this.seekMediaTrack(0);
      } else {
        this.playPrevious();
      }
      return;
    }

    if (!this.hasPreviousTrack() || (!force
      && mediaPlaybackCurrentMediaTrack
      && mediaPlaybackCurrentMediaProgress
      && mediaPlaybackCurrentMediaProgress > 15)) {
      this.seekMediaTrack(0);
    } else {
      this.pauseMediaPlayer();
      this.playPrevious();
    }
  }

  playNextTrack(): void {
    if (!DlnaService.isRemoteOutputRequested()) {
      this.pauseMediaPlayer();
    }
    this.removeTrackRepeat();
    this.playNext();
  }

  hasPreviousTrack(): boolean {
    return !_.isNil(this.getPreviousFromList());
  }

  hasNextTrack(): boolean {
    return !_.isNil(this.getNextFromList());
  }

  // read / write API

  getMediaQueueTracks(): IMediaQueueTrack[] {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaTracks,
      mediaPlaybackCurrentMediaTrack,
    } = mediaPlayer;

    if (!mediaPlaybackCurrentMediaTrack) {
      return mediaTracks;
    }

    const currentIndex = _.findIndex(mediaTracks, mediaTrack => mediaTrack.queue_entry_id === mediaPlaybackCurrentMediaTrack.queue_entry_id);
    return mediaTracks.slice(currentIndex + 1);
  }

  updateMediaQueueTracks(mediaQueueTracks: IMediaQueueTrack[]): void {
    const { mediaPlayer } = store.getState();
    const { mediaPlaybackCurrentMediaTrack, mediaPlaybackCurrentTrackList } = mediaPlayer;
    let { mediaTracks } = mediaPlayer;

    if (mediaPlaybackCurrentMediaTrack) {
      const currentIndex = _.findIndex(mediaTracks, mediaTrack => mediaTrack.queue_entry_id === mediaPlaybackCurrentMediaTrack.queue_entry_id);
      const existingMediaTracks = mediaTracks.slice(0, currentIndex + 1);

      // replace everything after current with reordered tracks
      mediaTracks = [...existingMediaTracks, ...mediaQueueTracks];
    }

    store.dispatch({
      type: MediaEnums.MediaPlayerActions.SetTracks,
      data: {
        mediaTracks,
        mediaTrackList: mediaPlaybackCurrentTrackList,
        // important - upon updating media tracks in queue manually, we
        // will no longer honor the inserted queue id
        // let the player fallback to default when adding a media track to queue
        mediaTrackLastInsertedQueueId: undefined,
      },
    });
  }

  // private API

  private loadMediaTrackToQueue(mediaTrack: IMediaTrack): IMediaQueueTrack {
    const mediaQueueTrack = this.getMediaQueueTrack(mediaTrack);

    store.dispatch({
      type: MediaEnums.MediaPlayerActions.SetTrack,
      data: {
        mediaTrack: mediaQueueTrack,
      },
    });

    return mediaQueueTrack;
  }

  private loadMediaTracksToQueue(mediaTracks: IMediaTrack[], mediaTrackList?: IMediaTrackList, mediaTrackPointerToPreserve?: number): IMediaQueueTrack[] {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaPlaybackQueueOnShuffle,
    } = mediaPlayer;

    const mediaQueueTracksForTrackList = mediaTracks.map((
      mediaTrack,
      mediaTrackPointer,
    ) => this.getMediaQueueTrack(mediaTrack, mediaTrackPointer, mediaTrackList));

    let mediaQueueTracks: IMediaQueueTrack[] = [];
    if (mediaPlaybackQueueOnShuffle) {
      // important - when mediaTrackPointerToPreserve is provided, only tracks other than this track
      // are shuffled, this track is then stays on the top of the list
      if (!_.isNil(mediaTrackPointerToPreserve)) {
        const mediaTracksToShuffle = _.filter(mediaQueueTracksForTrackList, (_mediaTrack, mediaTrackPointer) => mediaTrackPointer !== mediaTrackPointerToPreserve);
        const mediaTracksShuffled = this.getShuffledMediaTracks(mediaTracksToShuffle);

        mediaQueueTracks = [mediaQueueTracksForTrackList[mediaTrackPointerToPreserve], ...mediaTracksShuffled];
      } else {
        mediaQueueTracks = this.getShuffledMediaTracks(mediaQueueTracksForTrackList);
      }
    } else {
      mediaQueueTracks = this.getSortedMediaTracks(mediaQueueTracksForTrackList);
    }

    this.loadMediaQueueTracks(mediaQueueTracks, mediaTrackList);

    return mediaQueueTracks;
  }

  private getMediaQueueTrack(mediaTrack: IMediaTrack, mediaTrackPointer?: number, mediaTrackList?: IMediaTrackList): IMediaQueueTrack {
    return {
      ...mediaTrack,
      tracklist_id: mediaTrackList ? mediaTrackList.id : mediaTrack.track_album.id,
      queue_entry_id: StringUtils.generateId(),
      queue_insertion_index: _.isNil(mediaTrackPointer) ? 0 : mediaTrackPointer,
    };
  }

  private loadAndPlayMediaTrack(mediaQueueTrack?: IMediaQueueTrack): void {
    this
      .loadAndPlayMediaTrackAsync(mediaQueueTrack)
      .then((mediaPlayed) => {
        if (!mediaPlayed) {
          // TODO: Handle cases where media could not be played
        }
      });
  }

  private async loadAndPlayMediaTrackAsync(mediaQueueTrack?: IMediaQueueTrack): Promise<boolean> {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaTracks,
    } = mediaPlayer;

    // if no media track was explicitly provided, will load from the first one present in current track list
    const mediaTrackToLoad = mediaQueueTrack || mediaTracks[0];
    if (!mediaTrackToLoad) {
      throw new Error('MediaPlayerService encountered error at loadAndPlayMediaTrack - Could not find any track to load');
    }
    if (this.shouldBlockDsdWithoutBitPerfect(mediaTrackToLoad)) {
      return false;
    }

    if (DlnaService.isRemoteOutputRequested()) {
      await this.syncPlaybackVolumeFromSelectedRenderer({
        force: true,
        fetchSnapshot: true,
      });
    }

    const mediaPlayback = this.loadMediaTrack(mediaTrackToLoad);

    // request media provider to play the track
    debug('loadAndPlayMediaTrack - requesting to play - media track id - %s', mediaTrackToLoad.id);

    const mediaPlayed = await mediaPlayback.play();
    if (!mediaPlayed) {
      if (DlnaService.isRemoteOutputRequested()) {
        const snapshot = await DlnaService.getSelectedRendererSnapshot().catch(() => undefined);
        const transportState = String(snapshot?.transportState || '').toUpperCase();
        if (transportState === 'PLAYING' || transportState === 'TRANSITIONING') {
          store.dispatch({
            type: MediaEnums.MediaPlayerActions.Play,
            data: {
              mediaPlaybackProgress: this.getCurrentPlaybackProgress(),
            },
          });
          this.reportMediaPlaybackProgress();
          return true;
        }
        NotificationService.showMessage(I18nService.getString('label_player_output_device_none'));
      }
      this.setPlaybackPreparationStatus(undefined);
      return false;
    }

    store.dispatch({
      type: MediaEnums.MediaPlayerActions.Play,
      data: {
        mediaPlaybackProgress: this.getCurrentPlaybackProgress(),
      },
    });

    this.reportMediaPlaybackProgress();
    this.syncSelectedRendererNextTrack({ force: true });
    return true;
  }

  private setPlaybackPreparationStatus(mediaPlaybackPreparationStatus?: IMediaPlaybackPreparationStatus): void {
    store.dispatch({
      type: MediaEnums.MediaPlayerActions.UpdatePreparationStatus,
      data: {
        mediaPlaybackPreparationStatus,
      },
    });
  }

  private shouldBlockDsdWithoutBitPerfect(mediaTrack?: IMediaTrack): boolean {
    const sourcePath = String((mediaTrack?.extra as any)?.file_path || '').toLowerCase();
    const isDsdTrack = sourcePath.endsWith('.dsf') || sourcePath.endsWith('.dff');
    if (!isDsdTrack) {
      return false;
    }
    const bitPerfectState = BitPerfectService.getState();
    const blocked = !BitPerfectService.isEnabled() || bitPerfectState.backend === 'none';
    if (blocked) {
      NotificationService.showMessage(I18nService.getString('message_dsd_requires_bitperfect'));
      this.setPlaybackPreparationStatus(undefined);
    }
    return blocked;
  }

  private async changePlaybackVolumeAsync(mediaPlaybackVolume: number): Promise<boolean> {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaPlaybackCurrentPlayingInstance,
      mediaPlaybackVolumeMaxLimit,
      mediaPlaybackVolumeMuted,
    } = mediaPlayer;

    if (mediaPlaybackVolume > 0 && mediaPlaybackVolumeMuted) {
      // raising the volume above 0 will unmute the muted audio as well
      // unmute playback
      if (mediaPlaybackCurrentPlayingInstance) {
        const mediaPlaybackVolumeUnmuted = await mediaPlaybackCurrentPlayingInstance.unmutePlaybackVolume();
        if (!mediaPlaybackVolumeUnmuted) {
          return false;
        }
      }
      // update state
      store.dispatch({
        type: MediaEnums.MediaPlayerActions.UnmutePlaybackVolume,
      });
    }

    if (mediaPlaybackCurrentPlayingInstance) {
      // change playback volume
      const mediaPlaybackVolumeChanged = mediaPlaybackCurrentPlayingInstance.changePlaybackVolume(
        mediaPlaybackVolume,
        mediaPlaybackVolumeMaxLimit,
      );
      if (!mediaPlaybackVolumeChanged) {
        return false;
      }
    }

    // update state
    store.dispatch({
      type: MediaEnums.MediaPlayerActions.UpdatePlaybackVolume,
      data: {
        mediaPlaybackVolume,
      },
    });

    return true;
  }

  private async mutePlaybackVolumeAsync(): Promise<boolean> {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaPlaybackCurrentPlayingInstance,
      mediaPlaybackVolumeMuted,
    } = mediaPlayer;

    if (mediaPlaybackVolumeMuted) {
      return true;
    }

    // mute playback
    if (mediaPlaybackCurrentPlayingInstance) {
      const mediaPlaybackVolumeWasMuted = mediaPlaybackCurrentPlayingInstance.mutePlaybackVolume();
      if (!mediaPlaybackVolumeWasMuted) {
        return false;
      }
    }

    // update state
    store.dispatch({
      type: MediaEnums.MediaPlayerActions.MutePlaybackVolume,
    });

    return true;
  }

  private async unmutePlaybackVolumeAsync(): Promise<boolean> {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaPlaybackCurrentPlayingInstance,
      mediaPlaybackVolumeMuted,
    } = mediaPlayer;

    if (!mediaPlaybackVolumeMuted) {
      return true;
    }

    // unmute playback
    if (mediaPlaybackCurrentPlayingInstance) {
      const mediaPlaybackVolumeWasUnmuted = mediaPlaybackCurrentPlayingInstance.unmutePlaybackVolume();
      if (!mediaPlaybackVolumeWasUnmuted) {
        return false;
      }
    }

    // update state
    store.dispatch({
      type: MediaEnums.MediaPlayerActions.UnmutePlaybackVolume,
    });

    return true;
  }

  private startMediaProgressReporting() {
    // reset the retry count so that we can retry again in case of further failures
    this.mediaProgressReportCurrentRetryCount = 0;

    // using setTimeout instead of requestAnimationFrame as setTimeout also works when app is in background
    setTimeout(() => {
      this.reportMediaPlaybackProgress();
    });
  }

  private reportMediaPlaybackProgress(): void {
    if (this.outputSwitchInProgress) {
      debug('reportMediaPlaybackProgress - output switch in progress, scheduling next tick');
      setTimeout(() => {
        this.reportMediaPlaybackProgress();
      }, this.mediaProgressReportRetryDelayMS);
      return;
    }
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaPlaybackCurrentMediaTrack,
      mediaPlaybackCurrentPlayingInstance,
    } = mediaPlayer;

    if (!mediaPlaybackCurrentMediaTrack || !mediaPlaybackCurrentPlayingInstance) {
      debug('reportMediaPlaybackProgress - no running media instance found, aborting...');
      return;
    }

    const mediaPlaybackProgress = this.getCurrentPlaybackProgress();
    if (DlnaService.isRemoteOutputRequested()) {
      this.syncPlaybackVolumeFromSelectedRenderer({
        fetchSnapshot: false,
      }).catch(() => undefined);
    }

    if (mediaPlaybackCurrentPlayingInstance.checkIfPlaying()) {
      this.updateMediaPlaybackProgress(mediaPlaybackProgress);
      this.preloadNextTrackForGapless(mediaPlaybackCurrentMediaTrack, mediaPlaybackProgress);
      this.syncSelectedRendererNextTrack({
        currentTrack: mediaPlaybackCurrentMediaTrack,
        currentProgress: mediaPlaybackProgress,
      });
      this.startMediaProgressReporting();
    } else if (mediaPlaybackCurrentPlayingInstance.checkIfLoading()) {
      debug('reportMediaPlaybackProgress - media playback loading, waiting...');

      // first update the playback state
      store.dispatch({
        type: MediaEnums.MediaPlayerActions.LoadingTrack,
      });

      // re-request update
      this.startMediaProgressReporting();
    } else if (mediaPlaybackCurrentPlayingInstance.checkIfEnded()) {
      debug('reportMediaPlaybackProgress - media playback ended, playing next...');
      this.incrementTrackPlayCount(mediaPlaybackCurrentMediaTrack);
      const mediaTrackNextInQueue = this.getNextFromList();
      const shouldUseGaplessTransition = this.shouldUseGaplessTransition(
        mediaPlaybackCurrentMediaTrack,
        mediaTrackNextInQueue,
      );
      if (!shouldUseGaplessTransition && !DlnaService.isRemoteOutputRequested()) {
        this.pauseMediaPlayer();
      }
      this.playNext();
    } else if (!this.retryMediaProgressReporting()) {
      if (DlnaService.isRemoteOutputRequested()) {
        DlnaService.getSelectedRendererSnapshot()
          .then((snapshot) => {
            const transportState = String(snapshot?.transportState || '').toUpperCase();
            if (transportState === 'PAUSED_PLAYBACK'
              || transportState === 'PAUSED'
              || transportState === 'STOPPED'
              || transportState === 'NO_MEDIA_PRESENT') {
              store.dispatch({
                type: MediaEnums.MediaPlayerActions.PausePlayer,
              });
            } else if (transportState === 'TRANSITIONING') {
              store.dispatch({
                type: MediaEnums.MediaPlayerActions.LoadingTrack,
              });
            }
          })
          .catch(() => undefined);
        this.startMediaProgressReporting();
        return;
      }
      debug('reportMediaPlaybackProgress - media instance did not reported valid state, aborting...');
      this.pauseMediaPlayer();
    }
  }

  // when seeking, we will preserve the playback state (example: playback might be paused but user still requests seek)
  // when not seeking, playback state will be forced to Playing
  private updateMediaPlaybackProgress(mediaPlaybackProgress: number, seeking?: boolean): void {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaPlaybackState,
      mediaPlaybackCurrentMediaProgress = 0,
    } = mediaPlayer;

    const nextPlaybackState = seeking ? mediaPlaybackState : MediaEnums.MediaPlaybackState.Playing;
    if (mediaPlaybackCurrentMediaProgress === mediaPlaybackProgress
      && mediaPlaybackState === nextPlaybackState) {
      return;
    }

    debug('updateMediaPlaybackProgress - updating progress - existing - %d, new - %d', mediaPlaybackCurrentMediaProgress, mediaPlaybackProgress);

    store.dispatch({
      type: MediaEnums.MediaPlayerActions.UpdatePlaybackProgress,
      data: {
        mediaPlaybackState: nextPlaybackState,
        mediaPlaybackProgress,
      },
    });
  }

  private getCurrentPlaybackProgress(): number {
    const { mediaPlayer } = store.getState();
    const { mediaPlaybackCurrentMediaTrack, mediaPlaybackCurrentPlayingInstance } = mediaPlayer;

    if (!mediaPlaybackCurrentMediaTrack || !mediaPlaybackCurrentPlayingInstance) {
      throw new Error('Cannot get current playback progress - track or instance missing');
    }

    // providers are not allowed to report progress greater than the
    // set track duration
    const playbackProgress = Number(mediaPlaybackCurrentPlayingInstance.getPlaybackProgress() || 0);
    const trackDuration = Number(mediaPlaybackCurrentMediaTrack.track_duration || 0);
    if (!Number.isFinite(trackDuration) || trackDuration <= 0) {
      return Math.max(0, playbackProgress);
    }
    return Math.min(Math.max(0, playbackProgress), trackDuration);
  }

  private retryMediaProgressReporting(): boolean {
    if (!(this.mediaProgressReportCurrentRetryCount < this.mediaProgressReportRetryCount)) {
      return false;
    }

    this.mediaProgressReportCurrentRetryCount += 1;
    debug('retryMediaProgressReporting - retrying - current count - %d, total count - %d', this.mediaProgressReportCurrentRetryCount, this.mediaProgressReportRetryCount);

    setTimeout(() => {
      this.reportMediaPlaybackProgress();
    }, this.mediaProgressReportRetryDelayMS);

    return true;
  }

  private getPreviousFromList(): IMediaQueueTrack | undefined {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaTracks,
      mediaPlaybackCurrentMediaTrack,
    } = mediaPlayer;

    let mediaTrack;
    if (!_.isEmpty(mediaTracks) && mediaPlaybackCurrentMediaTrack) {
      const mediaCurrentTrackPointer = _.findIndex(
        mediaTracks,
        track => track.queue_entry_id === mediaPlaybackCurrentMediaTrack.queue_entry_id,
      );
      if (!_.isNil(mediaCurrentTrackPointer) && mediaCurrentTrackPointer > 0) {
        mediaTrack = mediaTracks[mediaCurrentTrackPointer - 1];
      }
    }

    return mediaTrack;
  }

  private playPrevious(): void {
    debug('playPrevious - attempting to play previous...');

    const mediaTrack = this.getPreviousFromList();
    if (!mediaTrack) {
      debug('playPrevious - media previous track could not be obtained, skipping play previous...');
      return;
    }

    debug('playNext - found track to play - %s', mediaTrack.id);

    this.loadAndPlayMediaTrack(mediaTrack);
  }

  private getNextFromList(): IMediaQueueTrack | undefined {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaTracks,
      mediaPlaybackCurrentMediaTrack,
    } = mediaPlayer;

    let mediaTrack;
    if (!_.isEmpty(mediaTracks) && mediaPlaybackCurrentMediaTrack) {
      const mediaCurrentTrackPointer = _.findIndex(
        mediaTracks,
        track => track.queue_entry_id === mediaPlaybackCurrentMediaTrack.queue_entry_id,
      );
      if (!_.isNil(mediaCurrentTrackPointer) && mediaCurrentTrackPointer < mediaTracks.length - 1) {
        mediaTrack = mediaTracks[mediaCurrentTrackPointer + 1];
      }
    }

    return mediaTrack;
  }

  private playNext(): void {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaTracks,
      mediaPlaybackCurrentMediaTrack,
      mediaPlaybackQueueRepeatType,
    } = mediaPlayer;

    debug('playNext - attempting to play next - queue length - %d', mediaTracks.length);

    // procedure to determine what to play next:
    // - if repeat is set to 'track' and we have a media track loaded, play it
    // otherwise get the next from list, and:
    // - if media track was found from the list, play the same
    // - otherwise if repeat is set to 'queue' and list is not empty, play the first track from queue
    // - else simply load (not play!) the first track from the queue if it's not the same as the current track

    if (mediaPlaybackQueueRepeatType === MediaEnums.MediaPlaybackRepeatType.Track && mediaPlaybackCurrentMediaTrack) {
      debug('playNext - repeating track - track id %s, queue entry id - %s', mediaPlaybackCurrentMediaTrack.id, mediaPlaybackCurrentMediaTrack.queue_entry_id);
      this.playMediaTrackFromQueue(mediaPlaybackCurrentMediaTrack);
    } else {
      const mediaTrackNextInQueue = this.getNextFromList();

      if (mediaTrackNextInQueue) {
        debug('playNext - found track to play - track id %s, queue entry id - %s', mediaTrackNextInQueue.id, mediaTrackNextInQueue.queue_entry_id);
        this.playMediaTrackFromQueue(mediaTrackNextInQueue);
      } else if (mediaPlaybackQueueRepeatType === MediaEnums.MediaPlaybackRepeatType.Queue && mediaTracks[0]) {
        debug('playNext - playing queue from beginning - track id %s, queue entry id - %s', mediaTracks[0].id, mediaTracks[0].queue_entry_id);
        this.playMediaTrackFromQueue(mediaTracks[0]);
      } else if (mediaPlaybackCurrentMediaTrack
        && mediaTracks[0]
        && mediaPlaybackCurrentMediaTrack.queue_entry_id !== mediaTracks[0].queue_entry_id) {
        debug('playNext - loading track - track id %s, queue entry id - %s', mediaTracks[0].id, mediaTracks[0].queue_entry_id);
        this.loadMediaTrack(mediaTracks[0]);
      }
    }
  }

  private removeTrackRepeat() {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaPlaybackQueueRepeatType,
    } = mediaPlayer;

    if (mediaPlaybackQueueRepeatType === MediaEnums.MediaPlaybackRepeatType.Track) {
      store.dispatch({
        type: MediaEnums.MediaPlayerActions.SetRepeat,
        data: {
          mediaPlaybackQueueRepeatType: MediaEnums.MediaPlaybackRepeatType.Queue,
        },
      });
    }
  }

  private getShuffledMediaTracks(mediaTracks: IMediaQueueTrack[]): IMediaQueueTrack[] {
    return ArrayUtils.shuffleArray(mediaTracks);
  }

  private getSortedMediaTracks(mediaTracks: IMediaQueueTrack[]): IMediaQueueTrack[] {
    return _.sortBy(mediaTracks, mediaTrack => mediaTrack.queue_insertion_index);
  }

  private stopPodcastPlayback() {
    PodcastService.stopPlayback();
  }

  private handleDlnaStateChanged(nextState: DlnaState) {
    const previousState = this.dlnaLastState;
    this.dlnaLastState = nextState;
    if (!previousState) {
      return;
    }
    const remoteConnectionLost = previousState.outputMode === 'remote'
      && !!previousState.selectedRendererId
      && nextState.outputMode === 'local';
    if (!remoteConnectionLost || this.outputSwitchInProgress) {
      return;
    }
    const { mediaPlayer } = store.getState();
    if (!mediaPlayer.mediaPlaybackCurrentPlayingInstance || !mediaPlayer.mediaPlaybackCurrentMediaTrack) {
      return;
    }
    this.switchOutputDevice('local').catch((error) => {
      debug('handleDlnaStateChanged - failed switching output to local after disconnect - %o', error);
    });
  }

  private getCurrentPlaybackProgressSafe(mediaPlayback: IMediaPlayback): number {
    try {
      const progress = Number(mediaPlayback.getPlaybackProgress() || 0);
      if (!Number.isFinite(progress)) {
        return 0;
      }
      return Math.max(0, progress);
    } catch (_error) {
      return 0;
    }
  }

  private async syncPlaybackVolumeFromSelectedRenderer(
    options?: {
      force?: boolean;
      fetchSnapshot?: boolean;
    },
  ) {
    if (this.remoteVolumeSyncInFlight) {
      return;
    }
    const shouldForce = options?.force === true;
    const now = Date.now();
    if (!shouldForce && (now - this.lastRemoteVolumeSyncAt) < this.remoteVolumeSyncIntervalMs) {
      return;
    }
    this.remoteVolumeSyncInFlight = true;
    this.lastRemoteVolumeSyncAt = now;
    try {
      let volumePercent: number | undefined;
      let muted: boolean | undefined;
      const cachedOutputState = DlnaService.getSelectedRendererOutputState();
      if (Number.isFinite(cachedOutputState?.volumePercent)) {
        volumePercent = Number(cachedOutputState?.volumePercent);
      }
      if (typeof cachedOutputState?.muted === 'boolean') {
        muted = cachedOutputState.muted;
      }
      if (options?.fetchSnapshot !== false && (!Number.isFinite(volumePercent) || typeof muted !== 'boolean')) {
        const snapshot = await DlnaService.getSelectedRendererSnapshot().catch(() => undefined);
        if (!snapshot) {
          return;
        }
        if (Number.isFinite(snapshot.volumePercent)) {
          volumePercent = Number(snapshot.volumePercent);
        }
        if (typeof snapshot.muted === 'boolean') {
          muted = snapshot.muted;
        }
      }
      const { mediaPlayer } = store.getState();
      const {
        mediaPlaybackVolumeCurrent,
        mediaPlaybackVolumeMuted,
      } = mediaPlayer;
      const maxVolume = Math.max(1, Number(mediaPlayer.mediaPlaybackVolumeMaxLimit || 100));
      if (Number.isFinite(volumePercent)) {
        const nextVolume = Math.round((Number(volumePercent || 0) / 100) * maxVolume);
        const clampedVolume = Math.max(0, Math.min(maxVolume, nextVolume));
        if (clampedVolume !== mediaPlaybackVolumeCurrent) {
          store.dispatch({
            type: MediaEnums.MediaPlayerActions.UpdatePlaybackVolume,
            data: {
              mediaPlaybackVolume: clampedVolume,
            },
          });
        }
      }
      if (muted === true && !mediaPlaybackVolumeMuted) {
        store.dispatch({
          type: MediaEnums.MediaPlayerActions.MutePlaybackVolume,
        });
      } else if (muted === false && mediaPlaybackVolumeMuted) {
        store.dispatch({
          type: MediaEnums.MediaPlayerActions.UnmutePlaybackVolume,
        });
      }
    } finally {
      this.remoteVolumeSyncInFlight = false;
    }
  }

  private syncSelectedRendererNextTrack(options?: {
    force?: boolean;
    currentTrack?: IMediaQueueTrack;
    currentProgress?: number;
  }) {
    if (!DlnaService.isRemoteOutputRequested()) {
      return;
    }
    const now = Date.now();
    const forceSync = !!options?.force;
    if (!forceSync && (now - this.lastDlnaNextTrackSyncAt) < this.dlnaNextTrackSyncIntervalMs) {
      return;
    }
    const currentTrack = options?.currentTrack;
    const currentProgress = Number(options?.currentProgress || 0);
    const nearTrackEnd = !!currentTrack
      && Number.isFinite(Number(currentTrack.track_duration))
      && (Number(currentTrack.track_duration || 0) - currentProgress) <= 12;
    const nextTrack = this.getNextFromList();
    if (!forceSync && !nearTrackEnd && this.lastDlnaNextTrackQueueEntryId === nextTrack?.queue_entry_id) {
      return;
    }
    this.lastDlnaNextTrackSyncAt = now;
    this.lastDlnaNextTrackQueueEntryId = nextTrack?.queue_entry_id;
    DlnaService.setNextMediaTrackOnSelectedRenderer(nextTrack).catch((error) => {
      debug('syncSelectedRendererNextTrack - failed to set next track on renderer - %o', error);
    });
  }

  private createMediaPlayback(mediaQueueTrack: IMediaQueueTrack, bindPreparationStatus: boolean): IMediaPlayback {
    const {
      mediaPlayer,
    } = store.getState();

    const {
      mediaPlaybackVolumeCurrent,
      mediaPlaybackVolumeMaxLimit,
      mediaPlaybackVolumeMuted,
    } = mediaPlayer;

    const { mediaPlaybackService } = MediaProviderService.getMediaProvider(mediaQueueTrack.provider);
    const mediaPlayback = mediaPlaybackService.playMediaTrack(mediaQueueTrack, {
      mediaPlaybackVolume: mediaPlaybackVolumeCurrent,
      mediaPlaybackMaxVolume: mediaPlaybackVolumeMaxLimit,
      mediaPlaybackVolumeMuted,
    });

    if (bindPreparationStatus) {
      mediaPlayback.setPreparationStatusListener((mediaPlaybackPreparationStatus) => {
        this.setPlaybackPreparationStatus(mediaPlaybackPreparationStatus);
      });
    }

    return mediaPlayback;
  }

  private preloadNextTrackForGapless(currentTrack: IMediaQueueTrack, currentProgress: number) {
    const nextTrack = this.getNextFromList();
    if (!this.shouldUseGaplessTransition(currentTrack, nextTrack)) {
      return;
    }
    if (!nextTrack) {
      return;
    }
    const remainingDuration = Number(currentTrack.track_duration || 0) - Number(currentProgress || 0);
    if (remainingDuration > this.gaplessPreloadLeadSeconds) {
      return;
    }
    if (this.preloadedPlaybackByQueueEntryId.has(nextTrack.queue_entry_id) || this.preloadedQueueEntryId === nextTrack.queue_entry_id) {
      return;
    }

    this.preloadedQueueEntryId = nextTrack.queue_entry_id;
    const playbackToPreload = this.createMediaPlayback(nextTrack, false);
    const preloadPromise = playbackToPreload.prepareForPlayback
      ? playbackToPreload.prepareForPlayback()
      : Promise.resolve(false);

    preloadPromise
      .then((prepared) => {
        if (!prepared) {
          return;
        }
        this.preloadedPlaybackByQueueEntryId.set(nextTrack.queue_entry_id, playbackToPreload);
      })
      .catch((error) => {
        debug('preloadNextTrackForGapless - failed for queue entry id - %s - error %o', nextTrack.queue_entry_id, error);
      });
  }

  private shouldUseGaplessTransition(currentTrack: IMediaQueueTrack, nextTrack?: IMediaQueueTrack): boolean {
    if (!nextTrack) {
      return false;
    }
    if (currentTrack.track_album_id !== nextTrack.track_album_id) {
      return false;
    }
    const currentAlbumArtist = String(currentTrack.track_album?.album_artist?.artist_name || '').toLowerCase().trim();
    if (this.isCompilationAlbumArtistName(currentAlbumArtist)) {
      return false;
    }
    return true;
  }

  private isCompilationAlbumArtistName(artistName: string): boolean {
    return [
      'various artists',
      'various artist',
      'various',
      'v.a.',
      'va',
      'sampler',
      'compilation',
      'anthology',
      'soundtrack',
      'ost',
    ].includes(artistName);
  }

  private clearGaplessPreloads() {
    this.preloadedQueueEntryId = undefined;
    this.preloadedPlaybackByQueueEntryId.clear();
  }

  private incrementTrackPlayCount(mediaTrack: IMediaTrack) {
    MediaTrackService.incrementTrackPlayCount(mediaTrack.id)
      .catch((error) => {
        debug('incrementTrackPlayCount - failed for track id - %s - error %o', mediaTrack.id, error);
      });
  }
}

export default new MediaPlayerService();
