import { Howl, Howler } from 'howler';
import { isEmpty } from 'lodash';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';

import {
  IMediaPlayback,
  IMediaPlaybackOptions,
  IMediaPlaybackPreparationStatus,
} from '../../interfaces';

import { IMediaLocalTrack } from './media-local.interfaces';
import MediaLocalUtils from './media-local.utils';
import { EqualizerService } from '../../services/equalizer.service';
import { DlnaService } from '../../services/dlna.service';
import { BitPerfectService } from '../../services/bit-perfect.service';

const debug = require('debug')('aurora:provider:media_local:media_playback');

export class MediaLocalPlayback implements IMediaPlayback {
  private static engineWarmedUp = false;

  private readonly mediaTrack: IMediaLocalTrack;
  private readonly mediaPlaybackOptions: IMediaPlaybackOptions;
  private mediaPlaybackLocalAudio?: Howl;
  private mediaPlaybackId: number | undefined;
  private mediaPlaybackEnded = false;
  private playbackSourcePath = '';
  private hasTriedConversionFallback = false;
  private bitPerfectMutedPrimaryPath = false;
  private remotePlaybackSession = false;
  private remotePlaybackActive = false;
  private remotePlaybackStartedAt = 0;
  private remotePlaybackPausedProgress = 0;
  private remotePlaybackLastSnapshotSeconds = 0;
  private remotePlaybackLastTransportState = '';
  private remotePlaybackLastSnapshotAt = 0;
  private remotePlaybackLastPlayingStateAt = 0;
  private remotePlaybackTransitionSince = 0;
  private remotePlaybackStoppedSnapshots = 0;
  private remotePlaybackPendingNextGraceUntil = 0;
  private remotePlaybackStartupGraceUntil = 0;
  private remotePlaybackStatePollTimeout?: ReturnType<typeof setTimeout>;
  private remotePlaybackFastPollingUntil = 0;
  private preparationStatusListener?: (status?: IMediaPlaybackPreparationStatus) => void;
  private nativeBitPerfectDsdSession = false;
  private nativeBitPerfectDsdActive = false;
  private nativeBitPerfectDsdStartedAt = 0;
  private nativeBitPerfectDsdPausedProgress = 0;
  private nativeBitPerfectDsdTransitionUntil = 0;

  constructor(mediaTrack: IMediaLocalTrack, mediaPlaybackOptions: IMediaPlaybackOptions) {
    if (isEmpty(mediaTrack.extra.file_path)) {
      throw new Error(`MediaLocalPlayback encountered error while loading track - ${mediaTrack.id} - Path must not be empty`);
    }

    this.mediaTrack = mediaTrack;
    this.mediaPlaybackOptions = mediaPlaybackOptions;
  }

  static warmupEngine(): void {
    if (this.engineWarmedUp) {
      return;
    }
    this.engineWarmedUp = true;
    try {
      const warmupAudio = new Howl({
        src: ['data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA='],
        volume: 0,
        autoplay: false,
        html5: false,
      });
      warmupAudio.once('load', () => {
        warmupAudio.unload();
      });
      warmupAudio.once('loaderror', () => {
        warmupAudio.unload();
      });
      warmupAudio.load();
    } catch (_error) {
      this.engineWarmedUp = false;
    }
  }

  setPreparationStatusListener(listener?: (status?: IMediaPlaybackPreparationStatus) => void): void {
    this.preparationStatusListener = listener;
  }

  adoptRemoteSnapshot(snapshot?: { transportState?: string; positionSeconds?: number }): void {
    this.remotePlaybackSession = true;
    this.mediaPlaybackEnded = false;
    const now = Date.now();
    const prevTransport = String(this.remotePlaybackLastTransportState || '').toUpperCase();
    const prevProgress = Number(this.remotePlaybackPausedProgress || 0);
    const transportState = String(snapshot?.transportState || this.remotePlaybackLastTransportState || 'PLAYING').toUpperCase();
    const rawPosition = snapshot?.positionSeconds;
    if (Number.isFinite(Number(rawPosition))) {
      const snapshotPosition = Math.max(0, Number(rawPosition));
      this.remotePlaybackPausedProgress = snapshotPosition;
      this.remotePlaybackLastSnapshotSeconds = snapshotPosition;
    }
    this.remotePlaybackLastTransportState = transportState;
    this.remotePlaybackLastSnapshotAt = now;
    const recentPlayingStateAgeMs = this.remotePlaybackLastPlayingStateAt > 0
      ? now - this.remotePlaybackLastPlayingStateAt
      : Number.POSITIVE_INFINITY;
    if (transportState === 'PLAYING') {
      this.remotePlaybackLastPlayingStateAt = now;
    } else if (transportState === 'PAUSED_PLAYBACK' || transportState === 'PAUSED') {
      this.remotePlaybackLastPlayingStateAt = 0;
    } else if (recentPlayingStateAgeMs > 5500 && prevTransport !== 'PLAYING' && prevTransport !== 'TRANSITIONING') {
      this.remotePlaybackLastPlayingStateAt = 0;
    }
    if (transportState === 'TRANSITIONING') {
      this.remotePlaybackTransitionSince = now;
    } else if (transportState !== 'STOPPED' && transportState !== 'NO_MEDIA_PRESENT') {
      this.remotePlaybackTransitionSince = 0;
    } else if (recentPlayingStateAgeMs <= 5500 && this.remotePlaybackTransitionSince <= 0) {
      this.remotePlaybackTransitionSince = now;
    }
    this.remotePlaybackStoppedSnapshots = 0;
    this.remotePlaybackPendingNextGraceUntil = 0;
    this.remotePlaybackStartupGraceUntil = 0;
    let positionChanged = false;
    if (Number.isFinite(Number(rawPosition))) {
      positionChanged = Math.abs(Math.max(0, Number(rawPosition)) - prevProgress) > 0.04;
    }
    const steadyPlaying = transportState === 'PLAYING' && prevTransport === 'PLAYING';
    if (!steadyPlaying || positionChanged) {
      this.remotePlaybackStartedAt = now;
    }
    const recentPlaybackGraceActive = this.remotePlaybackLastPlayingStateAt > 0
      && (now - this.remotePlaybackLastPlayingStateAt) <= 5500;
    this.remotePlaybackActive = transportState === 'PLAYING'
      || transportState === 'TRANSITIONING'
      || ((transportState === 'STOPPED' || transportState === 'NO_MEDIA_PRESENT') && recentPlaybackGraceActive);
    this.startRemotePlaybackStatePolling();
  }

