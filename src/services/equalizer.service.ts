import { Howler } from 'howler';

export type EqualizerBand = {
  frequency: number;
  gain: number;
};

type EqualizerSettings = {
  bands: EqualizerBand[];
  headroomCompensationEnabled: boolean;
};

const storageKey = 'aurora:equalizer-settings';
const defaultGain = 0;
const defaultHeadroomCompensationEnabled = true;
const legacyFrequencyMap: Record<number, number> = {
  32: 31,
  64: 62,
};

export class EqualizerService {
  static readonly minGain = -12;
  static readonly maxGain = 12;
  static readonly bands: EqualizerBand[] = [
    { frequency: 32, gain: defaultGain },
    { frequency: 64, gain: defaultGain },
    { frequency: 125, gain: defaultGain },
    { frequency: 250, gain: defaultGain },
    { frequency: 500, gain: defaultGain },
    { frequency: 1000, gain: defaultGain },
    { frequency: 2000, gain: defaultGain },
    { frequency: 4000, gain: defaultGain },
    { frequency: 8000, gain: defaultGain },
    { frequency: 16000, gain: defaultGain },
  ];

  private static initialized = false;
  private static filterNodes: BiquadFilterNode[] = [];
  private static preampNode?: GainNode;
  private static currentBands: EqualizerBand[] = this.bands.map(band => ({ ...band }));
  private static headroomCompensationEnabled = defaultHeadroomCompensationEnabled;

  static initialize() {
    if (this.initialized) {
      return;
    }

    const settings = this.loadSettingsFromStorage();
    this.currentBands = settings.bands;
    this.headroomCompensationEnabled = settings.headroomCompensationEnabled;
    this.initialized = true;
    this.apply();
  }

  static getBands(): EqualizerBand[] {
    return this.currentBands.map(band => ({ ...band }));
  }

  static setBandGain(frequency: number, gain: number): EqualizerBand[] {
    const nextGain = this.clampGain(gain);
    this.currentBands = this.currentBands.map((band) => {
      if (band.frequency !== frequency) {
        return band;
      }

      return {
        ...band,
        gain: nextGain,
      };
    });

    this.persistSettings();
    this.apply();
    return this.getBands();
  }

  static getHeadroomCompensationEnabled(): boolean {
    return this.headroomCompensationEnabled;
  }

  static setHeadroomCompensationEnabled(enabled: boolean): boolean {
    this.headroomCompensationEnabled = Boolean(enabled);
    this.persistSettings();
    this.apply();
    return this.headroomCompensationEnabled;
  }

  static resetBands(): EqualizerBand[] {
    this.currentBands = this.bands.map(band => ({
      ...band,
      gain: defaultGain,
    }));
    this.persistSettings();
    this.apply();
    return this.getBands();
  }

  static apply() {
    const context = (Howler as any).ctx as AudioContext | undefined;
    const masterGain = (Howler as any).masterGain as GainNode | undefined;
    if (!context || !masterGain) {
      return;
    }

    if (!this.filterNodes.length || !this.preampNode) {
      this.filterNodes = this.currentBands.map((band, index) => {
        const filterNode = context.createBiquadFilter();
        if (index === 0) {
          filterNode.type = 'lowshelf';
        } else if (index === this.currentBands.length - 1) {
          filterNode.type = 'highshelf';
        } else {
          filterNode.type = 'peaking';
        }
        filterNode.frequency.value = band.frequency;
        filterNode.Q.value = 1;
        return filterNode;
      });

      this.preampNode = context.createGain();
      masterGain.disconnect();
      masterGain.connect(this.preampNode);
      let previousNode: AudioNode = this.preampNode;
      this.filterNodes.forEach((node) => {
        previousNode.connect(node);
        previousNode = node;
      });
      previousNode.connect(context.destination);
    }

    if (this.preampNode) {
      const maxPositiveGain = Math.max(0, ...this.currentBands.map(band => this.clampGain(band.gain)));
      const preampDb = this.headroomCompensationEnabled ? -maxPositiveGain : 0;
      const preampGain = 10 ** (preampDb / 20);
      this.preampNode.gain.setValueAtTime(preampGain, context.currentTime);
    }

    this.filterNodes.forEach((filterNode, index) => {
      const band = this.currentBands[index];
      if (!band) {
        return;
      }
      filterNode.gain.setValueAtTime(this.clampGain(band.gain), context.currentTime);
      filterNode.frequency.setValueAtTime(band.frequency, context.currentTime);
    });
  }

  private static clampGain(value: number): number {
    const clamped = Math.max(this.minGain, Math.min(this.maxGain, value));
    return Math.round(clamped * 2) / 2;
  }

  private static loadSettingsFromStorage(): EqualizerSettings {
    try {
      const rawValue = localStorage.getItem(storageKey);
      if (!rawValue) {
        return {
          bands: this.bands.map(band => ({ ...band })),
          headroomCompensationEnabled: defaultHeadroomCompensationEnabled,
        };
      }

      const parsed = JSON.parse(rawValue) as
        | Array<{ frequency: number, gain: number }>
        | { bands?: Array<{ frequency: number, gain: number }>, headroomCompensationEnabled?: boolean };

      if (Array.isArray(parsed)) {
        return {
          bands: this.mapPersistedBands(parsed),
          headroomCompensationEnabled: defaultHeadroomCompensationEnabled,
        };
      }

      return {
        bands: this.mapPersistedBands(Array.isArray(parsed.bands) ? parsed.bands : []),
        headroomCompensationEnabled: typeof parsed.headroomCompensationEnabled === 'boolean'
          ? parsed.headroomCompensationEnabled
          : defaultHeadroomCompensationEnabled,
      };
    } catch (_error) {
      return {
        bands: this.bands.map(band => ({ ...band })),
        headroomCompensationEnabled: defaultHeadroomCompensationEnabled,
      };
    }
  }

  private static mapPersistedBands(parsed: Array<{ frequency: number, gain: number }>): EqualizerBand[] {
    return this.bands.map((band) => {
      const legacyFrequency = legacyFrequencyMap[band.frequency];
      const persistedBand = parsed.find(item => (
        item.frequency === band.frequency
        || item.frequency === legacyFrequency
      ));
      return {
        frequency: band.frequency,
        gain: this.clampGain(persistedBand?.gain ?? defaultGain),
      };
    });
  }

  private static persistSettings() {
    localStorage.setItem(storageKey, JSON.stringify({
      bands: this.currentBands,
      headroomCompensationEnabled: this.headroomCompensationEnabled,
    }));
  }
}
