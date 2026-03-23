import { NativeEventEmitter, NativeModules } from 'react-native';

const MODULE_NAME = 'PulseDLNAControlModule';

const getModule = () => NativeModules[MODULE_NAME] as {
  addListener?: (eventName: string) => void;
  removeListeners?: (count: number) => void;
  updatePlaybackState?: (state: 'playing' | 'paused' | 'stopped', positionMs: number, durationMs: number) => Promise<boolean>;
  updatePlaybackTrack?: (
    uri: string,
    title: string,
    artist: string,
    albumArt: string,
    queueIndex: number,
    queueSize: number,
  ) => Promise<boolean>;
} | undefined;

export const DLNAControlEventEmitter = new NativeEventEmitter(getModule() as never);

export const updateDLNAPlaybackState = async (
  state: 'playing' | 'paused' | 'stopped',
  positionMs: number,
  durationMs: number,
): Promise<boolean> => {
  const module = getModule();
  if (!module || typeof module.updatePlaybackState !== 'function') {
    return false;
  }
  return await module.updatePlaybackState(state, positionMs, durationMs);
};

export const updateDLNAPlaybackTrack = async (
  uri: string,
  title: string,
  artist: string,
  albumArt: string,
  queueIndex: number,
  queueSize: number,
): Promise<boolean> => {
  const module = getModule();
  if (!module || typeof module.updatePlaybackTrack !== 'function') {
    return false;
  }
  return await module.updatePlaybackTrack(uri, title, artist, albumArt, queueIndex, queueSize);
};