  deactivateRemotePolling(): void {
    this.stopRemotePlaybackStatePolling();
  }

  async play(): Promise<boolean> {
    this.mediaPlaybackEnded = false;
    if (this.remotePlaybackSession || DlnaService.isRemoteOutputRequested()) {
      const remotePlayed = await DlnaService.playMediaTrackOnSelectedRenderer(this.mediaTrack, this.remotePlaybackPausedProgress, {
        mediaPlaybackVolume: this.mediaPlaybackOptions.mediaPlaybackVolume,
        mediaPlaybackMaxVolume: this.mediaPlaybackOptions.mediaPlaybackMaxVolume,
        muted: this.mediaPlaybackOptions.mediaPlaybackVolumeMuted,
      });
      if (!remotePlayed) {
        return false;
      }
      this.remotePlaybackSession = true;
      this.remotePlaybackActive = true;
      this.remotePlaybackStartedAt = Date.now();
      this.remotePlaybackLastSnapshotSeconds = this.remotePlaybackPausedProgress;
      this.remotePlaybackLastTransportState = 'TRANSITIONING';
      this.remotePlaybackLastSnapshotAt = Date.now();
      this.remotePlaybackLastPlayingStateAt = Date.now();
      this.remotePlaybackTransitionSince = Date.now();
      this.remotePlaybackStoppedSnapshots = 0;
      this.remotePlaybackPendingNextGraceUntil = 0;
      this.remotePlaybackStartupGraceUntil = Date.now() + 12000;
      this.mediaPlaybackEnded = false;
      this.startRemotePlaybackStatePolling();
      return true;
    }
    this.remotePlaybackSession = false;
    this.stopRemotePlaybackStatePolling();
    this.nativeBitPerfectDsdSession = false;
    this.nativeBitPerfectDsdActive = false;
    this.nativeBitPerfectDsdTransitionUntil = 0;

    const sourcePath = this.mediaTrack.extra.file_path;

    if (!this.mediaPlaybackLocalAudio) {
      this.setPreparationStatus({
        phase: 'preparing',
        progress: 0,
      });
      this.initializeAudio(sourcePath);
    }

    let mediaPlayed = await this.playCurrentAudio();
    if (mediaPlayed) {
      this.syncSecondaryAudioPaths();
      this.setPreparationStatus(undefined);
      return true;
    }

    const canPlayNativeDsdWithBitPerfect = this.shouldUseNativeBitPerfectDsd(sourcePath);
    if (canPlayNativeDsdWithBitPerfect) {
      const startedNativeDsdPlayback = this.startNativeBitPerfectDsdPlayback(sourcePath, this.nativeBitPerfectDsdPausedProgress);
      if (startedNativeDsdPlayback) {
        this.syncSecondaryAudioPaths();
        this.setPreparationStatus(undefined);
        return true;
      }
    }

    const shouldTryConversionFallback = MediaLocalPlayback.shouldConvertTrackToWav(sourcePath, this.isAudioCdTrack());
    if (!shouldTryConversionFallback || this.hasTriedConversionFallback) {
      this.setPreparationStatus(undefined);
      return false;
    }

    this.hasTriedConversionFallback = true;
    const convertedPath = await MediaLocalPlayback.convertTrackToWav(sourcePath, this.isAudioCdTrack(), (progress) => {
      this.setPreparationStatus({
        phase: 'converting',
        progress,
      });
    });

    if (convertedPath === sourcePath) {
      this.setPreparationStatus(undefined);
      return false;
    }

    this.initializeAudio(convertedPath);
    mediaPlayed = await this.playCurrentAudio();
    if (mediaPlayed) {
      this.syncSecondaryAudioPaths();
    }
    this.setPreparationStatus(undefined);
    return mediaPlayed;
  }

  async prepareForPlayback(): Promise<boolean> {
    this.mediaPlaybackEnded = false;
    if (this.remotePlaybackSession || DlnaService.isRemoteOutputRequested()) {
      return true;
    }
    const sourcePath = this.mediaTrack.extra.file_path;

    if (!this.mediaPlaybackLocalAudio) {
      this.initializeAudio(sourcePath);
    }

    if (!this.mediaPlaybackLocalAudio) {
      return false;
    }

    const playbackAudio = this.mediaPlaybackLocalAudio;
    if (playbackAudio.state() === 'loaded') {
      return true;
    }

    return new Promise((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout>;
      const settle = (prepared: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        resolve(prepared);
      };

      timeoutId = setTimeout(() => {
        settle(playbackAudio.state() === 'loaded');
      }, 4000);

      playbackAudio.once('load', () => settle(true));
      playbackAudio.once('loaderror', () => settle(false));
    });
  }

