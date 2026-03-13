import { Howler } from 'howler';

export type EqualizerBand = {
  frequency: number;
  gain: number;
};

type EqualizerSettings = {
  bands: EqualizerBand[];
  headroomCompensationEnabled: boolean;
  autoEqEnabled: boolean;
  autoEqProfile?: AutoEqProfile;
  autoEqProfilesHistory?: AutoEqProfile[];
};

export type AutoEqFilterType = 'PK' | 'LSC' | 'HSC' | 'HPF' | 'LPF' | 'NOCH';

export type AutoEqFilter = {
  enabled: boolean;
  type: AutoEqFilterType;
  frequency: number;
  gain: number;
  q: number;
};

export type AutoEqProfile = {
  name: string;
  preampDb: number;
  filters: AutoEqFilter[];
};

const storageKey = 'aurora:equalizer-settings';
const defaultGain = 0;
const defaultHeadroomCompensationEnabled = true;
const defaultAutoEqEnabled = false;
const autoEqHistoryLimit = 12;
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
  private static autoEqEnabled = defaultAutoEqEnabled;
  private static autoEqProfile?: AutoEqProfile;
  private static autoEqProfilesHistory: AutoEqProfile[] = [];

  static initialize() {
    if (this.initialized) {
      return;
    }

    const settings = this.loadSettingsFromStorage();
    this.currentBands = settings.bands;
    this.headroomCompensationEnabled = settings.headroomCompensationEnabled;
    this.autoEqEnabled = settings.autoEqEnabled;
    this.autoEqProfile = settings.autoEqProfile;
    this.autoEqProfilesHistory = settings.autoEqProfilesHistory || [];
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

  static getAutoEqEnabled(): boolean {
    return this.autoEqEnabled;
  }

  static setAutoEqEnabled(enabled: boolean): boolean {
    if (!enabled) {
      this.autoEqEnabled = false;
    } else {
      this.autoEqEnabled = !!this.autoEqProfile && this.autoEqProfile.filters.length > 0;
    }
    this.persistSettings();
    this.apply();
    return this.autoEqEnabled;
  }

  static getAutoEqProfile(): AutoEqProfile | undefined {
    if (!this.autoEqProfile) {
      return undefined;
    }
    return {
      name: this.autoEqProfile.name,
      preampDb: this.autoEqProfile.preampDb,
      filters: this.autoEqProfile.filters.map(filter => ({ ...filter })),
    };
  }

  static getAutoEqProfilesHistory(): AutoEqProfile[] {
    return this.autoEqProfilesHistory.map(profile => ({
      ...profile,
      filters: profile.filters.map(filter => ({ ...filter })),
    }));
  }

  static selectAutoEqProfile(profileName: string): { profile?: AutoEqProfile; error?: string } {
    const normalizedName = String(profileName || '').trim().toLowerCase();
    if (!normalizedName) {
      return { error: 'Kein AutoEQ-Profil ausgewählt.' };
    }
    const selectedProfile = this.autoEqProfilesHistory.find(
      profile => profile.name.trim().toLowerCase() === normalizedName,
    );
    if (!selectedProfile) {
      return { error: 'AutoEQ-Profil wurde nicht gefunden.' };
    }
    this.autoEqProfile = {
      ...selectedProfile,
      filters: selectedProfile.filters.map(filter => ({ ...filter })),
    };
    this.autoEqEnabled = true;
    this.autoEqProfilesHistory = this.pushAutoEqProfileHistory(this.autoEqProfile, this.autoEqProfilesHistory);
    this.persistSettings();
    this.apply();
    return {
      profile: this.getAutoEqProfile(),
    };
  }

  static importAutoEqProfileFromText(profileText: string, profileName = 'AutoEQ'): { profile?: AutoEqProfile; error?: string } {
    const parsed = this.parseAutoEqProfile(profileText, profileName);
    if (!parsed.profile) {
      return parsed;
    }
    this.autoEqProfile = parsed.profile;
    this.autoEqEnabled = true;
    this.autoEqProfilesHistory = this.pushAutoEqProfileHistory(parsed.profile, this.autoEqProfilesHistory);
    this.persistSettings();
    this.apply();
    return {
      profile: this.getAutoEqProfile(),
    };
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

    const isAutoEqActive = this.autoEqEnabled && !!this.autoEqProfile && this.autoEqProfile.filters.length > 0;
    const filterConfigs = isAutoEqActive
      ? this.autoEqProfile!.filters
        .filter(filter => filter.enabled)
        .map(filter => ({
          type: this.mapAutoEqFilterType(filter.type),
          frequency: filter.frequency,
          gain: filter.gain,
          q: filter.q,
        }))
      : this.currentBands.map((band, index) => ({
        type: this.getManualFilterType(index),
        frequency: band.frequency,
        gain: this.clampGain(band.gain),
        q: 1,
      }));

    if (!this.preampNode || this.filterNodes.length !== filterConfigs.length) {
      this.rebuildAudioNodes(context, masterGain, filterConfigs.length);
    }

    if (this.preampNode) {
      const preampDb = isAutoEqActive
        ? this.autoEqProfile?.preampDb || 0
        : this.getManualPreampDb();
      const preampGain = 10 ** (preampDb / 20);
      this.preampNode.gain.setValueAtTime(preampGain, context.currentTime);
    }

    this.filterNodes.forEach((filterNode, index) => {
      const filterConfig = filterConfigs[index];
      if (!filterConfig) {
        return;
      }
      const targetNode = filterNode;
      targetNode.type = filterConfig.type;
      targetNode.gain.setValueAtTime(this.clampGain(filterConfig.gain), context.currentTime);
      targetNode.frequency.setValueAtTime(Math.max(10, filterConfig.frequency), context.currentTime);
      targetNode.Q.setValueAtTime(Math.max(0.1, filterConfig.q), context.currentTime);
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
          autoEqEnabled: defaultAutoEqEnabled,
          autoEqProfile: undefined,
          autoEqProfilesHistory: [],
        };
      }

      const parsed = JSON.parse(rawValue) as
        | Array<{ frequency: number, gain: number }>
        | {
          bands?: Array<{ frequency: number, gain: number }>,
          headroomCompensationEnabled?: boolean,
          autoEqEnabled?: boolean,
          autoEqProfile?: AutoEqProfile,
          autoEqProfilesHistory?: AutoEqProfile[],
        };

      if (Array.isArray(parsed)) {
        return {
          bands: this.mapPersistedBands(parsed),
          headroomCompensationEnabled: defaultHeadroomCompensationEnabled,
          autoEqEnabled: defaultAutoEqEnabled,
          autoEqProfile: undefined,
          autoEqProfilesHistory: [],
        };
      }

      const parsedProfile = this.normalizeAutoEqProfile(parsed.autoEqProfile);
      const parsedProfilesHistory = this.normalizeAutoEqProfilesHistory(parsed.autoEqProfilesHistory);
      const mergedProfilesHistory = parsedProfile
        ? this.pushAutoEqProfileHistory(parsedProfile, parsedProfilesHistory)
        : parsedProfilesHistory;

      return {
        bands: this.mapPersistedBands(Array.isArray(parsed.bands) ? parsed.bands : []),
        headroomCompensationEnabled: typeof parsed.headroomCompensationEnabled === 'boolean'
          ? parsed.headroomCompensationEnabled
          : defaultHeadroomCompensationEnabled,
        autoEqEnabled: parsedProfile && typeof parsed.autoEqEnabled === 'boolean'
          ? parsed.autoEqEnabled
          : defaultAutoEqEnabled,
        autoEqProfile: parsedProfile,
        autoEqProfilesHistory: mergedProfilesHistory,
      };
    } catch (_error) {
      return {
        bands: this.bands.map(band => ({ ...band })),
        headroomCompensationEnabled: defaultHeadroomCompensationEnabled,
        autoEqEnabled: defaultAutoEqEnabled,
        autoEqProfile: undefined,
        autoEqProfilesHistory: [],
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
      autoEqEnabled: this.autoEqEnabled,
      autoEqProfile: this.autoEqProfile,
      autoEqProfilesHistory: this.autoEqProfilesHistory,
    }));
  }

  private static getManualFilterType(index: number): BiquadFilterType {
    if (index === 0) {
      return 'lowshelf';
    }
    if (index === this.currentBands.length - 1) {
      return 'highshelf';
    }
    return 'peaking';
  }

  private static getManualPreampDb(): number {
    const maxPositiveGain = Math.max(0, ...this.currentBands.map(band => this.clampGain(band.gain)));
    return this.headroomCompensationEnabled ? -maxPositiveGain : 0;
  }

  private static rebuildAudioNodes(context: AudioContext, masterGain: GainNode, filterCount: number) {
    this.disconnectNode(masterGain);
    if (this.preampNode) {
      this.disconnectNode(this.preampNode);
    }
    this.filterNodes.forEach((node) => {
      this.disconnectNode(node);
    });

    this.preampNode = context.createGain();
    this.filterNodes = Array.from({ length: filterCount }).map(() => context.createBiquadFilter());

    masterGain.connect(this.preampNode);
    let previousNode: AudioNode = this.preampNode;
    this.filterNodes.forEach((node) => {
      previousNode.connect(node);
      previousNode = node;
    });
    previousNode.connect(context.destination);
  }

  private static disconnectNode(node: AudioNode) {
    try {
      node.disconnect();
    } catch (error) {
      this.onDisconnectError(error);
    }
  }

  private static onDisconnectError(error: unknown) {
    String(error);
    return undefined;
  }

  private static mapAutoEqFilterType(type: AutoEqFilterType): BiquadFilterType {
    if (type === 'LSC') {
      return 'lowshelf';
    }
    if (type === 'HSC') {
      return 'highshelf';
    }
    if (type === 'HPF') {
      return 'highpass';
    }
    if (type === 'LPF') {
      return 'lowpass';
    }
    if (type === 'NOCH') {
      return 'notch';
    }
    return 'peaking';
  }

  private static normalizeAutoEqFilterType(type: string): AutoEqFilterType | undefined {
    const normalizedType = String(type || '').trim().toUpperCase();
    const typeAliases: Record<string, AutoEqFilterType> = {
      PK: 'PK',
      PEQ: 'PK',
      PEAK: 'PK',
      PEAKING: 'PK',
      LSC: 'LSC',
      LOWSHELF: 'LSC',
      HSC: 'HSC',
      HIGHSHELF: 'HSC',
      HPF: 'HPF',
      HIGHPASS: 'HPF',
      LPF: 'LPF',
      LOWPASS: 'LPF',
      NOCH: 'NOCH',
      NOTCH: 'NOCH',
    };
    return typeAliases[normalizedType];
  }

  private static parseAutoEqProfile(profileText: string, profileName: string): { profile?: AutoEqProfile; error?: string } {
    const lines = String(profileText || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return { error: 'AutoEQ-Profil ist leer.' };
    }

    const preampLine = lines.find(line => /^preamp\s*:/i.test(line));
    if (!preampLine) {
      return { error: 'Preamp-Zeile fehlt. Erwartet: Preamp: -X dB' };
    }

    const preampMatch = preampLine.match(/^preamp\s*:\s*(-?\d+(?:[.,]\d+)?)(?:\s*dB)?$/i);
    if (!preampMatch) {
      return { error: 'Preamp-Zeile hat ein ungültiges Format.' };
    }
    const preampDb = Number(String(preampMatch[1]).replace(',', '.'));
    if (!Number.isFinite(preampDb)) {
      return { error: 'Preamp-Wert ist ungültig.' };
    }

    const filterLines = lines.filter(line => /^filter\s+\d+\s*:\s*(on|off)\s+/i.test(line));
    if (filterLines.length === 0) {
      return { error: 'Keine gültigen Filterzeilen gefunden.' };
    }

    const filters: AutoEqFilter[] = [];
    for (let index = 0; index < filterLines.length; index += 1) {
      const line = filterLines[index];
      const filterMatch = line.match(
        /^filter\s+(\d+)\s*:\s*(ON|OFF)\s+([A-Z]+)\s+(.+)$/i,
      );
      if (!filterMatch) {
        return { error: `Filter-Zeile ${index + 1} ist ungültig.` };
      }

      const enabled = String(filterMatch[2]).toUpperCase() === 'ON';
      const rawType = String(filterMatch[3]).toUpperCase();
      const type = this.normalizeAutoEqFilterType(rawType);
      if (!type) {
        return { error: `Filter-Zeile ${index + 1} enthält einen nicht unterstützten Filtertyp.` };
      }

      const valueSection = String(filterMatch[4] || '');
      const frequencyMatch = valueSection.match(/\bFc\s+(-?\d+(?:[.,]\d+)?)\s*Hz\b/i);
      const gainMatch = valueSection.match(/\bGain\s+(-?\d+(?:[.,]\d+)?)\s*dB\b/i);
      const qMatch = valueSection.match(/\bQ\s+(\d+(?:[.,]\d+)?)\b/i);
      const slopeMatch = valueSection.match(/\bS\s+(\d+(?:[.,]\d+)?)\b/i);

      const frequency = Number(String(frequencyMatch?.[1] || '').replace(',', '.'));
      const gain = Number(String(gainMatch?.[1] || '0').replace(',', '.'));
      const qValue = Number(String(qMatch?.[1] || '').replace(',', '.'));
      const slopeValue = Number(String(slopeMatch?.[1] || '').replace(',', '.'));
      const fallbackQ = (type === 'HPF' || type === 'LPF') ? 0.707 : 1;
      const qFromSlope = Number.isFinite(slopeValue) ? Math.max(0.1, slopeValue) : fallbackQ;
      const q = Number.isFinite(qValue) ? qValue : qFromSlope;

      if (!Number.isFinite(frequency) || !Number.isFinite(gain) || !Number.isFinite(q)) {
        return { error: `Filter-Zeile ${index + 1} enthält ungültige Werte.` };
      }
      filters.push({
        enabled,
        type,
        frequency: Math.max(10, frequency),
        gain: this.clampGain(gain),
        q: Math.max(0.1, q),
      });
    }

    return {
      profile: {
        name: profileName.trim() || 'AutoEQ',
        preampDb: this.clampGain(preampDb),
        filters,
      },
    };
  }

  private static normalizeAutoEqProfile(profile?: AutoEqProfile): AutoEqProfile | undefined {
    if (!profile || !Array.isArray(profile.filters) || profile.filters.length === 0) {
      return undefined;
    }
    const filters: AutoEqFilter[] = profile.filters
      .map((filter) => {
        const normalizedType = this.normalizeAutoEqFilterType(String(filter.type));
        if (!normalizedType) {
          return undefined;
        }
        return {
          enabled: filter.enabled !== false,
          type: normalizedType,
          frequency: Math.max(10, Number(filter.frequency) || 10),
          gain: this.clampGain(Number(filter.gain) || 0),
          q: Math.max(0.1, Number(filter.q) || 1),
        };
      })
      .filter(Boolean) as AutoEqFilter[];

    if (filters.length === 0) {
      return undefined;
    }

    return {
      name: String(profile.name || 'AutoEQ'),
      preampDb: this.clampGain(Number(profile.preampDb) || 0),
      filters,
    };
  }

  private static normalizeAutoEqProfilesHistory(profilesHistory?: AutoEqProfile[]): AutoEqProfile[] {
    if (!Array.isArray(profilesHistory)) {
      return [];
    }
    return profilesHistory
      .map(profile => this.normalizeAutoEqProfile(profile))
      .filter(Boolean)
      .slice(0, autoEqHistoryLimit) as AutoEqProfile[];
  }

  private static pushAutoEqProfileHistory(profile: AutoEqProfile, history: AutoEqProfile[]): AutoEqProfile[] {
    const normalizedName = profile.name.trim().toLowerCase();
    const nextHistory = [
      {
        ...profile,
        filters: profile.filters.map(filter => ({ ...filter })),
      },
      ...history.filter(existingProfile => existingProfile.name.trim().toLowerCase() !== normalizedName),
    ];
    return nextHistory.slice(0, autoEqHistoryLimit);
  }
}
