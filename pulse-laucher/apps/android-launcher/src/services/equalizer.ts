import AsyncStorage from '@react-native-async-storage/async-storage';

export type EqualizerBand = {
  frequency: number;
  gain: number;
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

export interface IEqualizerSettings {
  bands: EqualizerBand[];
  preampDb: number;
  headroomCompensationEnabled: boolean;
  autoEqEnabled: boolean;
  autoEqProfile?: AutoEqProfile;
  autoEqProfilesHistory: AutoEqProfile[];
}

const storageKey = 'pulse-launcher:equalizer-settings:v1';
const defaultGain = 0;
const autoEqHistoryLimit = 12;

export const equalizerBandsTemplate: EqualizerBand[] = [
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

const clampGain = (value: number): number => {
  const clamped = Math.max(-12, Math.min(12, value));
  return Math.round(clamped * 2) / 2;
};

const normalizeAutoEqFilterType = (type: string): AutoEqFilterType | undefined => {
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
};

const normalizeAutoEqProfile = (profile?: AutoEqProfile): AutoEqProfile | undefined => {
  if (!profile || !Array.isArray(profile.filters) || profile.filters.length === 0) {
    return undefined;
  }
  const filters: AutoEqFilter[] = profile.filters
    .map((filter) => {
      const normalizedType = normalizeAutoEqFilterType(String(filter.type));
      if (!normalizedType) {
        return undefined;
      }
      return {
        enabled: filter.enabled !== false,
        type: normalizedType,
        frequency: Math.max(10, Number(filter.frequency) || 10),
        gain: clampGain(Number(filter.gain) || 0),
        q: Math.max(0.1, Number(filter.q) || 1),
      };
    })
    .filter(Boolean) as AutoEqFilter[];
  if (filters.length === 0) {
    return undefined;
  }
  return {
    name: String(profile.name || 'AutoEQ'),
    preampDb: clampGain(Number(profile.preampDb) || 0),
    filters,
  };
};

const pushAutoEqProfileHistory = (profile: AutoEqProfile, history: AutoEqProfile[]): AutoEqProfile[] => {
  const normalizedName = profile.name.trim().toLowerCase();
  const nextHistory = [
    {
      ...profile,
      filters: profile.filters.map(filter => ({ ...filter })),
    },
    ...history.filter(existingProfile => existingProfile.name.trim().toLowerCase() !== normalizedName),
  ];
  return nextHistory.slice(0, autoEqHistoryLimit);
};

export const createDefaultEqualizerSettings = (): IEqualizerSettings => ({
  bands: equalizerBandsTemplate.map(band => ({ ...band })),
  preampDb: 0,
  headroomCompensationEnabled: true,
  autoEqEnabled: false,
  autoEqProfile: undefined,
  autoEqProfilesHistory: [],
});

export const loadEqualizerSettings = async (): Promise<IEqualizerSettings> => {
  try {
    const rawValue = await AsyncStorage.getItem(storageKey);
    if (!rawValue) {
      return createDefaultEqualizerSettings();
    }
    const parsed = JSON.parse(rawValue) as Partial<IEqualizerSettings>;
    const defaultSettings = createDefaultEqualizerSettings();
    const bands = defaultSettings.bands.map((band) => {
      const match = parsed.bands?.find(item => item.frequency === band.frequency);
      return {
        frequency: band.frequency,
        gain: clampGain(match?.gain ?? defaultGain),
      };
    });
    const autoEqProfile = normalizeAutoEqProfile(parsed.autoEqProfile);
    const autoEqProfilesHistory = Array.isArray(parsed.autoEqProfilesHistory)
      ? parsed.autoEqProfilesHistory
        .map(profile => normalizeAutoEqProfile(profile))
        .filter(Boolean)
        .slice(0, autoEqHistoryLimit) as AutoEqProfile[]
      : [];
    return {
      bands,
      preampDb: clampGain(Number(parsed.preampDb) || 0),
      headroomCompensationEnabled: parsed.headroomCompensationEnabled !== false,
      autoEqEnabled: !!parsed.autoEqEnabled && !!autoEqProfile,
      autoEqProfile,
      autoEqProfilesHistory: autoEqProfile
        ? pushAutoEqProfileHistory(autoEqProfile, autoEqProfilesHistory)
        : autoEqProfilesHistory,
    };
  } catch (_error) {
    return createDefaultEqualizerSettings();
  }
};

export const persistEqualizerSettings = async (settings: IEqualizerSettings): Promise<void> => {
  await AsyncStorage.setItem(storageKey, JSON.stringify(settings));
};

export const setEqualizerBandGain = (settings: IEqualizerSettings, frequency: number, gain: number): IEqualizerSettings => ({
  ...settings,
  autoEqEnabled: false,
  bands: settings.bands.map((band) => {
    if (band.frequency !== frequency) {
      return band;
    }
    return {
      ...band,
      gain: clampGain(gain),
    };
  }),
});

export const setEqualizerPreampGain = (settings: IEqualizerSettings, preampDb: number): IEqualizerSettings => ({
  ...settings,
  preampDb: clampGain(preampDb),
});

export const resetEqualizerBands = (settings: IEqualizerSettings): IEqualizerSettings => ({
  ...settings,
  autoEqEnabled: false,
  bands: equalizerBandsTemplate.map(band => ({ ...band })),
});

export const setHeadroomCompensation = (settings: IEqualizerSettings, enabled: boolean): IEqualizerSettings => ({
  ...settings,
  headroomCompensationEnabled: enabled,
});

export const setAutoEqEnabled = (settings: IEqualizerSettings, enabled: boolean): IEqualizerSettings => ({
  ...settings,
  autoEqEnabled: enabled && !!settings.autoEqProfile && settings.autoEqProfile.filters.length > 0,
});

export const selectAutoEqProfile = (
  settings: IEqualizerSettings,
  profileName: string,
): { settings: IEqualizerSettings; error?: string } => {
  const normalizedName = String(profileName || '').trim().toLowerCase();
  if (!normalizedName) {
    return { settings, error: 'Kein AutoEQ-Profil ausgewählt.' };
  }
  const selectedProfile = settings.autoEqProfilesHistory.find(
    profile => profile.name.trim().toLowerCase() === normalizedName,
  );
  if (!selectedProfile) {
    return { settings, error: 'AutoEQ-Profil wurde nicht gefunden.' };
  }
  const nextProfile = {
    ...selectedProfile,
    filters: selectedProfile.filters.map(filter => ({ ...filter })),
  };
  return {
    settings: {
      ...settings,
      autoEqEnabled: true,
      autoEqProfile: nextProfile,
      autoEqProfilesHistory: pushAutoEqProfileHistory(nextProfile, settings.autoEqProfilesHistory),
    },
  };
};

export const importAutoEqProfileFromText = (
  settings: IEqualizerSettings,
  profileText: string,
  profileName = 'AutoEQ',
): { settings: IEqualizerSettings; error?: string; profile?: AutoEqProfile } => {
  const lines = String(profileText || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { settings, error: 'AutoEQ-Profil ist leer.' };
  }
  const preampLine = lines.find(line => /preamp\s*:/i.test(line));
  if (!preampLine) {
    return { settings, error: 'Preamp-Zeile fehlt. Erwartet: Preamp: -X dB' };
  }
  const preampMatch = preampLine.match(/preamp\s*:\s*(-?\d+(?:[.,]\d+)?)(?:\s*dB)?/i);
  if (!preampMatch) {
    return { settings, error: 'Preamp-Zeile hat ein ungültiges Format.' };
  }
  const preampDb = Number(String(preampMatch[1]).replace(',', '.'));
  if (!Number.isFinite(preampDb)) {
    return { settings, error: 'Preamp-Wert ist ungültig.' };
  }
  const filterLines = lines.filter(line => /filter\s+\d+\s*:\s*(on|off)\s+/i.test(line));
  if (filterLines.length === 0) {
    return { settings, error: 'Keine gültigen Filterzeilen gefunden.' };
  }
  const filters: AutoEqFilter[] = [];
  for (let index = 0; index < filterLines.length; index += 1) {
    const line = filterLines[index];
    const filterMatch = line.match(/filter\s+(\d+)\s*:\s*(ON|OFF)\s+([A-Z]+)\s+(.+)/i);
    if (!filterMatch) {
      return { settings, error: `Filter-Zeile ${index + 1} ist ungültig.` };
    }
    const enabled = String(filterMatch[2]).toUpperCase() === 'ON';
    const type = normalizeAutoEqFilterType(String(filterMatch[3]).toUpperCase());
    if (!type) {
      return { settings, error: `Filter-Zeile ${index + 1} enthält einen nicht unterstützten Filtertyp.` };
    }
    const valueSection = String(filterMatch[4] || '');
    const frequencyMatch = valueSection.match(/\bFc\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)\s*Hz\b/i);
    const gainMatch = valueSection.match(/\bGain\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)\s*dB\b/i);
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
      return { settings, error: `Filter-Zeile ${index + 1} enthält ungültige Werte.` };
    }
    filters.push({
      enabled,
      type,
      frequency: Math.max(10, frequency),
      gain: clampGain(gain),
      q: Math.max(0.1, q),
    });
  }
  const profile: AutoEqProfile = {
    name: profileName.trim() || 'AutoEQ',
    preampDb: clampGain(preampDb),
    filters,
  };
  return {
    profile,
    settings: {
      ...settings,
      autoEqEnabled: true,
      autoEqProfile: profile,
      autoEqProfilesHistory: pushAutoEqProfileHistory(profile, settings.autoEqProfilesHistory),
    },
  };
};