  checkIfLoading(): boolean {
    if (this.remotePlaybackSession) {
      const snapshotAgeMs = Date.now() - this.remotePlaybackLastSnapshotAt;
      return this.remotePlaybackLastTransportState === 'TRANSITIONING'
        && snapshotAgeMs <= 6000;
    }
    if (this.nativeBitPerfectDsdSession) {
      return false;
    }
    if (!this.mediaPlaybackLocalAudio) {
      return false;
    }

    return this.mediaPlaybackLocalAudio.state() === 'loading';
  }

  checkIfPlaying(): boolean {
    if (this.remotePlaybackSession) {
      if (this.remotePlaybackLastTransportState === 'PLAYING') {
        this.remotePlaybackActive = true;
      }
      if (this.remotePlaybackLastTransportState === 'TRANSITIONING') {
        if (Date.now() < this.remotePlaybackStartupGraceUntil) {
          this.remotePlaybackActive = true;
        }
        const transitionAgeMs = this.remotePlaybackTransitionSince > 0
          ? Date.now() - this.remotePlaybackTransitionSince
          : Number.POSITIVE_INFINITY;
        const playingStateAgeMs = this.remotePlaybackLastPlayingStateAt > 0
          ? Date.now() - this.remotePlaybackLastPlayingStateAt
          : Number.POSITIVE_INFINITY;
        if (playingStateAgeMs <= 2200 && transitionAgeMs <= 5500) {
          this.remotePlaybackActive = true;
        } else if (Date.now() >= this.remotePlaybackStartupGraceUntil) {
          this.remotePlaybackActive = false;
        }
      }
      if (!this.remotePlaybackActive) {
        return false;
      }
      return true;
    }
    if (this.nativeBitPerfectDsdSession) {
      const state = BitPerfectService.getState();
      const isActive = state.active && state.currentFilePath === this.playbackSourcePath;
      const transitionActive = Date.now() < this.nativeBitPerfectDsdTransitionUntil;
      if (!isActive && transitionActive) {
        return true;
      }
      if (!isActive && this.nativeBitPerfectDsdActive) {
        this.nativeBitPerfectDsdActive = false;
        this.mediaPlaybackEnded = true;
      }
      if (isActive) {
        this.nativeBitPerfectDsdActive = true;
      }
      const trackDuration = Number(this.mediaTrack.track_duration || 0);
      if (trackDuration > 0 && this.getPlaybackProgress() >= trackDuration) {
        this.nativeBitPerfectDsdActive = false;
        this.mediaPlaybackEnded = true;
        return false;
      }
      return isActive;
    }
    if (!this.mediaPlaybackLocalAudio) {
      return false;
    }

    const isPlaying = this.mediaPlaybackLocalAudio.playing(this.mediaPlaybackId);
    this.syncOutputRouting(isPlaying);
    return isPlaying;
  }

  checkIfEnded(): boolean {
    return this.mediaPlaybackEnded;
  }

  getPlaybackProgress(): number {
    if (this.remotePlaybackSession) {
      if (this.remotePlaybackLastTransportState === 'PLAYING') {
        this.remotePlaybackActive = true;
      }
      if (!this.remotePlaybackActive) {
        return this.remotePlaybackPausedProgress;
      }
      const elapsedSeconds = Math.max(0, (Date.now() - this.remotePlaybackStartedAt) / 1000);
      const maxDuration = Number(this.mediaTrack.track_duration || 0);
      if (maxDuration > 0) {
        return Math.min(maxDuration, this.remotePlaybackPausedProgress + elapsedSeconds);
      }
      return this.remotePlaybackPausedProgress + elapsedSeconds;
    }
    if (this.nativeBitPerfectDsdSession) {
      if (!this.nativeBitPerfectDsdActive) {
        return this.nativeBitPerfectDsdPausedProgress;
      }
      const elapsedSeconds = Math.max(0, (Date.now() - this.nativeBitPerfectDsdStartedAt) / 1000);
      const maxDuration = Number(this.mediaTrack.track_duration || 0);
      if (maxDuration > 0) {
        return Math.min(maxDuration, this.nativeBitPerfectDsdPausedProgress + elapsedSeconds);
      }
      return this.nativeBitPerfectDsdPausedProgress + elapsedSeconds;
    }
    if (!this.mediaPlaybackLocalAudio) {
      return 0;
    }

    return MediaLocalUtils.parseMediaPlaybackDuration(this.mediaPlaybackLocalAudio.seek());
  }

