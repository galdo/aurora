import { NativeModules, Platform } from 'react-native';

type EqualizerBand = {
  frequency: number;
  gain: number;
};

interface IAudioEffectsModule {
  applyEqualizer?: (bands: Array<{ frequency: number; gain: number }>, preampDb: number, enabled: boolean) => Promise<boolean>;
  setEnabled?: (enabled: boolean) => Promise<boolean>;
}

const getModule = (): IAudioEffectsModule | undefined => {
  if (Platform.OS !== 'android') {
    return undefined;
  }
  return (NativeModules as Record<string, unknown>).PulseAudioEffectsModule as IAudioEffectsModule | undefined;
};

export const applyAudioEffects = async (
  bands: EqualizerBand[],
  preampDb: number,
  enabled: boolean,
): Promise<boolean> => {
  const module = getModule();
  if (!module?.applyEqualizer) {
    return false;
  }
  return Boolean(await module.applyEqualizer(
    bands.map((band) => ({ frequency: Number(band.frequency) || 0, gain: Number(band.gain) || 0 })),
    Number(preampDb) || 0,
    enabled,
  ));
};

export const setAudioEffectsEnabled = async (enabled: boolean): Promise<boolean> => {
  const module = getModule();
  if (!module?.setEnabled) {
    return false;
  }
  return Boolean(await module.setEnabled(enabled));
};

