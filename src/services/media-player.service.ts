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
import { DlnaService, DlnaState, DlnaRendererEventSnapshot } from './dlna.service';
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
  private dlnaQueueContextPublishIntervalMs = 4000;
  private lastDlnaNextTrackSyncAt = 0;
  private lastDlnaNextTrackQueueEntryId?: string;
  /** Dedupe SetNext: pair of (current queue entry, next queue entry). Next-only dedupe missed track 3 when "current" lagged renderer. */
  private lastDlnaNextSyncPairKey = '';
  /** Same pair near track end: limit SetNext repeats (progress ticks used to bypass dedupe and flooded the renderer). */
  private readonly dlnaNearEndSetNextMinIntervalMs = 4000;
  private lastDlnaQueueContextPublishAt = 0;
  private lastDlnaQueueContextPublishSignature?: string;
  private dlnaStrictContextModeEnabled = true;
  private lastDlnaContextKey?: string;
  private lockedDlnaContextTracklistId?: string;
  private remoteAutoAdvanceAwaitUntil = 0;
  private lastRendererTransportState = '';
  private lastRendererProgressSeconds = 0;
  private lastRendererProgressAt = 0;
  private lastRendererProgressTrackId?: string;
  private lastRendererPlayingDetectedAt = 0;
  private lastTrackChangeInitiatedAt = 0;
  private readonly trackChangeBacksyncSuppressMs = 8000;
  private remoteZeroPositionPlayingSince = 0;
  /** When SOAP snapshots fail, keep UI time advancing if we recently saw PLAYING from renderer/events. */
  private readonly remotePlayingInferenceGraceMs = 600000;
  private lastUiDiagnosticsState = '';
  private lastRemoteProgressDiagLogAt = 0;
  private lastRemoteUiPausedFromSoapLogAt = 0;
  /** Monotonic clock when SOAP/effective state last became TRANSITIONING (watchdog for stuck gapless). */
  private remoteTransitioningSinceMs = 0;
  private lastStuckTransitioningPlayNudgeAt = 0;

  constructor() {
    DlnaService.initialize();
    this.dlnaLastState = DlnaService.getState();
    if (DlnaService.isRemoteOutputRequested()) {
      setTimeout(() => {
        this.startMediaProgressReporting();
      }, 250);
    }
    DlnaService.subscribe((nextState) => {
      this.handleDlnaStateChanged(nextState);
    });
    DlnaService.subscribeRendererSnapshot((snapshot) => {
      this.handleDlnaRendererSnapshot(snapshot);
    });
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener(DlnaService.rendererTrackAdvancedEventName, () => {
        if (!DlnaService.isRemoteOutputRequested()) {
          return;
        }
        this.syncSelectedRendererNextTrack({ force: true });
      });
      window.addEventListener('beforeunload', () => {
        if (!DlnaService.isRemoteOutputRequested()) {
          return;
        }
        const { mediaPlayer } = store.getState();
        if (mediaPlayer.mediaPlaybackState === MediaEnums.MediaPlaybackState.Playing
          || mediaPlayer.mediaPlaybackState === MediaEnums.MediaPlaybackState.Loading) {
          store.dispatch({
            type: MediaEnums.MediaPlayerActions.PausePlayer,
          });
        }
        DlnaService.resetOutputToLocalState();
      });
    }
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
      mediaPlaybackState,
    } = mediaPlayer;

    if (mediaPlaybackCurrentMediaTrack && mediaPlaybackCurrentPlayingInstance) {
      const currentTrackListId = String(mediaPlaybackCurrentTrackList?.id || '').trim();
      const requestedTrackListId = String(mediaTrackList?.id || '').trim();
      const currentTrackStillInRequestedList = mediaTracks.some(track => String(track.id || '') === String(mediaPlaybackCurrentMediaTrack.id || ''));
      const canResumeCurrentTracklist = mediaPlaybackState === MediaEnums.MediaPlaybackState.Playing
        || mediaPlaybackState === MediaEnums.MediaPlaybackState.Paused
        || mediaPlaybackState === MediaEnums.MediaPlaybackState.Loading;
      // resume media playback if we are playing same tracklist
      if (currentTrackListId.length > 0
        && requestedTrackListId.length > 0
        && currentTrackListId === requestedTrackListId
        && currentTrackStillInRequestedList
        && canResumeCurrentTracklist) {
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
      mediaPlaybackState,
    } = mediaPlayer;

    if (mediaPlaybackCurrentMediaTrack && mediaPlaybackCurrentPlayingInstance) {
      const currentTrackListId = String(mediaPlaybackCurrentTrackList?.id || '').trim();
      const requestedTrackListId = String(mediaTrackList?.id || '').trim();
      const canResumeCurrentTrack = mediaPlaybackState === MediaEnums.MediaPlaybackState.Playing
        || mediaPlaybackState === MediaEnums.MediaPlaybackState.Paused
        || mediaPlaybackState === MediaEnums.MediaPlaybackState.Loading;
      // resume media playback if we are playing same tracklist
      if (currentTrackListId.length > 0
        && requestedTrackListId.length > 0
        && currentTrackListId === requestedTrackListId
        && mediaPlaybackCurrentMediaTrack.id === mediaTrack.id
        && canResumeCurrentTrack) {
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
    } else {
      this.lastTrackChangeInitiatedAt = Date.now();
      this.lastRendererProgressSeconds = 0;
      this.lastRendererProgressAt = 0;
      this.remoteZeroPositionPlayingSince = 0;
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

    if (DlnaService.isRemoteOutputRequested()) {
      // Optimistic UI feedback so play/pause button state updates immediately.
      store.dispatch({
        type: MediaEnums.MediaPlayerActions.PausePlayer,
      });
      this.recordUiDiagnostic('pause_requested', {
        remote: true,
        state: mediaPlayer.mediaPlaybackState,
      });
      DlnaService.pauseSelectedRenderer()
        .then(async (paused) => {
          if (!paused) {
            return;
          }
          const snapshot = await DlnaService.getSelectedRendererSnapshot().catch(() => undefined);
          const transportState = String(snapshot?.transportState || '').toUpperCase();
          if (transportState === 'PAUSED_PLAYBACK'
            || transportState === 'PAUSED'
            || transportState === 'STOPPED'
            || transportState === 'NO_MEDIA_PRESENT') {
            store.dispatch({
              type: MediaEnums.MediaPlayerActions.PausePlayer,
            });
            this.recordUiDiagnostic('pause_applied', {
              transportState,
            });
          } else if (transportState === 'TRANSITIONING') {
            store.dispatch({
              type: MediaEnums.MediaPlayerActions.LoadingTrack,
            });
          }
          this.startMediaProgressReporting();
        })
        .catch(() => undefined);
      return;
    }

    if (!mediaPlaybackCurrentMediaTrack || !mediaPlaybackCurrentPlayingInstance) {
      return;
    }
    debug('ui_pause_requested remote=%s state=%s track=%s', DlnaService.isRemoteOutputRequested(), mediaPlayer.mediaPlaybackState, mediaPlaybackCurrentMediaTrack.id);
    this.recordUiDiagnostic('pause_requested', {
      remote: DlnaService.isRemoteOutputRequested(),
      state: mediaPlayer.mediaPlaybackState,
      trackId: mediaPlaybackCurrentMediaTrack.id,
    });

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
        this.recordUiDiagnostic('pause_applied');
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

    if (DlnaService.isRemoteOutputRequested()) {
      this.lastRendererProgressSeconds = 0;
      this.lastRendererProgressAt = 0;
      this.remoteZeroPositionPlayingSince = 0;
      // Optimistic UI feedback; remote snapshot will confirm or correct shortly after.
      store.dispatch({
        type: MediaEnums.MediaPlayerActions.Play,
        data: {
          mediaPlaybackProgress: this.getCurrentPlaybackProgress(),
        },
      });
      this.recordUiDiagnostic('play_requested', {
        remote: true,
        state: mediaPlayer.mediaPlaybackState,
      });
      DlnaService.resumeSelectedRenderer()
        .then(async (resumed) => {
          if (!resumed) {
            return;
          }
          const snapshot = await DlnaService.getSelectedRendererSnapshot().catch(() => undefined);
          const transportState = String(snapshot?.transportState || '').toUpperCase();
          const rendererProgress = Number(snapshot?.positionSeconds);
          const nextProgress = Number.isFinite(rendererProgress)
            ? Math.max(0, rendererProgress)
            : this.getCurrentPlaybackProgress();
          if (transportState === 'PLAYING') {
            store.dispatch({
              type: MediaEnums.MediaPlayerActions.Play,
              data: {
                mediaPlaybackProgress: nextProgress,
              },
            });
            this.recordUiDiagnostic('play_applied', {
              transportState,
            });
          } else if (transportState === 'PAUSED_PLAYBACK' || transportState === 'PAUSED') {
            store.dispatch({
              type: MediaEnums.MediaPlayerActions.PausePlayer,
            });
          } else if (transportState === 'TRANSITIONING') {
            store.dispatch({
              type: MediaEnums.MediaPlayerActions.LoadingTrack,
            });
          }
          this.reportMediaPlaybackProgress();
        })
        .catch(() => undefined);
      return;
    }

    if (!mediaPlaybackCurrentMediaTrack || !mediaPlaybackCurrentPlayingInstance) {
      return;
    }
    debug('ui_play_requested remote=%s state=%s track=%s', DlnaService.isRemoteOutputRequested(), mediaPlayer.mediaPlaybackState, mediaPlaybackCurrentMediaTrack.id);
    this.recordUiDiagnostic('play_requested', {
      remote: DlnaService.isRemoteOutputRequested(),
      state: mediaPlayer.mediaPlaybackState,
      trackId: mediaPlaybackCurrentMediaTrack.id,
    });
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
        this.recordUiDiagnostic('play_applied');

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

  /**
   * Switches DLNA output (local ↔ renderer). Uses `await` between steps so operations stay ordered:
   * stop local playback → apply new output (`setOutputDevice` may await `startServer`/SOAP stop) →
   * optionally start playback on the new sink. Call sites use `.catch()` so the click handler returns
   * immediately; these awaits only serialize work inside this async function, not the UI thread’s sync stack.
   */
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
      if (DlnaService.isRemoteOutputRequested()) {
        this.syncPlaybackVolumeFromSelectedRenderer().catch((error) => {
          debug('switchOutputDevice - failed to sync renderer output state - %o', error);
        });
      }

      if (!mediaPlaybackCurrentMediaTrack) {
        if (DlnaService.isRemoteOutputRequested()) {
          this.startMediaProgressReporting();
        }
        return;
      }

      const mediaPlayback = this.loadMediaTrack(mediaPlaybackCurrentMediaTrack);
      if (wasPlaying) {
        let mediaPlayed = await mediaPlayback.play();
        if (!mediaPlayed && DlnaService.isRemoteOutputRequested()) {
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

    if (DlnaService.isRemoteOutputRequested()) {
      this.recordUiDiagnostic('stop_requested', {
        remote: true,
        state: mediaPlayer.mediaPlaybackState,
      });
      DlnaService.stopSelectedRenderer()
        .then(async (stopped) => {
          if (!stopped) {
            return;
          }
          const snapshot = await DlnaService.getSelectedRendererSnapshot().catch(() => undefined);
          const transportState = String(snapshot?.transportState || '').toUpperCase();
          if (transportState === 'STOPPED' || transportState === 'NO_MEDIA_PRESENT') {
            store.dispatch({
              type: MediaEnums.MediaPlayerActions.StopPlayer,
            });
            this.recordUiDiagnostic('stop_applied', {
              transportState,
            });
            this.lastRendererTransportState = 'STOPPED';
            this.lastRendererPlayingDetectedAt = 0;
            this.lastRendererProgressAt = Date.now();
            this.lastRendererProgressSeconds = 0;
            this.lastRendererProgressTrackId = undefined;
            this.remoteAutoAdvanceAwaitUntil = 0;
          } else if (transportState === 'PAUSED_PLAYBACK' || transportState === 'PAUSED') {
            store.dispatch({
              type: MediaEnums.MediaPlayerActions.PausePlayer,
            });
          } else if (transportState === 'TRANSITIONING') {
            store.dispatch({
              type: MediaEnums.MediaPlayerActions.LoadingTrack,
            });
          }
          this.startMediaProgressReporting();
        })
        .catch(() => undefined);
      return;
    }

    if (!mediaPlaybackCurrentMediaTrack || !mediaPlaybackCurrentPlayingInstance) {
      return;
    }
    debug('ui_stop_requested remote=%s state=%s track=%s', DlnaService.isRemoteOutputRequested(), mediaPlayer.mediaPlaybackState, mediaPlaybackCurrentMediaTrack.id);
    this.recordUiDiagnostic('stop_requested', {
      remote: DlnaService.isRemoteOutputRequested(),
      state: mediaPlayer.mediaPlaybackState,
      trackId: mediaPlaybackCurrentMediaTrack.id,
    });

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
        this.recordUiDiagnostic('stop_applied');
        this.lastRendererTransportState = 'STOPPED';
        this.lastRendererPlayingDetectedAt = 0;
        this.lastRendererProgressAt = Date.now();
        this.lastRendererProgressSeconds = 0;
        this.lastRendererProgressTrackId = undefined;
        this.remoteAutoAdvanceAwaitUntil = 0;
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
      debug('ui_previous_requested remote=true force=%s progress=%s', !!force, mediaPlaybackCurrentMediaProgress);
      this.lastTrackChangeInitiatedAt = Date.now();
      this.lastRendererProgressSeconds = 0;
      this.lastRendererProgressAt = 0;
      this.remoteZeroPositionPlayingSince = 0;
      this.recordUiDiagnostic('previous_requested', {
        force: !!force,
        progress: mediaPlaybackCurrentMediaProgress,
      });
      if (!this.hasPreviousTrack() || (!force
        && mediaPlaybackCurrentMediaTrack
        && mediaPlaybackCurrentMediaProgress
        && mediaPlaybackCurrentMediaProgress > 15)) {
        this.seekMediaTrack(0);
      } else if (!DlnaService.shouldUseSelectedRendererQueueContext()) {
        this.playPrevious();
      } else {
        DlnaService.previousSelectedRenderer()
          .then((switched) => {
            if (!switched) {
              this.playPrevious();
            }
          })
          .catch(() => {
            this.playPrevious();
          });
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
    debug('ui_next_requested remote=%s', DlnaService.isRemoteOutputRequested());
    this.recordUiDiagnostic('next_requested', {
      remote: DlnaService.isRemoteOutputRequested(),
    });
    if (DlnaService.isRemoteOutputRequested()) {
      this.lastTrackChangeInitiatedAt = Date.now();
      this.lastRendererProgressSeconds = 0;
      this.lastRendererProgressAt = 0;
      this.remoteZeroPositionPlayingSince = 0;
      this.removeTrackRepeat();
      if (!DlnaService.shouldUseSelectedRendererQueueContext()) {
        this.playNext();
      } else {
        DlnaService.nextSelectedRenderer()
          .then((switched) => {
            if (!switched) {
              this.playNext();
            }
          })
          .catch(() => {
            this.playNext();
          });
      }
      return;
    }
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
    this.remoteAutoAdvanceAwaitUntil = 0;

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
      mediaPlaybackCurrentMediaProgress = 0,
    } = mediaPlayer;

    if (!mediaPlaybackCurrentMediaTrack || !mediaPlaybackCurrentPlayingInstance) {
      if (DlnaService.isRemoteOutputRequested()) {
        if (this.backsyncCurrentTrackFromSelectedRenderer()) {
          this.startMediaProgressReporting();
          return;
        }
        DlnaService.getSelectedRendererSnapshot()
          .then((snapshot) => {
            if (!snapshot) {
              this.startMediaProgressReporting();
              return;
            }
            const controlSnapshot = DlnaService.applyRecentGenaOverrideToSoapSnapshot(snapshot);
            const transportState = String(controlSnapshot.transportState || '').toUpperCase();
            const now = Date.now();
            const rendererProgress = Number(controlSnapshot.positionSeconds);
            if (transportState) {
              this.lastRendererTransportState = transportState;
            }
            if (transportState === 'PLAYING') {
              this.lastRendererPlayingDetectedAt = now;
              this.lastTrackChangeInitiatedAt = 0;
            }
            const nextProgress = Number.isFinite(rendererProgress)
              ? Math.max(0, rendererProgress)
              : Math.max(0, this.lastRendererProgressSeconds || 0);
            if (transportState === 'PLAYING') {
              this.lastRendererProgressSeconds = nextProgress;
              this.lastRendererProgressAt = now;
              this.lastRendererProgressTrackId = this.resolveRendererTrackContextId(controlSnapshot.currentTrackUri, mediaPlaybackCurrentMediaTrack);
              store.dispatch({
                type: MediaEnums.MediaPlayerActions.UpdatePlaybackProgress,
                data: {
                  mediaPlaybackState: MediaEnums.MediaPlaybackState.Playing,
                  mediaPlaybackProgress: nextProgress,
                },
              });
            } else if (transportState === 'PAUSED_PLAYBACK' || transportState === 'PAUSED') {
              this.lastRendererProgressSeconds = nextProgress;
              this.lastRendererProgressAt = now;
              this.lastRendererProgressTrackId = this.resolveRendererTrackContextId(controlSnapshot.currentTrackUri, mediaPlaybackCurrentMediaTrack);
              store.dispatch({
                type: MediaEnums.MediaPlayerActions.UpdatePlaybackProgress,
                data: {
                  mediaPlaybackState: MediaEnums.MediaPlaybackState.Paused,
                  mediaPlaybackProgress: nextProgress,
                },
              });
            } else if (transportState === 'STOPPED' || transportState === 'NO_MEDIA_PRESENT') {
              this.lastRendererProgressSeconds = Math.max(0, nextProgress);
              this.lastRendererProgressAt = now;
              this.lastRendererProgressTrackId = this.resolveRendererTrackContextId(controlSnapshot.currentTrackUri, mediaPlaybackCurrentMediaTrack);
              store.dispatch({
                type: MediaEnums.MediaPlayerActions.UpdatePlaybackProgress,
                data: {
                  mediaPlaybackState: MediaEnums.MediaPlaybackState.Paused,
                  mediaPlaybackProgress: Math.max(0, nextProgress),
                },
              });
            }
            this.startMediaProgressReporting();
          })
          .catch(() => {
            this.startMediaProgressReporting();
          });
        return;
      }
      debug('reportMediaPlaybackProgress - no running media instance found, aborting...');
      return;
    }

    const mediaPlaybackProgress = this.getCurrentPlaybackProgress();
    if (DlnaService.isRemoteOutputRequested()) {
      if (this.backsyncCurrentTrackFromSelectedRenderer()) {
        this.startMediaProgressReporting();
        return;
      }
      this.syncPlaybackVolumeFromSelectedRenderer({
        fetchSnapshot: false,
      }).catch(() => undefined);
      DlnaService.getSelectedRendererSnapshot()
        .then((snapshot) => {
          if (!DlnaService.isRemoteOutputRequested()) {
            return;
          }
          const { mediaPlayer: currentMediaPlayer } = store.getState();
          if (currentMediaPlayer.mediaPlaybackCurrentPlayingInstance !== mediaPlaybackCurrentPlayingInstance) {
            return;
          }
          if (!snapshot) {
            this.inferRemotePlaybackWhenSnapshotMissing(
              mediaPlaybackCurrentMediaTrack,
              Number(mediaPlaybackCurrentMediaProgress || 0),
            );
            this.startMediaProgressReporting();
            return;
          }
          const soapSnapshot = snapshot;
          const controlSnapshot = DlnaService.applyRecentGenaOverrideToSoapSnapshot(soapSnapshot);
          const soapTransportForDiag = String(soapSnapshot.transportState || '').toUpperCase();
          (mediaPlaybackCurrentPlayingInstance as any).adoptRemoteSnapshot?.(controlSnapshot);
          if (this.backsyncCurrentTrackFromSelectedRenderer()) {
            this.startMediaProgressReporting();
            return;
          }
          const transportState = String(controlSnapshot.transportState || '').toUpperCase();
          const rendererProgress = Number(controlSnapshot.positionSeconds);
          const now = Date.now();
          const rendererTrackContextId = this.resolveRendererTrackContextId(
            controlSnapshot.currentTrackUri,
            mediaPlaybackCurrentMediaTrack,
          );
          if (transportState) {
            this.lastRendererTransportState = transportState;
          }
          if (transportState === 'TRANSITIONING') {
            if (this.remoteTransitioningSinceMs <= 0) {
              this.remoteTransitioningSinceMs = now;
            }
          } else {
            this.remoteTransitioningSinceMs = 0;
          }
          if (transportState === 'PLAYING') {
            this.lastRendererPlayingDetectedAt = now;
          }
          const remoteTransportActive = transportState === 'PLAYING' || transportState === 'TRANSITIONING';
          const rendererBogusZero = remoteTransportActive
            && Number.isFinite(rendererProgress)
            && rendererProgress < 0.05
            && this.lastRendererProgressSeconds > 1
            && (now - this.lastRendererProgressAt) < 45000
            && this.lastRendererProgressAt > 0
            && (!rendererTrackContextId
              || !this.lastRendererProgressTrackId
              || rendererTrackContextId === this.lastRendererProgressTrackId);
          const untrustedSoapZero = Number.isFinite(rendererProgress)
            && rendererProgress < 0.05
            && remoteTransportActive
            && !rendererBogusZero;
          if (untrustedSoapZero && remoteTransportActive && this.lastRendererProgressAt <= 0) {
            this.lastRendererProgressAt = now;
            this.lastRendererProgressSeconds = Math.max(0, Number(mediaPlaybackCurrentMediaProgress || 0));
            this.lastRendererProgressTrackId = rendererTrackContextId || this.lastRendererProgressTrackId;
          }
          if (Number.isFinite(rendererProgress) && !rendererBogusZero && !untrustedSoapZero) {
            this.lastRendererProgressSeconds = Math.max(0, rendererProgress);
            this.lastRendererProgressAt = now;
            this.lastRendererProgressTrackId = rendererTrackContextId || this.lastRendererProgressTrackId;
          } else if (!Number.isFinite(rendererProgress) && (transportState === 'PLAYING' || transportState === 'TRANSITIONING')) {
            const seededProgress = Math.max(0, Number(mediaPlaybackCurrentMediaProgress || 0));
            if (this.lastRendererProgressAt <= 0 || this.lastRendererProgressSeconds <= 0) {
              this.lastRendererProgressSeconds = seededProgress;
              this.lastRendererProgressAt = now;
              this.lastRendererProgressTrackId = rendererTrackContextId || this.lastRendererProgressTrackId;
            }
          }
          let inferredProgress = mediaPlaybackCurrentMediaProgress;
          if (Number.isFinite(rendererProgress) && !rendererBogusZero && !untrustedSoapZero) {
            inferredProgress = Math.max(0, rendererProgress);
          } else if (
            rendererBogusZero
            || untrustedSoapZero
            || (!Number.isFinite(rendererProgress)
              && (
                (transportState || this.lastRendererTransportState) === 'PLAYING'
                || (transportState || this.lastRendererTransportState) === 'TRANSITIONING'
              )
              && this.lastRendererProgressAt > 0)
          ) {
            const elapsedSinceLastRendererProgress = Math.max(0, (now - this.lastRendererProgressAt) / 1000);
            inferredProgress = Math.max(0, this.lastRendererProgressSeconds + elapsedSinceLastRendererProgress);
          }
          const trackDuration = Number(mediaPlaybackCurrentMediaTrack.track_duration || 0);
          if (Number.isFinite(trackDuration) && trackDuration > 0) {
            inferredProgress = Math.min(inferredProgress, trackDuration);
          }
          let nextProgress = (Number.isFinite(rendererProgress) && !rendererBogusZero && !untrustedSoapZero)
            ? Math.max(0, rendererProgress)
            : inferredProgress;
          if (remoteTransportActive && Number.isFinite(rendererProgress) && rendererProgress < 0.5 && !rendererBogusZero) {
            if (this.remoteZeroPositionPlayingSince <= 0) {
              this.remoteZeroPositionPlayingSince = now;
            }
            const zeroPosElapsedMs = now - this.remoteZeroPositionPlayingSince;
            if (zeroPosElapsedMs > 3000) {
              nextProgress = Math.max(0, zeroPosElapsedMs / 1000);
              if (trackDuration > 0) {
                nextProgress = Math.min(nextProgress, trackDuration);
              }
              this.lastRendererProgressSeconds = nextProgress;
              this.lastRendererProgressAt = now;
            }
          } else if (rendererBogusZero) {
            this.remoteZeroPositionPlayingSince = 0;
          } else if (rendererProgress >= 0.5
            || !remoteTransportActive) {
            this.remoteZeroPositionPlayingSince = 0;
          }
          if (transportState === 'PLAYING'
            || transportState === 'TRANSITIONING'
            || remoteTransportActive) {
            const modelProgress = this.getCurrentPlaybackProgressSafe(mediaPlaybackCurrentPlayingInstance as IMediaPlayback);
            nextProgress = Math.max(nextProgress, modelProgress);
            if (Number.isFinite(trackDuration) && trackDuration > 0) {
              nextProgress = Math.min(nextProgress, trackDuration);
            }
          }
          if (mediaPlaybackCurrentPlayingInstance) {
            const inst = mediaPlaybackCurrentPlayingInstance as any;
            if (typeof inst.remotePlaybackPausedProgress === 'number' && nextProgress > inst.remotePlaybackPausedProgress) {
              inst.remotePlaybackPausedProgress = nextProgress;
              inst.remotePlaybackLastSnapshotSeconds = nextProgress;
            }
          }
          const holdPlayingState = this.shouldHoldRemotePlayingState(transportState, controlSnapshot.currentTrackUri);
          const diagNow = Date.now();
          if (diagNow - this.lastRemoteProgressDiagLogAt >= 2500) {
            this.lastRemoteProgressDiagLogAt = diagNow;
            DlnaService.logRemoteMediaPlayerDiag('remote_progress_report', {
              transportState,
              soapTransportState: soapTransportForDiag || undefined,
              soapPositionSeconds: Number.isFinite(Number(soapSnapshot.positionSeconds))
                ? Number(soapSnapshot.positionSeconds)
                : undefined,
              nextProgress,
              untrustedSoapZero,
              rendererBogusZero,
              holdPlayingState,
              lastPlayingDetectedAgeMs: this.lastRendererPlayingDetectedAt
                ? diagNow - this.lastRendererPlayingDetectedAt
                : undefined,
              eventTransportState: DlnaService.getSelectedRendererRecentEventTransportState(120000) || undefined,
            });
          }
          if (transportState === 'PLAYING') {
            this.remoteAutoAdvanceAwaitUntil = 0;
            this.lastRendererPlayingDetectedAt = now;
            this.lastTrackChangeInitiatedAt = 0;
            if (trackDuration > 0 && nextProgress >= trackDuration - 1.5) {
              this.remoteZeroPositionPlayingSince = 0;
              this.lastRendererPlayingDetectedAt = 0;
              this.incrementTrackPlayCount(mediaPlaybackCurrentMediaTrack);
              this.playNext();
              return;
            }
            this.updateMediaPlaybackProgress(nextProgress);
            this.syncSelectedRendererNextTrack({
              currentTrack: mediaPlaybackCurrentMediaTrack,
              currentProgress: nextProgress,
            });
          } else if (transportState === 'PAUSED_PLAYBACK' || transportState === 'PAUSED') {
            this.remoteZeroPositionPlayingSince = 0;
            store.dispatch({
              type: MediaEnums.MediaPlayerActions.UpdatePlaybackProgress,
              data: {
                mediaPlaybackState: MediaEnums.MediaPlaybackState.Paused,
                mediaPlaybackProgress: nextProgress,
              },
            });
          } else if (transportState === 'STOPPED' || transportState === 'NO_MEDIA_PRESENT') {
            this.remoteZeroPositionPlayingSince = 0;
            if (holdPlayingState) {
              this.lastRendererTransportState = 'PLAYING';
              this.lastRendererPlayingDetectedAt = now;
              this.updateMediaPlaybackProgress(nextProgress);
              this.startMediaProgressReporting();
              return;
            }
            const evStillPlaying = DlnaService.getSelectedRendererRecentEventTransportState(120000);
            const shouldLogSoapPause = (now - this.lastRemoteUiPausedFromSoapLogAt) >= 12000
              && evStillPlaying !== 'PLAYING'
              && evStillPlaying !== 'TRANSITIONING';
            if (shouldLogSoapPause) {
              this.lastRemoteUiPausedFromSoapLogAt = now;
              DlnaService.logRemoteMediaPlayerDiag('remote_ui_paused_from_soap_stopped', {
                soapTransportState: soapTransportForDiag || undefined,
                effectiveTransportState: transportState,
                nextProgress,
                lastPlayingDetectedAgeMs: this.lastRendererPlayingDetectedAt
                  ? now - this.lastRendererPlayingDetectedAt
                  : undefined,
                eventTransportState: evStillPlaying || undefined,
              });
            }
            this.remoteAutoAdvanceAwaitUntil = 0;
            this.lastRendererProgressAt = now;
            this.lastRendererProgressSeconds = Math.max(0, nextProgress);
            this.lastRendererProgressTrackId = rendererTrackContextId || this.lastRendererProgressTrackId;
            store.dispatch({
              type: MediaEnums.MediaPlayerActions.UpdatePlaybackProgress,
              data: {
                mediaPlaybackState: MediaEnums.MediaPlaybackState.Paused,
                mediaPlaybackProgress: Math.max(0, nextProgress),
              },
            });
          } else if (transportState === 'TRANSITIONING') {
            if (!mediaPlaybackCurrentMediaTrack) {
              store.dispatch({
                type: MediaEnums.MediaPlayerActions.LoadingTrack,
              });
            } else {
              const remoteInstanceIsPlaying = !!(mediaPlaybackCurrentPlayingInstance as any).checkIfPlaying?.();
              if (remoteInstanceIsPlaying) {
                this.lastRendererPlayingDetectedAt = now;
              }
              this.updateMediaPlaybackProgress(nextProgress);
              this.syncSelectedRendererNextTrack({
                currentTrack: mediaPlaybackCurrentMediaTrack,
                currentProgress: nextProgress,
              });
              if (Number.isFinite(trackDuration) && trackDuration > 0 && nextProgress >= trackDuration - 1.5) {
                this.remoteTransitioningSinceMs = 0;
                this.remoteZeroPositionPlayingSince = 0;
                this.lastRendererPlayingDetectedAt = 0;
                this.incrementTrackPlayCount(mediaPlaybackCurrentMediaTrack);
                this.playNext();
                return;
              }
              const stuckTransitioningMs = this.remoteTransitioningSinceMs > 0
                ? now - this.remoteTransitioningSinceMs
                : 0;
              const nudgeCooldownOk = !this.lastStuckTransitioningPlayNudgeAt
                || (now - this.lastStuckTransitioningPlayNudgeAt) >= 18000;
              if (stuckTransitioningMs >= 12000 && nudgeCooldownOk) {
                this.lastStuckTransitioningPlayNudgeAt = now;
                this.remoteTransitioningSinceMs = now;
                DlnaService.logRemoteMediaPlayerDiag('remote_stuck_transitioning_play_nudge', {
                  stuckTransitioningMs,
                  nextProgress,
                  trackDuration: trackDuration > 0 ? trackDuration : undefined,
                });
                DlnaService.resumeSelectedRenderer().catch(() => undefined);
              }
            }
          } else if (
            this.lastRendererTransportState === 'PLAYING'
            && (now - this.lastRendererPlayingDetectedAt) <= this.remotePlayingInferenceGraceMs
          ) {
            this.lastRendererPlayingDetectedAt = now;
            this.updateMediaPlaybackProgress(nextProgress);
          } else if (this.lastRendererTransportState === 'PAUSED_PLAYBACK' || this.lastRendererTransportState === 'PAUSED') {
            store.dispatch({
              type: MediaEnums.MediaPlayerActions.UpdatePlaybackProgress,
              data: {
                mediaPlaybackState: MediaEnums.MediaPlaybackState.Paused,
                mediaPlaybackProgress: nextProgress,
              },
            });
          } else {
            this.updateMediaPlaybackProgress(nextProgress, true);
          }
          this.startMediaProgressReporting();
        })
        .catch(() => {
          const now = Date.now();
          if (this.lastRendererTransportState === 'PLAYING' || (now - this.lastRendererPlayingDetectedAt) <= this.remotePlayingInferenceGraceMs) {
            const elapsedSinceLastRendererProgress = this.lastRendererProgressAt > 0
              ? Math.max(0, (now - this.lastRendererProgressAt) / 1000)
              : 0;
            const inferredProgress = Math.max(0, this.lastRendererProgressSeconds + elapsedSinceLastRendererProgress);
            this.updateMediaPlaybackProgress(inferredProgress);
          } else if (this.lastRendererTransportState === 'PAUSED_PLAYBACK' || this.lastRendererTransportState === 'PAUSED') {
            store.dispatch({
              type: MediaEnums.MediaPlayerActions.UpdatePlaybackProgress,
              data: {
                mediaPlaybackState: MediaEnums.MediaPlaybackState.Paused,
                mediaPlaybackProgress: Math.max(0, this.lastRendererProgressSeconds),
              },
            });
          }
          this.startMediaProgressReporting();
        });
      return;
    }

    if (mediaPlaybackCurrentPlayingInstance.checkIfPlaying()) {
      this.remoteAutoAdvanceAwaitUntil = 0;
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
      if (DlnaService.isRemoteOutputRequested()) {
        const now = Date.now();
        if (this.remoteAutoAdvanceAwaitUntil <= 0) {
          this.remoteAutoAdvanceAwaitUntil = now + 15000;
          this.syncSelectedRendererNextTrack({
            force: true,
            currentTrack: mediaPlaybackCurrentMediaTrack,
            currentProgress: mediaPlaybackProgress,
          });
          this.startMediaProgressReporting();
          return;
        }
        if (now < this.remoteAutoAdvanceAwaitUntil) {
          this.startMediaProgressReporting();
          return;
        }
        this.remoteAutoAdvanceAwaitUntil = 0;
      }
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
              || transportState === 'PAUSED') {
              store.dispatch({
                type: MediaEnums.MediaPlayerActions.PausePlayer,
              });
            } else if (transportState === 'STOPPED'
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
  private inferRemotePlaybackWhenSnapshotMissing(mediaPlaybackCurrentMediaTrack: IMediaQueueTrack, mediaPlaybackCurrentMediaProgress: number) {
    const now = Date.now();
    const { mediaPlayer } = store.getState();
    const storeProgress = Math.max(0, Number(mediaPlaybackCurrentMediaProgress || 0));
    const trackDuration = Number(mediaPlaybackCurrentMediaTrack.track_duration || 0);
    const withinPlayingGrace = (now - this.lastRendererPlayingDetectedAt) <= this.remotePlayingInferenceGraceMs;
    const looksPlaying = mediaPlayer.mediaPlaybackState === MediaEnums.MediaPlaybackState.Playing
      || this.lastRendererTransportState === 'PLAYING'
      || withinPlayingGrace;
    if (looksPlaying && this.lastRendererTransportState !== 'PAUSED_PLAYBACK' && this.lastRendererTransportState !== 'PAUSED') {
      let inferred = storeProgress;
      if (this.lastRendererProgressAt > 0) {
        const elapsedSinceLastRendererProgress = Math.max(0, (now - this.lastRendererProgressAt) / 1000);
        inferred = Math.max(0, this.lastRendererProgressSeconds + elapsedSinceLastRendererProgress);
      }
      if (Number.isFinite(trackDuration) && trackDuration > 0) {
        inferred = Math.min(inferred, trackDuration);
      }
      this.updateMediaPlaybackProgress(inferred);
      return;
    }
    if (this.lastRendererTransportState === 'PAUSED_PLAYBACK' || this.lastRendererTransportState === 'PAUSED') {
      store.dispatch({
        type: MediaEnums.MediaPlayerActions.UpdatePlaybackProgress,
        data: {
          mediaPlaybackState: MediaEnums.MediaPlaybackState.Paused,
          mediaPlaybackProgress: Math.max(0, this.lastRendererProgressSeconds),
        },
      });
    }
  }

  private extractTrackIdFromRendererTrackUri(trackUri?: string): string | undefined {
    const normalizedTrackUri = String(trackUri || '').trim();
    if (!normalizedTrackUri) {
      return undefined;
    }
    const streamMatch = normalizedTrackUri.match(/\/stream\/([^/?#]+)/i);
    return streamMatch?.[1] ? decodeURIComponent(streamMatch[1]) : undefined;
  }

  private resolveRendererTrackContextId(trackUri?: string, fallbackTrack?: IMediaQueueTrack): string {
    const trackIdFromUri = this.extractTrackIdFromRendererTrackUri(trackUri);
    if (trackIdFromUri) {
      return trackIdFromUri;
    }
    return String(
      DlnaService.getSelectedRendererCurrentTrackId()
      || fallbackTrack?.id
      || '',
    ).trim();
  }

  private shouldHoldRemotePlayingState(transportState: string, trackUri?: string): boolean {
    if (transportState !== 'STOPPED' && transportState !== 'NO_MEDIA_PRESENT') {
      return false;
    }
    const now = Date.now();
    if (this.lastTrackChangeInitiatedAt > 0
      && (now - this.lastTrackChangeInitiatedAt) < this.trackChangeBacksyncSuppressMs) {
      return true;
    }
    /** Eversolo and similar devices may emit STOPPED/empty URI for many seconds during gapless or bad SOAP; keep UI in Playing longer. */
    const evTs = DlnaService.getSelectedRendererRecentEventTransportState(120000);
    const eventImpliesPlayback = evTs === 'PLAYING' || evTs === 'TRANSITIONING';
    const recentSoapPlaying = this.lastRendererPlayingDetectedAt > 0
      && (now - this.lastRendererPlayingDetectedAt) <= 300000;
    const recentPlayback = recentSoapPlaying || eventImpliesPlayback;
    if (!recentPlayback) {
      return false;
    }
    const resolvedId = this.resolveRendererTrackContextId(trackUri);
    if (resolvedId) {
      return true;
    }
    if (DlnaService.getSelectedRendererPendingNextTrackId()) {
      return true;
    }
    const { mediaPlayer } = store.getState();
    const isPlaying = mediaPlayer.mediaPlaybackState === MediaEnums.MediaPlaybackState.Playing
      || mediaPlayer.mediaPlaybackState === MediaEnums.MediaPlaybackState.Loading;
    if (isPlaying && recentPlayback) {
      return true;
    }
    return false;
  }

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
    this.recordUiDiagnostic('progress_applied', {
      playbackState: nextPlaybackState,
      progress: mediaPlaybackProgress,
      seeking: !!seeking,
    });
  }

  private recordUiDiagnostic(event: string, details?: Record<string, any>) {
    if (!DlnaService.isRemoteOutputRequested()) {
      return;
    }
    const state = store.getState().mediaPlayer;
    const snapshot = {
      playbackState: state.mediaPlaybackState,
      progress: state.mediaPlaybackCurrentMediaProgress,
      trackId: state.mediaPlaybackCurrentMediaTrack?.id,
      queueEntryId: state.mediaPlaybackCurrentMediaTrack?.queue_entry_id,
      rendererState: this.lastRendererTransportState,
    };
    const dedupeKey = `${event}|${snapshot.playbackState}|${Math.floor(Number(snapshot.progress || 0))}|${snapshot.trackId || ''}|${snapshot.rendererState || ''}`;
    if (event === 'progress_applied' && dedupeKey === this.lastUiDiagnosticsState) {
      return;
    }
    this.lastUiDiagnosticsState = dedupeKey;
    DlnaService.recordControllerDiagnostic(event, {
      ...snapshot,
      ...(details || {}),
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

  private backsyncCurrentTrackFromSelectedRenderer(): boolean {
    if (!DlnaService.isRemoteOutputRequested()) {
      return false;
    }
    const { mediaPlayer } = store.getState();
    const {
      mediaTracks,
      mediaPlaybackCurrentMediaTrack,
      mediaPlaybackCurrentPlayingInstance,
    } = mediaPlayer;
    const rendererTrackId = String(DlnaService.getSelectedRendererCurrentTrackId() || '').trim();
    if (!rendererTrackId) {
      return false;
    }
    const uiId = String(mediaPlaybackCurrentMediaTrack?.id || '').trim();
    const uiProvider = String((mediaPlaybackCurrentMediaTrack as { provider_id?: string } | undefined)?.provider_id || '').trim();
    const remoteAheadOfUi = !mediaPlaybackCurrentMediaTrack
      || (rendererTrackId !== uiId && rendererTrackId !== uiProvider);
    if (!remoteAheadOfUi
      && this.lastTrackChangeInitiatedAt > 0
      && (Date.now() - this.lastTrackChangeInitiatedAt) < this.trackChangeBacksyncSuppressMs) {
      return false;
    }
    if (mediaPlaybackCurrentMediaTrack && rendererTrackId === String(mediaPlaybackCurrentMediaTrack.id || '')) {
      return false;
    }
    const targetTrack = _.find(
      mediaTracks,
      track => String(track.id || '') === rendererTrackId || String((track as any).provider_id || '') === rendererTrackId,
    );
    if (!targetTrack) {
      return false;
    }
    debug('backsyncCurrentTrackFromSelectedRenderer - switching current track from renderer', {
      rendererTrackId,
      previousTrackId: String(mediaPlaybackCurrentMediaTrack?.id || ''),
      queueEntryId: targetTrack.queue_entry_id,
    });
    (mediaPlaybackCurrentPlayingInstance as any)?.deactivateRemotePolling?.();
    const nextPlaybackInstance = this.createMediaPlayback(targetTrack, true) as any;
    DlnaService.getSelectedRendererSnapshot()
      .then((snapshot) => {
        nextPlaybackInstance.adoptRemoteSnapshot?.(snapshot);
        const snapshotProgress = Number(snapshot?.positionSeconds || 0);
        this.lastRendererProgressTrackId = String(targetTrack.id || rendererTrackId || '').trim() || undefined;
        this.lastRendererProgressSeconds = Number.isFinite(snapshotProgress) ? Math.max(0, snapshotProgress) : 0;
        this.lastRendererProgressAt = Date.now();
        store.dispatch({
          type: MediaEnums.MediaPlayerActions.Play,
          data: {
            mediaPlaybackProgress: Number.isFinite(snapshotProgress) ? Math.max(0, snapshotProgress) : 0,
          },
        });
      })
      .catch(() => {
        nextPlaybackInstance.adoptRemoteSnapshot?.();
        this.lastRendererProgressTrackId = String(targetTrack.id || rendererTrackId || '').trim() || undefined;
        this.lastRendererProgressSeconds = 0;
        this.lastRendererProgressAt = Date.now();
      });
    store.dispatch({
      type: MediaEnums.MediaPlayerActions.LoadTrack,
      data: {
        mediaQueueTrackEntryId: targetTrack.queue_entry_id,
        mediaPlayingInstance: nextPlaybackInstance,
      },
    });
    store.dispatch({
      type: MediaEnums.MediaPlayerActions.Play,
      data: {
        mediaPlaybackProgress: 0,
      },
    });
    this.lastDlnaNextTrackSyncAt = 0;
    this.lastDlnaNextTrackQueueEntryId = undefined;
    this.lastDlnaNextSyncPairKey = '';
    this.lastDlnaQueueContextPublishAt = 0;
    this.lastDlnaQueueContextPublishSignature = undefined;
    this.syncSelectedRendererNextTrack({
      force: true,
      currentTrack: targetTrack,
      currentProgress: 0,
    });
    return true;
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

  private getNextFromListForTrack(mediaQueueTrack?: IMediaQueueTrack): IMediaQueueTrack | undefined {
    if (!mediaQueueTrack) {
      return this.getNextFromList();
    }
    const {
      mediaPlayer,
    } = store.getState();
    const {
      mediaTracks,
    } = mediaPlayer;
    const currentTrackPointer = _.findIndex(
      mediaTracks,
      track => track.queue_entry_id === mediaQueueTrack.queue_entry_id,
    );
    if (_.isNil(currentTrackPointer) || currentTrackPointer < 0 || currentTrackPointer >= (mediaTracks.length - 1)) {
      return undefined;
    }
    return mediaTracks[currentTrackPointer + 1];
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
    const remoteConnectionEstablished = previousState.outputMode !== 'remote'
      && nextState.outputMode === 'remote'
      && !!nextState.selectedRendererId;
    if (remoteConnectionEstablished) {
      this.startMediaProgressReporting();
    }
    const remoteConnectionLost = previousState.outputMode === 'remote'
      && !!previousState.selectedRendererId
      && nextState.outputMode === 'local';
    if (nextState.outputMode !== 'remote' || !nextState.selectedRendererId) {
      this.lastDlnaContextKey = undefined;
      this.lastDlnaNextTrackSyncAt = 0;
      this.lastDlnaNextTrackQueueEntryId = undefined;
      this.lastDlnaNextSyncPairKey = '';
      this.lastDlnaQueueContextPublishAt = 0;
      this.lastDlnaQueueContextPublishSignature = undefined;
      this.lockedDlnaContextTracklistId = undefined;
      this.remoteTransitioningSinceMs = 0;
      this.lastStuckTransitioningPlayNudgeAt = 0;
    }
    if (!remoteConnectionLost || this.outputSwitchInProgress) {
      return;
    }
    const { mediaPlayer } = store.getState();
    if (!mediaPlayer.mediaPlaybackCurrentPlayingInstance || !mediaPlayer.mediaPlaybackCurrentMediaTrack) {
      return;
    }
    store.dispatch({
      type: MediaEnums.MediaPlayerActions.PausePlayer,
    });
    this.switchOutputDevice('local').catch((error) => {
      debug('handleDlnaStateChanged - failed switching output to local after disconnect - %o', error);
    });
  }

  private dlnaRendererIdsMatch(selectedId: string, snapshotId: string): boolean {
    const norm = (id: string) => String(id || '').trim().toLowerCase().replace(/^uuid:/i, '');
    const a = norm(selectedId);
    const b = norm(snapshotId);
    return Boolean(a && b && a === b);
  }

  private handleDlnaRendererSnapshot(snapshot: DlnaRendererEventSnapshot) {
    if (!DlnaService.isRemoteOutputRequested()) {
      return;
    }
    const selectedRendererId = String(DlnaService.getState().selectedRendererId || '');
    if (!this.dlnaRendererIdsMatch(selectedRendererId, String(snapshot.rendererId || ''))) {
      return;
    }
    const now = Date.now();
    const transportState = String(snapshot.transportState || '').toUpperCase();
    const positionSeconds = Number(snapshot.positionSeconds);
    const { mediaPlayer } = store.getState();
    const rendererTrackContextId = this.resolveRendererTrackContextId(
      snapshot.currentTrackUri,
      mediaPlayer.mediaPlaybackCurrentMediaTrack,
    );
    if (transportState) {
      this.lastRendererTransportState = transportState;
    }
    if (transportState === 'PLAYING') {
      this.lastRendererPlayingDetectedAt = now;
      this.lastTrackChangeInitiatedAt = 0;
    }
    let progressFromSnapshot: number;
    if (Number.isFinite(positionSeconds)) {
      const eventUntrustedZero = transportState === 'PLAYING'
        && positionSeconds < 0.05
        && (!rendererTrackContextId
          || !this.lastRendererProgressTrackId
          || rendererTrackContextId === this.lastRendererProgressTrackId);
      if (eventUntrustedZero && this.lastRendererProgressAt <= 0) {
        this.lastRendererProgressAt = now;
        this.lastRendererProgressSeconds = Math.max(0, Number(mediaPlayer.mediaPlaybackCurrentMediaProgress || 0));
        this.lastRendererProgressTrackId = rendererTrackContextId || this.lastRendererProgressTrackId;
      }
      const bogusZero = transportState === 'PLAYING'
        && positionSeconds < 0.05
        && this.lastRendererProgressSeconds > 1
        && (now - this.lastRendererProgressAt) < 45000
        && this.lastRendererProgressAt > 0
        && (!rendererTrackContextId
          || !this.lastRendererProgressTrackId
          || rendererTrackContextId === this.lastRendererProgressTrackId);
      if (bogusZero || (eventUntrustedZero && this.lastRendererProgressAt > 0)) {
        const elapsed = Math.max(0, (now - this.lastRendererProgressAt) / 1000);
        progressFromSnapshot = Math.max(0, this.lastRendererProgressSeconds + elapsed);
      } else {
        this.lastRendererProgressSeconds = Math.max(0, positionSeconds);
        this.lastRendererProgressAt = now;
        this.lastRendererProgressTrackId = rendererTrackContextId || this.lastRendererProgressTrackId;
        progressFromSnapshot = positionSeconds;
      }
    } else {
      progressFromSnapshot = NaN;
    }
    const playingInstance = mediaPlayer.mediaPlaybackCurrentPlayingInstance as {
      adoptRemoteSnapshot?: (s?: { transportState?: string; positionSeconds?: number }) => void;
    } | undefined;
    if (
      playingInstance?.adoptRemoteSnapshot
      && (snapshot.transportState || Number.isFinite(positionSeconds))
    ) {
      const adoptPayload: { transportState?: string; positionSeconds?: number } = {};
      if (snapshot.transportState) {
        adoptPayload.transportState = snapshot.transportState;
      }
      if (Number.isFinite(positionSeconds)) {
        adoptPayload.positionSeconds = Math.max(0, progressFromSnapshot);
      }
      playingInstance.adoptRemoteSnapshot(adoptPayload);
    }
    let progress = Number.isFinite(positionSeconds)
      ? Math.max(0, progressFromSnapshot)
      : Math.max(0, Number(mediaPlayer.mediaPlaybackCurrentMediaProgress || 0));
    if (transportState === 'PLAYING' && !Number.isFinite(positionSeconds) && this.lastRendererProgressAt > 0) {
      progress = Math.max(
        progress,
        this.lastRendererProgressSeconds + Math.max(0, (now - this.lastRendererProgressAt) / 1000),
      );
    }
    const shouldAttemptTrackBacksync = !!String(snapshot.currentTrackUri || '').trim()
      || transportState === 'PLAYING'
      || transportState === 'PAUSED_PLAYBACK'
      || transportState === 'PAUSED'
      || transportState === 'TRANSITIONING';
    if (transportState === 'PLAYING') {
      store.dispatch({
        type: MediaEnums.MediaPlayerActions.UpdatePlaybackProgress,
        data: {
          mediaPlaybackState: MediaEnums.MediaPlaybackState.Playing,
          mediaPlaybackProgress: progress,
        },
      });
    } else if (transportState === 'PAUSED_PLAYBACK' || transportState === 'PAUSED') {
      store.dispatch({
        type: MediaEnums.MediaPlayerActions.UpdatePlaybackProgress,
        data: {
          mediaPlaybackState: MediaEnums.MediaPlaybackState.Paused,
          mediaPlaybackProgress: progress,
        },
      });
    } else if (transportState === 'STOPPED' || transportState === 'NO_MEDIA_PRESENT') {
      if (this.shouldHoldRemotePlayingState(transportState, snapshot.currentTrackUri)) {
        store.dispatch({
          type: MediaEnums.MediaPlayerActions.UpdatePlaybackProgress,
          data: {
            mediaPlaybackState: MediaEnums.MediaPlaybackState.Playing,
            mediaPlaybackProgress: Math.max(0, progress),
          },
        });
        if (shouldAttemptTrackBacksync) {
          this.backsyncCurrentTrackFromSelectedRenderer();
        }
        return;
      }
      store.dispatch({
        type: MediaEnums.MediaPlayerActions.UpdatePlaybackProgress,
        data: {
          mediaPlaybackState: MediaEnums.MediaPlaybackState.Paused,
          mediaPlaybackProgress: Math.max(0, progress),
        },
      });
    } else if (transportState === 'TRANSITIONING') {
      store.dispatch({
        type: MediaEnums.MediaPlayerActions.UpdatePlaybackProgress,
        data: {
          mediaPlaybackState: mediaPlayer.mediaPlaybackCurrentMediaTrack
            ? MediaEnums.MediaPlaybackState.Playing
            : MediaEnums.MediaPlaybackState.Loading,
          mediaPlaybackProgress: progress,
        },
      });
    } else if (Number.isFinite(positionSeconds)) {
      const pausedLike = transportState === 'PAUSED_PLAYBACK'
        || transportState === 'PAUSED'
        || transportState === 'STOPPED'
        || transportState === 'NO_MEDIA_PRESENT';
      store.dispatch({
        type: MediaEnums.MediaPlayerActions.UpdatePlaybackProgress,
        data: {
          mediaPlaybackState: pausedLike
            ? MediaEnums.MediaPlaybackState.Paused
            : MediaEnums.MediaPlaybackState.Playing,
          mediaPlaybackProgress: progress,
        },
      });
    }
    if (shouldAttemptTrackBacksync) {
      this.backsyncCurrentTrackFromSelectedRenderer();
    }
    if (Number.isFinite(Number(snapshot.volumePercent))) {
      const maxVolume = Math.max(1, Number(mediaPlayer.mediaPlaybackVolumeMaxLimit || 100));
      const nextVolume = Math.round((Number(snapshot.volumePercent || 0) / 100) * maxVolume);
      const clampedVolume = Math.max(0, Math.min(maxVolume, nextVolume));
      if (clampedVolume !== mediaPlayer.mediaPlaybackVolumeCurrent) {
        store.dispatch({
          type: MediaEnums.MediaPlayerActions.UpdatePlaybackVolume,
          data: {
            mediaPlaybackVolume: clampedVolume,
          },
        });
      }
    }
    if (typeof snapshot.muted === 'boolean') {
      if (snapshot.muted && !mediaPlayer.mediaPlaybackVolumeMuted) {
        store.dispatch({
          type: MediaEnums.MediaPlayerActions.MutePlaybackVolume,
        });
      } else if (!snapshot.muted && mediaPlayer.mediaPlaybackVolumeMuted) {
        store.dispatch({
          type: MediaEnums.MediaPlayerActions.UnmutePlaybackVolume,
        });
      }
    }
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

  /**
   * Standard DLNA: refresh {@link DlnaService.setNextMediaTrackOnSelectedRenderer} (SetNextAVTransportURI) so after each
   * track advance the following queue item is preloaded. Aurora Pulse Launcher: may also publish full playlist
   * (X_SetPlaylist / queue) when {@link DlnaService.shouldUseSelectedRendererQueueContext} is true. A forced sync is
   * triggered on {@link DlnaService.rendererTrackAdvancedEventName} when the renderer’s “next” URI has become current.
   */
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
    const { mediaPlayer } = store.getState();
    const queueTracks = this.getMediaQueueTracks();
    const allQueueTracks = mediaPlayer.mediaTracks || [];
    const fallbackCurrentTrack = options?.currentTrack;
    const rendererCurrentTrackId = DlnaService.getSelectedRendererCurrentTrackId();
    const rendererCurrentQueueTrack = rendererCurrentTrackId
      ? (_.find(allQueueTracks, track => String(track.id) === String(rendererCurrentTrackId))
        || _.find(queueTracks, track => String(track.id) === String(rendererCurrentTrackId)))
      : undefined;
    const currentTrack = rendererCurrentQueueTrack
      || fallbackCurrentTrack
      || mediaPlayer.mediaPlaybackCurrentMediaTrack;
    const requestedContextTracklistId = String(
      mediaPlayer.mediaPlaybackCurrentTrackList?.id
      || currentTrack?.tracklist_id
      || '',
    );
    if (forceSync && requestedContextTracklistId) {
      this.lockedDlnaContextTracklistId = requestedContextTracklistId;
    }
    const contextTracklistId = String(
      this.lockedDlnaContextTracklistId
      || requestedContextTracklistId
      || '',
    );
    const shouldPublishContextQueue = contextTracklistId.length > 0;
    const selectedRendererId = String(this.dlnaLastState?.selectedRendererId || '');
    const contextKey = `${selectedRendererId}:${contextTracklistId || 'mixed'}`;
    const contextChanged = this.lastDlnaContextKey !== contextKey;
    debug('syncSelectedRendererNextTrack - context snapshot', {
      selectedRendererId,
      contextTracklistId,
      contextKey,
      contextChanged,
      queueTracksLength: queueTracks.length,
      allQueueTracksLength: allQueueTracks.length,
      currentTrackId: currentTrack ? String(currentTrack.id || '') : '',
      rendererCurrentTrackId: rendererCurrentTrackId || '',
      forceSync,
      lastDlnaNextTrackSyncAt: this.lastDlnaNextTrackSyncAt,
      lastDlnaNextTrackQueueEntryId: this.lastDlnaNextTrackQueueEntryId,
    });
    if (this.dlnaStrictContextModeEnabled && contextChanged) {
      this.lastDlnaNextTrackSyncAt = 0;
      this.lastDlnaNextTrackQueueEntryId = undefined;
      this.lastDlnaNextSyncPairKey = '';
      DlnaService.setNextMediaTrackOnSelectedRenderer(undefined).catch((error) => {
        debug('syncSelectedRendererNextTrack - failed to clear renderer pending next track on context switch - %o', error);
      });
    }
    this.lastDlnaContextKey = contextKey;
    const contextQueueTracks = contextTracklistId
      ? allQueueTracks.filter(track => String(track.tracklist_id || '') === contextTracklistId)
      : allQueueTracks;
    debug('syncSelectedRendererNextTrack - context queue derived', {
      contextTracklistId,
      contextQueueTracksLength: contextQueueTracks.length,
      shouldPublishContextQueue,
    });
    const currentTrackInContext = currentTrack
      ? (_.find(contextQueueTracks, track => track.queue_entry_id === currentTrack.queue_entry_id)
        || _.find(contextQueueTracks, track => String(track.id) === String(currentTrack.id)))
      : undefined;
    const currentProgress = Number(options?.currentProgress || 0);
    const queueContextSignature = `${contextKey}:${contextQueueTracks.length}:${String(currentTrackInContext?.id || currentTrack?.id || '')}`;
    const queueContextPublishExpired = (now - this.lastDlnaQueueContextPublishAt) >= this.dlnaQueueContextPublishIntervalMs;
    const shouldPublishFullQueue = this.dlnaStrictContextModeEnabled
      && DlnaService.shouldUseSelectedRendererQueueContext()
      && shouldPublishContextQueue
      && contextQueueTracks.length > 1
      && (contextChanged
        || forceSync
        || queueContextPublishExpired
        || this.lastDlnaQueueContextPublishSignature !== queueContextSignature);
    if (shouldPublishFullQueue) {
      this.lockedDlnaContextTracklistId = contextTracklistId;
      debug('syncSelectedRendererNextTrack - pushing queue context', {
        contextTracklistId,
        contextQueueTracksLength: contextQueueTracks.length,
        currentTrackId: String(currentTrackInContext?.id || currentTrack?.id || ''),
      });
      DlnaService.setSelectedRendererQueueContext(
        contextQueueTracks,
        String(currentTrackInContext?.id || currentTrack?.id || ''),
        contextTracklistId || undefined,
      )
        .then((published) => {
          if (!published) {
            return;
          }
          this.lastDlnaQueueContextPublishAt = Date.now();
          this.lastDlnaQueueContextPublishSignature = queueContextSignature;
        })
        .catch((error) => {
          debug('syncSelectedRendererNextTrack - failed to push queue context to renderer - %o', error);
        });
    }
    const nearTrackEnd = !!currentTrackInContext
      && Number.isFinite(Number(currentTrackInContext.track_duration))
      && (Number(currentTrackInContext.track_duration || 0) - currentProgress) <= 90;
    let nextTrack = this.getNextFromListForTrack(currentTrackInContext || currentTrack);
    if (contextQueueTracks.length > 0 && currentTrackInContext) {
      const contextPointer = _.findIndex(
        contextQueueTracks,
        track => track.queue_entry_id === currentTrackInContext.queue_entry_id,
      );
      if (contextPointer >= 0 && contextPointer < (contextQueueTracks.length - 1)) {
        nextTrack = contextQueueTracks[contextPointer + 1];
      } else if (contextPointer >= 0) {
        nextTrack = undefined;
      }
    }
    if (!nextTrack && rendererCurrentTrackId) {
      const pointerByTrackId = _.findIndex(allQueueTracks, track => String(track.id) === String(rendererCurrentTrackId));
      if (pointerByTrackId >= 0 && pointerByTrackId < (allQueueTracks.length - 1)) {
        nextTrack = allQueueTracks[pointerByTrackId + 1];
      }
    }
    if (!nextTrack && mediaPlayer.mediaPlaybackCurrentMediaTrack) {
      const fallbackTrack = mediaPlayer.mediaPlaybackCurrentMediaTrack;
      const fallbackContextTracklistId = String(fallbackTrack.tracklist_id || '');
      if (fallbackContextTracklistId) {
        const fallbackContextQueue = allQueueTracks.filter(track => String(track.tracklist_id || '') === fallbackContextTracklistId);
        const fallbackPointer = _.findIndex(
          fallbackContextQueue,
          track => track.queue_entry_id === fallbackTrack.queue_entry_id,
        );
        if (fallbackPointer >= 0 && fallbackPointer < (fallbackContextQueue.length - 1)) {
          nextTrack = fallbackContextQueue[fallbackPointer + 1];
        }
      }
      if (!nextTrack) {
        nextTrack = this.getNextFromListForTrack(fallbackTrack);
      }
    }
    const syncPairKey = `${String(currentTrack?.queue_entry_id || '')}:${String(nextTrack?.queue_entry_id ?? 'none')}`;
    const pendingRendererNextId = String(DlnaService.getSelectedRendererPendingNextTrackId() || '').trim();
    const expectedNextId = nextTrack ? String(nextTrack.id || '').trim() : '';
    if (pendingRendererNextId && expectedNextId && pendingRendererNextId !== expectedNextId) {
      this.lastDlnaNextSyncPairKey = '';
    }
    const msSinceLastNextSync = now - (this.lastDlnaNextTrackSyncAt || 0);
    if (
      nextTrack
      && expectedNextId
      && !pendingRendererNextId
      && msSinceLastNextSync > 35000
    ) {
      this.lastDlnaNextSyncPairKey = '';
    }
    if (!forceSync && syncPairKey === this.lastDlnaNextSyncPairKey) {
      if (!nearTrackEnd) {
        return;
      }
      if (msSinceLastNextSync < this.dlnaNearEndSetNextMinIntervalMs) {
        return;
      }
    }
    this.lastDlnaNextTrackSyncAt = now;
    this.lastDlnaNextTrackQueueEntryId = nextTrack?.queue_entry_id;
    this.lastDlnaNextSyncPairKey = syncPairKey;
    DlnaService.setNextMediaTrackOnSelectedRenderer(nextTrack)
      .then((isApplied) => {
        if (isApplied) {
          if (nearTrackEnd || forceSync) {
            DlnaService.logRemoteMediaPlayerDiag('renderer_set_next_applied', {
              nextTrackId: expectedNextId,
              syncPairKey,
              nearTrackEnd,
              forceSync,
            });
          }
          return;
        }
        DlnaService.logRemoteMediaPlayerDiag('renderer_set_next_not_applied', {
          nextTrackId: expectedNextId,
          syncPairKey,
        });
        this.lastDlnaNextTrackSyncAt = 0;
        this.lastDlnaNextTrackQueueEntryId = undefined;
        this.lastDlnaNextSyncPairKey = '';
      })
      .catch((error) => {
        this.lastDlnaNextTrackSyncAt = 0;
        this.lastDlnaNextTrackQueueEntryId = undefined;
        this.lastDlnaNextSyncPairKey = '';
        DlnaService.logRemoteMediaPlayerDiag('renderer_set_next_failed', {
          nextTrackId: expectedNextId,
          message: String((error as any)?.message || error || ''),
        });
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