  seekPlayback(mediaPlaybackSeekPosition: number): Promise<boolean> {
    if (this.remotePlaybackSession) {
      return DlnaService.seekSelectedRenderer(mediaPlaybackSeekPosition).then((seeked) => {
        if (!seeked) {
          return false;
        }
        this.remotePlaybackPausedProgress = mediaPlaybackSeekPosition;
        if (this.remotePlaybackActive) {
          this.remotePlaybackStartedAt = Date.now();
        }
        this.mediaPlaybackEnded = false;
        return true;
      });
    }
    if (this.nativeBitPerfectDsdSession) {
      const wasActive = this.nativeBitPerfectDsdActive;
      BitPerfectService.seekTrack(this.playbackSourcePath, mediaPlaybackSeekPosition);
      this.nativeBitPerfectDsdPausedProgress = mediaPlaybackSeekPosition;
      this.nativeBitPerfectDsdStartedAt = Date.now();
      this.nativeBitPerfectDsdActive = true;
      this.nativeBitPerfectDsdTransitionUntil = wasActive ? Date.now() + 2500 : 0;
      this.mediaPlaybackEnded = false;
      return Promise.resolve(true);
    }
    if (!this.mediaPlaybackLocalAudio) {
      return Promise.resolve(false);
    }

    const playbackAudio = this.mediaPlaybackLocalAudio;
    return new Promise((resolve) => {
      playbackAudio.once('seek', (mediaPlaybackAudioId: number) => {
        // TODO: Hack - When using HTML5 audio, seek is fired even before audio actually starts playing (checkIfPlaying() remains false)
        //  We are reporting a success after a 100 ms delay which during testing always gave positive results (checkIfPlaying() remained true)
        //  Check this unresolved issue - https://github.com/goldfire/howler.js/issues/1235
        setTimeout(() => {
          debug('audio event %s - playback id - %d, playing ? - %s', 'seek', mediaPlaybackAudioId, this.checkIfPlaying());
          if (this.checkIfPlaying()) {
            BitPerfectService.seekTrack(this.playbackSourcePath, mediaPlaybackSeekPosition);
          }
          resolve(true);
        }, 100);
      });

      debug('seeking track id - %s, playback id - %d, seek position - %d', this.mediaTrack.id, this.mediaPlaybackId, mediaPlaybackSeekPosition);
      playbackAudio.seek(mediaPlaybackSeekPosition);
    });
  }

  pausePlayback(): Promise<boolean> {
    if (this.remotePlaybackSession) {
      return DlnaService.pauseSelectedRenderer().then((paused) => {
        if (!paused) {
          return false;
        }
        this.remotePlaybackPausedProgress = this.getPlaybackProgress();
        this.remotePlaybackLastSnapshotSeconds = this.remotePlaybackPausedProgress;
        this.remotePlaybackActive = false;
        this.remotePlaybackLastTransportState = 'PAUSED_PLAYBACK';
        this.remotePlaybackLastSnapshotAt = Date.now();
        this.remotePlaybackStoppedSnapshots = 0;
        this.remotePlaybackPendingNextGraceUntil = 0;
        this.stopRemotePlaybackStatePolling();
        return true;
      });
    }
    if (this.nativeBitPerfectDsdSession) {
      this.nativeBitPerfectDsdPausedProgress = this.getPlaybackProgress();
      this.nativeBitPerfectDsdActive = false;
      this.nativeBitPerfectDsdTransitionUntil = 0;
      BitPerfectService.stopPlayback();
      return Promise.resolve(true);
    }
    if (!this.mediaPlaybackLocalAudio) {
      return Promise.resolve(false);
    }

    const playbackAudio = this.mediaPlaybackLocalAudio;
    return new Promise((resolve) => {
      playbackAudio.once('pause', (mediaPlaybackAudioId: number) => {
        debug('audio event %s - playback id - %d', 'pause', mediaPlaybackAudioId);
        BitPerfectService.stopPlayback();
        resolve(true);
      });

      debug('pausing track id - %s, playback id - %d', this.mediaTrack.id, this.mediaPlaybackId);
      playbackAudio.pause();
    });
  }

  resumePlayback(): Promise<boolean> {
    if (this.remotePlaybackSession) {
      return DlnaService.resumeSelectedRenderer().then((resumed) => {
        if (!resumed) {
          return false;
        }
        this.remotePlaybackActive = true;
        this.remotePlaybackStartedAt = Date.now();
        this.remotePlaybackLastSnapshotSeconds = this.remotePlaybackPausedProgress;
        this.remotePlaybackLastTransportState = 'PLAYING';
        this.remotePlaybackLastSnapshotAt = Date.now();
        this.remotePlaybackLastPlayingStateAt = Date.now();
        this.remotePlaybackStoppedSnapshots = 0;
        this.remotePlaybackPendingNextGraceUntil = 0;
        this.startRemotePlaybackStatePolling();
        return true;
      });
    }
    return this.play();
  }

