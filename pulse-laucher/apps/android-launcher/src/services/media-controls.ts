import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

const MODULE_NAME = 'PulseMediaControlsModule';

const getModule = () => NativeModules[MODULE_NAME] as {
  addListener?: (eventName: string) => void;
  removeListeners?: (count: number) => void;
  setSessionActive?: (active: boolean) => Promise<boolean>;
  updatePlaybackState?: (state: 'playing' | 'paused' | 'stopped', positionMs: number, durationMs: number) => Promise<boolean>;
  updatePlaybackTrack?: (
    title: string,
    artist: string,
    album: string,
    artworkUri: string,
    queueIndex: number,
    queueSize: number,
    durationMs: number,
    profileName: string,
  ) => Promise<boolean>;
} | undefined;

export const MediaControlEventEmitter = new NativeEventEmitter(getModule() as never);

export const setMediaControlSessionActive = async (active: boolean): Promise<boolean> => {
  if (Platform.OS !== 'android') {
    return false;
  }
  const module = getModule();
  if (!module?.setSessionActive) {
    return false;
  }
  return Boolean(await module.setSessionActive(active));
};

export const updateMediaControlPlaybackState = async (
  state: 'playing' | 'paused' | 'stopped',
  positionMs: number,
  durationMs: number,
): Promise<boolean> => {
  if (Platform.OS !== 'android') {
    return false;
  }
  const module = getModule();
  if (!module?.updatePlaybackState) {
    return false;
  }
  return Boolean(await module.updatePlaybackState(state, positionMs, durationMs));
};

export const updateMediaControlPlaybackTrack = async (
  title: string,
  artist: string,
  album: string,
  artworkUri: string,
  queueIndex: number,
  queueSize: number,
  durationMs: number,
  profileName: string,
): Promise<boolean> => {
  if (Platform.OS !== 'android') {
    return false;
  }
  const module = getModule();
  if (!module?.updatePlaybackTrack) {
    return false;
  }
  return Boolean(await module.updatePlaybackTrack(
    title,
    artist,
    album,
    artworkUri,
    queueIndex,
    queueSize,
    durationMs,
    profileName,
  ));
};
