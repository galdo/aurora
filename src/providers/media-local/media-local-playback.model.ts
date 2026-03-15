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
  private remotePlaybackActive = false;
  private remotePlaybackStartedAt = 0;
  private remotePlaybackPausedProgress = 0;
  private preparationStatusListener?: (status?: IMediaPlaybackPreparationStatus) => void;

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

  async play(): Promise<boolean> {
    this.mediaPlaybackEnded = false;
    if (DlnaService.isRemoteOutputSelected()) {
      const remotePlayed = await DlnaService.playMediaTrackOnSelectedRenderer(this.mediaTrack, this.remotePlaybackPausedProgress, {
        mediaPlaybackVolume: this.mediaPlaybackOptions.mediaPlaybackVolume,
        mediaPlaybackMaxVolume: this.mediaPlaybackOptions.mediaPlaybackMaxVolume,
        muted: this.mediaPlaybackOptions.mediaPlaybackVolumeMuted,
      });
      if (!remotePlayed) {
        return false;
      }
      this.remotePlaybackActive = true;
      this.remotePlaybackStartedAt = Date.now();
      this.mediaPlaybackEnded = false;
      return true;
    }

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

    const shouldTryConversionFallback = this.isAudioCdTrack() && MediaLocalPlayback.shouldConvertAudioCdTrack(sourcePath);
    if (!shouldTryConversionFallback || this.hasTriedConversionFallback) {
      this.setPreparationStatus(undefined);
      return false;
    }

    this.hasTriedConversionFallback = true;
    const convertedPath = await MediaLocalPlayback.convertAudioCdTrackToWav(sourcePath, (progress) => {
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
    if (DlnaService.isRemoteOutputSelected()) {
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
    if (DlnaService.isRemoteOutputSelected()) {
      return false;
    }
    if (!this.mediaPlaybackLocalAudio) {
      return false;
    }

    return this.mediaPlaybackLocalAudio.state() === 'loading';
  }

  checkIfPlaying(): boolean {
    if (DlnaService.isRemoteOutputSelected()) {
      if (!this.remotePlaybackActive) {
        return false;
      }
      if (this.getPlaybackProgress() >= Number(this.mediaTrack.track_duration || 0)) {
        this.remotePlaybackActive = false;
        this.mediaPlaybackEnded = true;
        return false;
      }
      return true;
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
    if (DlnaService.isRemoteOutputSelected()) {
      if (!this.remotePlaybackActive) {
        return this.remotePlaybackPausedProgress;
      }
      const elapsedSeconds = Math.max(0, (Date.now() - this.remotePlaybackStartedAt) / 1000);
      const maxDuration = Number(this.mediaTrack.track_duration || 0);
      return Math.min(maxDuration, this.remotePlaybackPausedProgress + elapsedSeconds);
    }
    if (!this.mediaPlaybackLocalAudio) {
      return 0;
    }

    return MediaLocalUtils.parseMediaPlaybackDuration(this.mediaPlaybackLocalAudio.seek());
  }

  seekPlayback(mediaPlaybackSeekPosition: number): Promise<boolean> {
    if (DlnaService.isRemoteOutputSelected()) {
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
    if (DlnaService.isRemoteOutputSelected()) {
      return DlnaService.pauseSelectedRenderer().then((paused) => {
        if (!paused) {
          return false;
        }
        this.remotePlaybackPausedProgress = this.getPlaybackProgress();
        this.remotePlaybackActive = false;
        return true;
      });
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
    return this.play();
  }

  stopPlayback(): Promise<boolean> {
    if (DlnaService.isRemoteOutputSelected()) {
      return DlnaService.stopSelectedRenderer().then((stopped) => {
        if (!stopped) {
          return false;
        }
        this.remotePlaybackPausedProgress = 0;
        this.remotePlaybackActive = false;
        this.mediaPlaybackEnded = true;
        return true;
      });
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
    if (DlnaService.isRemoteOutputSelected()) {
      return DlnaService.setSelectedRendererVolume(mediaPlaybackVolume, mediaPlaybackMaxVolume);
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
    if (DlnaService.isRemoteOutputSelected()) {
      return DlnaService.muteSelectedRenderer();
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
    if (DlnaService.isRemoteOutputSelected()) {
      return DlnaService.unmuteSelectedRenderer();
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

  private isAudioCdTrack(): boolean {
    return String(this.mediaTrack.extra.file_source || '').toLowerCase() === 'audio-cd';
  }

  private static shouldConvertAudioCdTrack(sourcePath: string): boolean {
    const normalizedSource = String(sourcePath || '');
    if (!normalizedSource) {
      return false;
    }

    const extension = path.extname(normalizedSource).toLowerCase();
    return extension === '.aiff' || extension === '.aif' || extension === '.aifc';
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