  stopPlayback(): Promise<boolean> {
    if (this.remotePlaybackSession) {
      return DlnaService.stopSelectedRenderer().then((stopped) => {
        if (!stopped) {
          return false;
        }
        this.remotePlaybackPausedProgress = 0;
        this.remotePlaybackLastSnapshotSeconds = 0;
        this.remotePlaybackActive = false;
        this.remotePlaybackSession = false;
        this.remotePlaybackLastTransportState = 'STOPPED';
        this.remotePlaybackLastSnapshotAt = Date.now();
        this.remotePlaybackLastPlayingStateAt = 0;
        this.remotePlaybackStoppedSnapshots = 0;
        this.remotePlaybackPendingNextGraceUntil = 0;
        this.mediaPlaybackEnded = false;
        this.stopRemotePlaybackStatePolling();
        return true;
      });
    }
    if (this.nativeBitPerfectDsdSession) {
      this.nativeBitPerfectDsdPausedProgress = 0;
      this.nativeBitPerfectDsdActive = false;
      this.nativeBitPerfectDsdSession = false;
      this.nativeBitPerfectDsdTransitionUntil = 0;
      this.mediaPlaybackEnded = false;
      BitPerfectService.stopPlayback();
      return Promise.resolve(true);
    }
    if (!this.mediaPlaybackLocalAudio) {
      return Promise.resolve(false);
    }

    const playbackAudio = this.mediaPlaybackLocalAudio;
    return new Promise((resolve) => {
      playbackAudio.once('stop', (mediaPlaybackAudioId: number) => {
        debug('audio event %s - playback id - %d', 'stop', mediaPlaybackAudioId);
        BitPerfectService.stopPlayback();
        resolve(true);
      });

      debug('stopping track id - %s, playback id - %d', this.mediaTrack.id, this.mediaPlaybackId);
      playbackAudio.stop();
    });
  }

  changePlaybackVolume(mediaPlaybackVolume: number, mediaPlaybackMaxVolume: number): Promise<boolean> {
    if (this.remotePlaybackSession) {
      return DlnaService.setSelectedRendererVolume(mediaPlaybackVolume, mediaPlaybackMaxVolume);
    }
    if (this.nativeBitPerfectDsdSession) {
      return BitPerfectService.setVolume(mediaPlaybackVolume, mediaPlaybackMaxVolume);
    }
    if (!this.mediaPlaybackLocalAudio) {
      return Promise.resolve(false);
    }

    const applyBitPerfectVolume = BitPerfectService.isEnabled()
      ? BitPerfectService.setVolume(mediaPlaybackVolume, mediaPlaybackMaxVolume)
      : Promise.resolve(true);
    const playbackAudio = this.mediaPlaybackLocalAudio;
    return applyBitPerfectVolume.then(() => new Promise((resolve) => {
      playbackAudio.once('volume', (mediaPlaybackAudioId: number) => {
        debug('audio event %s - playback id - %d', 'volume', mediaPlaybackAudioId);
        resolve(true);
      });

      debug('changing volume track id - %s, playback id - %d, volume - %d', this.mediaTrack.id, this.mediaPlaybackId, mediaPlaybackVolume);
      playbackAudio.volume(MediaLocalPlayback.getVolumeForLocalAudioPlayer(mediaPlaybackVolume, mediaPlaybackMaxVolume));
    }));
  }

  mutePlaybackVolume(): Promise<boolean> {
    if (this.remotePlaybackSession) {
      return DlnaService.muteSelectedRenderer();
    }
    if (this.nativeBitPerfectDsdSession) {
      return BitPerfectService.muteVolume();
    }
    if (!this.mediaPlaybackLocalAudio) {
      return Promise.resolve(false);
    }

    const applyBitPerfectMute = BitPerfectService.isEnabled()
      ? BitPerfectService.muteVolume()
      : Promise.resolve(true);
    const playbackAudio = this.mediaPlaybackLocalAudio;
    return applyBitPerfectMute.then(() => new Promise((resolve) => {
      playbackAudio.once('mute', (mediaPlaybackAudioId: number) => {
        debug('audio event %s - playback id - %d', 'mute', mediaPlaybackAudioId);
        resolve(true);
      });

      debug('muting volume track id - %s, playback id - %d', this.mediaTrack.id, this.mediaPlaybackId);
      playbackAudio.mute(true);
    }));
  }

  unmutePlaybackVolume(): Promise<boolean> {
    if (this.remotePlaybackSession) {
      return DlnaService.unmuteSelectedRenderer();
    }
    if (this.nativeBitPerfectDsdSession) {
      return BitPerfectService.unmuteVolume();
    }
    if (!this.mediaPlaybackLocalAudio) {
      return Promise.resolve(false);
    }

    const applyBitPerfectUnmute = BitPerfectService.isEnabled()
      ? BitPerfectService.unmuteVolume()
      : Promise.resolve(true);
    const playbackAudio = this.mediaPlaybackLocalAudio;
    return applyBitPerfectUnmute.then(() => new Promise((resolve) => {
      playbackAudio.once('mute', (mediaPlaybackAudioId: number) => {
        debug('audio event %s - playback id - %d', 'mute', mediaPlaybackAudioId);
        resolve(true);
      });

      debug('un-muting volume track id - %s, playback id - %d', this.mediaTrack.id, this.mediaPlaybackId);
      playbackAudio.mute(false);
    }));
  }

  private static getVolumeForLocalAudioPlayer(mediaPlaybackVolume: number, mediaPlaybackMaxVolume: number): number {
    return mediaPlaybackVolume / mediaPlaybackMaxVolume;
  }

  private syncSecondaryAudioPaths() {
    DlnaService.registerTrackFromMediaTrack(this.mediaTrack, this.playbackSourcePath);
    this.syncOutputRouting(this.checkIfPlaying());
  }

  private initializeAudio(playbackSourcePath: string): void {
    if (this.mediaPlaybackLocalAudio) {
      this.mediaPlaybackLocalAudio.unload();
    }

    this.playbackSourcePath = playbackSourcePath;
    this.mediaPlaybackId = undefined;
    const playbackSourceUrl = pathToFileURL(playbackSourcePath).toString();

    this.mediaPlaybackLocalAudio = new Howl({
      src: [playbackSourceUrl],
      volume: MediaLocalPlayback.getVolumeForLocalAudioPlayer(
        this.mediaPlaybackOptions.mediaPlaybackVolume,
        this.mediaPlaybackOptions.mediaPlaybackMaxVolume,
      ),
      mute: this.mediaPlaybackOptions.mediaPlaybackVolumeMuted,
      html5: false,
      onend: (mediaPlaybackAudioId: number) => {
        debug('audio event %s - playback id - %d', 'end', mediaPlaybackAudioId);
        this.mediaPlaybackEnded = true;
      },
    });

    if ((Howler as any).usingWebAudio) {
      EqualizerService.apply();
    }
  }

  private playCurrentAudio(): Promise<boolean> {
    if (!this.mediaPlaybackLocalAudio) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      let settled = false;
      let playbackTimeout: ReturnType<typeof setTimeout>;
      const playbackAudio = this.mediaPlaybackLocalAudio as Howl;

      const settle = (played: boolean) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(playbackTimeout);
        resolve(played);
      };

      const onPlay = (mediaPlaybackAudioId: number) => {
        debug('audio event %s - playback id - %d', 'play', mediaPlaybackAudioId);
        this.syncOutputRouting(true);
        settle(true);
      };

      const onPlayError = (mediaPlaybackAudioId: number, error: any) => {
        debug('audio event %s - playback id - %d - error %o', 'playerror', mediaPlaybackAudioId, error);
        settle(false);
      };

      const onLoadError = (mediaPlaybackAudioId: number, error: any) => {
        debug('audio event %s - playback id - %d - error %o', 'loaderror', mediaPlaybackAudioId, error);
        settle(false);
      };

      playbackAudio.once('play', onPlay);
      playbackAudio.once('playerror', onPlayError);
      playbackAudio.once('loaderror', onLoadError);

      this.mediaPlaybackId = playbackAudio.play(this.mediaPlaybackId);
      debug(
        'playing track id - %s, playback source - %s, playback id - %d',
        this.mediaTrack.id,
        this.playbackSourcePath,
        this.mediaPlaybackId,
      );

      playbackTimeout = setTimeout(() => {
        settle(this.checkIfPlaying());
      }, 6000);
    });
  }

  private setPreparationStatus(status?: IMediaPlaybackPreparationStatus): void {
    if (this.preparationStatusListener) {
      this.preparationStatusListener(status);
    }
  }

  private syncOutputRouting(isPlaying: boolean) {
    if (this.nativeBitPerfectDsdSession) {
      return;
    }
    if (!this.mediaPlaybackLocalAudio) {
      return;
    }

    const playbackAudio = this.mediaPlaybackLocalAudio;
    const bitPerfectEnabled = BitPerfectService.isEnabled();
    const bitPerfectState = BitPerfectService.getState();
    const backendAvailable = bitPerfectState.backend !== 'none';

    if (bitPerfectEnabled && backendAvailable) {
      const currentlyMuted = Boolean(playbackAudio.mute());
      if (!currentlyMuted) {
        playbackAudio.mute(true, this.mediaPlaybackId);
        this.bitPerfectMutedPrimaryPath = true;
      }

      if (isPlaying && this.playbackSourcePath) {
        if (!bitPerfectState.active || bitPerfectState.currentFilePath !== this.playbackSourcePath) {
          BitPerfectService.playTrack(this.playbackSourcePath, this.getPlaybackProgress(), {
            volumePercent: this.mediaPlaybackOptions.mediaPlaybackVolume,
            muted: this.mediaPlaybackOptions.mediaPlaybackVolumeMuted,
          });
        }
      }
      return;
    }

    if (this.bitPerfectMutedPrimaryPath) {
      playbackAudio.mute(false, this.mediaPlaybackId);
      this.bitPerfectMutedPrimaryPath = false;
    }

    BitPerfectService.stopPlayback();
  }

  private startRemotePlaybackStatePolling() {
    if (this.remotePlaybackStatePollTimeout) {
      return;
    }
    this.remotePlaybackFastPollingUntil = Date.now() + 9000;
    this.scheduleRemotePlaybackStatePoll(0);
  }

  private stopRemotePlaybackStatePolling() {
    if (!this.remotePlaybackStatePollTimeout) {
      return;
    }
    clearTimeout(this.remotePlaybackStatePollTimeout);
    this.remotePlaybackStatePollTimeout = undefined;
    this.remotePlaybackFastPollingUntil = 0;
  }

  private scheduleRemotePlaybackStatePoll(delayMs: number) {
    if (this.remotePlaybackStatePollTimeout) {
      clearTimeout(this.remotePlaybackStatePollTimeout);
    }
    this.remotePlaybackStatePollTimeout = setTimeout(() => {
      this.remotePlaybackStatePollTimeout = undefined;
      this.refreshRemotePlaybackState()
        .catch(() => undefined)
        .finally(() => {
          if (!this.remotePlaybackSession) {
            return;
          }
          this.scheduleRemotePlaybackStatePoll(this.getRemotePlaybackPollIntervalMs());
        });
    }, Math.max(0, Math.floor(delayMs)));
  }

  private getRemotePlaybackPollIntervalMs(): number {
    if (!this.remotePlaybackSession) {
      return 1500;
    }
    const now = Date.now();
    if (now < this.remotePlaybackFastPollingUntil) {
      return 500;
    }
    if (this.remotePlaybackLastTransportState === 'TRANSITIONING') {
      return 500;
    }
    if (this.remotePlaybackActive) {
      return 1100;
    }
    return 900;
  }

  private async refreshRemotePlaybackState() {
    if (!this.remotePlaybackSession) {
      return;
    }
    const snapshot = await DlnaService.getSelectedRendererSnapshot();
    if (!snapshot) {
      if (this.remotePlaybackSession && Date.now() < this.remotePlaybackStartupGraceUntil) {
        this.remotePlaybackActive = true;
        this.mediaPlaybackEnded = false;
      }
      return;
    }
    this.remotePlaybackLastSnapshotAt = Date.now();
    this.remotePlaybackLastTransportState = String(snapshot.transportState || '').toUpperCase();
    if (Number.isFinite(snapshot.positionSeconds)) {
      const snapshotSeconds = Math.max(0, Number(snapshot.positionSeconds || 0));
      const hasForwardProgress = snapshotSeconds > (this.remotePlaybackLastSnapshotSeconds + 0.35);
      const hasBackwardJump = snapshotSeconds < Math.max(0, this.remotePlaybackPausedProgress - 1.5);
      if (!this.remotePlaybackActive || hasForwardProgress || hasBackwardJump) {
        this.remotePlaybackPausedProgress = snapshotSeconds;
        this.remotePlaybackLastSnapshotSeconds = snapshotSeconds;
        this.remotePlaybackStartedAt = Date.now();
        if (hasBackwardJump) {
          this.remotePlaybackStoppedSnapshots = 0;
          this.mediaPlaybackEnded = false;
          this.remotePlaybackTransitionSince = Date.now();
        }
      }
      if (hasForwardProgress || hasBackwardJump) {
        this.remotePlaybackActive = true;
        this.remotePlaybackLastPlayingStateAt = Date.now();
        this.remotePlaybackTransitionSince = 0;
        this.remotePlaybackPendingNextGraceUntil = 0;
        this.mediaPlaybackEnded = false;
      }
    }
    const transportState = this.remotePlaybackLastTransportState;
    const trackDuration = Number(this.mediaTrack.track_duration || 0);
    if (transportState === 'PLAYING') {
      this.remotePlaybackFastPollingUntil = Date.now() + 2000;
      this.remotePlaybackStoppedSnapshots = 0;
      if (!this.remotePlaybackActive) {
        this.remotePlaybackStartedAt = Date.now();
      }
      this.remotePlaybackActive = true;
      this.remotePlaybackLastPlayingStateAt = Date.now();
      this.remotePlaybackTransitionSince = 0;
      this.remotePlaybackPendingNextGraceUntil = 0;
      this.remotePlaybackStartupGraceUntil = 0;
      this.mediaPlaybackEnded = false;
      return;
    }
    if (transportState === 'TRANSITIONING') {
      this.remotePlaybackFastPollingUntil = Date.now() + 3500;
      this.remotePlaybackStoppedSnapshots = 0;
      if (this.remotePlaybackTransitionSince <= 0) {
        this.remotePlaybackTransitionSince = Date.now();
      }
      const playingStateAgeMs = this.remotePlaybackLastPlayingStateAt > 0
        ? Date.now() - this.remotePlaybackLastPlayingStateAt
        : Number.POSITIVE_INFINITY;
      if (playingStateAgeMs > 2200) {
        this.remotePlaybackActive = false;
      }
      this.mediaPlaybackEnded = false;
      return;
    }
    if (transportState === 'STOPPED' || transportState === 'NO_MEDIA_PRESENT') {
      this.remotePlaybackTransitionSince = 0;
      const reachedTrackEnd = trackDuration > 0
        && this.remotePlaybackPausedProgress >= Math.max(0, trackDuration - 1);
      const hasPendingNextTrack = DlnaService.hasPendingNextTrackOnSelectedRenderer();
      const playingStateAgeMs = this.remotePlaybackLastPlayingStateAt > 0
        ? Date.now() - this.remotePlaybackLastPlayingStateAt
        : Number.POSITIVE_INFINITY;
      const withinRecentPlaybackGraceWindow = !reachedTrackEnd && playingStateAgeMs >= 0 && playingStateAgeMs < 9000;
      const withinStartupGraceWindow = Date.now() < this.remotePlaybackStartupGraceUntil;
      if (hasPendingNextTrack) {
        if (this.remotePlaybackPendingNextGraceUntil <= 0) {
          this.remotePlaybackPendingNextGraceUntil = Date.now() + 9000;
        }
        if (Date.now() < this.remotePlaybackPendingNextGraceUntil) {
          this.remotePlaybackActive = true;
          this.mediaPlaybackEnded = false;
          return;
        }
      }
      if (withinRecentPlaybackGraceWindow) {
        this.mediaPlaybackEnded = false;
        this.remotePlaybackActive = true;
        return;
      }
      if (withinStartupGraceWindow) {
        this.mediaPlaybackEnded = false;
        this.remotePlaybackActive = true;
        return;
      }
      if (reachedTrackEnd) {
        this.remotePlaybackActive = false;
        this.mediaPlaybackEnded = true;
        this.stopRemotePlaybackStatePolling();
        return;
      }
      this.remotePlaybackStoppedSnapshots = Math.min(this.remotePlaybackStoppedSnapshots + 1, 1000);
      this.remotePlaybackActive = false;
      this.mediaPlaybackEnded = false;
      return;
    }
    if (transportState === 'PAUSED_PLAYBACK' || transportState === 'PAUSED') {
      this.remotePlaybackStoppedSnapshots = 0;
      this.remotePlaybackTransitionSince = 0;
      this.remotePlaybackPendingNextGraceUntil = 0;
      this.remotePlaybackStartupGraceUntil = 0;
      this.remotePlaybackActive = false;
    }
  }

  private isAudioCdTrack(): boolean {
    return String(this.mediaTrack.extra.file_source || '').toLowerCase() === 'audio-cd';
  }

  private static shouldConvertTrackToWav(sourcePath: string, isAudioCdTrack: boolean): boolean {
    const normalizedSource = String(sourcePath || '');
    if (!normalizedSource) {
      return false;
    }

    const extension = path.extname(normalizedSource).toLowerCase();
    return isAudioCdTrack && (extension === '.aiff' || extension === '.aif' || extension === '.aifc');
  }

  private shouldUseNativeBitPerfectDsd(sourcePath: string): boolean {
    const extension = path.extname(String(sourcePath || '')).toLowerCase();
    if (extension !== '.dsf' && extension !== '.dff') {
      return false;
    }
    if (!BitPerfectService.isEnabled()) {
      return false;
    }
    const bitPerfectState = BitPerfectService.getState();
    return bitPerfectState.backend !== 'none';
  }

  private startNativeBitPerfectDsdPlayback(sourcePath: string, startSeconds: number): boolean {
    this.playbackSourcePath = sourcePath;
    BitPerfectService.playTrack(sourcePath, Math.max(0, startSeconds), {
      volumePercent: this.mediaPlaybackOptions.mediaPlaybackVolume,
      muted: this.mediaPlaybackOptions.mediaPlaybackVolumeMuted,
    });
    const bitPerfectState = BitPerfectService.getState();
    if (!bitPerfectState.active || bitPerfectState.currentFilePath !== sourcePath) {
      return false;
    }
    this.nativeBitPerfectDsdSession = true;
    this.nativeBitPerfectDsdActive = true;
    this.nativeBitPerfectDsdPausedProgress = Math.max(0, startSeconds);
    this.nativeBitPerfectDsdStartedAt = Date.now();
    this.nativeBitPerfectDsdTransitionUntil = 0;
    this.mediaPlaybackEnded = false;
    return true;
  }

  private static convertTrackToWav(
    sourcePath: string,
    isAudioCdTrack: boolean,
    onProgress?: (progress: number) => void,
  ): Promise<string> {
    if (isAudioCdTrack) {
      return this.convertAudioCdTrackToWav(sourcePath, onProgress);
    }
    return Promise.resolve(sourcePath);
  }

  private static convertAudioCdTrackToWav(
    sourcePath: string,
    onProgress?: (progress: number) => void,
  ): Promise<string> {
    const reportProgress = (progress: number) => {
      if (onProgress) {
        onProgress(Math.max(0, Math.min(100, progress)));
      }
    };

    return new Promise((resolve) => {
      const finish = (outputPath?: string) => {
        if (!outputPath) {
          resolve(sourcePath);
          return;
        }

        resolve(outputPath);
      };

      let conversionProgressInterval: ReturnType<typeof setInterval> | undefined;
      const clearProgressInterval = () => {
        if (conversionProgressInterval) {
          clearInterval(conversionProgressInterval);
          conversionProgressInterval = undefined;
        }
      };

      try {
        const sourceStats = fs.statSync(sourcePath);
        const cacheDirectory = path.join(os.tmpdir(), 'aurora-audio-cd-playback');
        fs.mkdirSync(cacheDirectory, { recursive: true });

        const cacheKey = createHash('sha1')
          .update(`${sourcePath}:${sourceStats.size}`)
          .digest('hex');
        const outputPath = path.join(cacheDirectory, `${cacheKey}.wav`);

        if (fs.existsSync(outputPath)) {
          const outputStats = fs.statSync(outputPath);
          if (outputStats.size > 0) {
            reportProgress(100);
            finish(outputPath);
            return;
          }
        }

        reportProgress(0);

        conversionProgressInterval = setInterval(() => {
          try {
            if (!fs.existsSync(outputPath)) {
              return;
            }

            const outputStats = fs.statSync(outputPath);
            if (sourceStats.size <= 0 || outputStats.size <= 0) {
              return;
            }

            const progress = Math.floor((outputStats.size / sourceStats.size) * 100);
            reportProgress(Math.min(99, progress));
          } catch (error) {
            debug('audio-cd conversion progress failed for %s: %o', sourcePath, error);
          }
        }, 250);

        const conversionProcess = spawn('afconvert', [
          '-f',
          'WAVE',
          '-d',
          'LEI16',
          sourcePath,
          outputPath,
        ], {
          stdio: 'ignore',
        });

        conversionProcess.once('error', (error) => {
          clearProgressInterval();
          debug('audio-cd conversion failed for %s: %o', sourcePath, error);
          finish();
        });

        conversionProcess.once('close', (statusCode) => {
          clearProgressInterval();

          if (statusCode === 0 && fs.existsSync(outputPath)) {
            reportProgress(100);
            finish(outputPath);
            return;
          }

          finish();
        });
      } catch (error) {
        clearProgressInterval();
        debug('audio-cd conversion failed for %s: %o', sourcePath, error);
        finish();
      }
    });
  }
}
