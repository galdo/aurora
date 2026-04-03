import { Linking, NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface IInstalledLauncherApp {
  appName: string;
  packageName: string;
  iconUri?: string;
}

export interface ILauncherAppsLoadResult {
  apps: IInstalledLauncherApp[];
  source: 'native-module' | 'fallback';
  reason?: 'not-android' | 'module-missing' | 'module-error';
}

interface ILauncherAppsNativeModule {
  getInstalledApps?: () => Promise<IInstalledLauncherApp[]>;
  launchApp?: (packageName: string) => Promise<boolean>;
  restartCurrentApp?: () => Promise<boolean>;
}

const FALLBACK_APPS: IInstalledLauncherApp[] = [];
const APPS_CACHE_STORAGE_KEY = 'pulse-launcher:installed-apps-cache';
const APPS_CACHE_VERSION = 2;
let inMemoryAppsCache: IInstalledLauncherApp[] | null = null;
const SYSTEM_APPS: IInstalledLauncherApp[] = [
  { appName: 'Systemeinstellungen', packageName: 'pulse:settings' },
  { appName: 'WLAN Einstellungen', packageName: 'pulse:intent:android.settings.WIFI_SETTINGS' },
  { appName: 'Bluetooth Einstellungen', packageName: 'pulse:intent:android.settings.BLUETOOTH_SETTINGS' },
  { appName: 'Apps verwalten', packageName: 'pulse:intent:android.settings.APPLICATION_SETTINGS' },
  { appName: 'Speicher', packageName: 'pulse:intent:android.settings.INTERNAL_STORAGE_SETTINGS' },
];

const getNativeModule = (): ILauncherAppsNativeModule | undefined => {
  const modules = NativeModules as Record<string, unknown>;
  const moduleCandidate = modules.PulseLauncherAppsModule as ILauncherAppsNativeModule | undefined;
  return moduleCandidate;
};

const normalizeApps = (apps: IInstalledLauncherApp[]): IInstalledLauncherApp[] => apps
  .filter((app) => !!app.appName && !!app.packageName)
  .sort((left, right) => left.appName.localeCompare(right.appName, 'de'));

const hasUsableIcons = (apps: IInstalledLauncherApp[]): boolean => apps.some((app) => !!app.iconUri);

export const loadInstalledLauncherApps = async (): Promise<ILauncherAppsLoadResult> => {
  if (Platform.OS !== 'android') {
    return {
      apps: SYSTEM_APPS,
      source: 'fallback',
      reason: 'not-android',
    };
  }

  const nativeModule = getNativeModule();
  if (!nativeModule?.getInstalledApps) {
    return {
      apps: SYSTEM_APPS,
      source: 'fallback',
      reason: 'module-missing',
    };
  }

  if (inMemoryAppsCache && inMemoryAppsCache.length > 0) {
    return {
      apps: inMemoryAppsCache,
      source: 'native-module',
    };
  }

  const cachedAppsRaw = await AsyncStorage.getItem(APPS_CACHE_STORAGE_KEY).catch(() => null);
  if (cachedAppsRaw) {
    try {
      const parsed = JSON.parse(cachedAppsRaw) as { version?: number; apps?: IInstalledLauncherApp[] } | IInstalledLauncherApp[];
      const cachedApps = Array.isArray(parsed)
        ? normalizeApps(parsed)
        : normalizeApps(parsed.apps || []);
      const cachedVersion = Array.isArray(parsed) ? 1 : (parsed.version || 1);
      if (cachedApps.length > 0 && cachedVersion >= APPS_CACHE_VERSION && hasUsableIcons(cachedApps)) {
        inMemoryAppsCache = cachedApps;
        return {
          apps: cachedApps,
          source: 'native-module',
        };
      }
    } catch (_error) {
      inMemoryAppsCache = null;
    }
  }

  try {
    const apps = await nativeModule.getInstalledApps();
    const normalizedApps = normalizeApps(apps);
    inMemoryAppsCache = normalizedApps;
    await AsyncStorage.setItem(
      APPS_CACHE_STORAGE_KEY,
      JSON.stringify({ version: APPS_CACHE_VERSION, apps: normalizedApps }),
    ).catch(() => undefined);

    return {
      apps: normalizedApps,
      source: 'native-module',
    };
  } catch (_error) {
    return {
      apps: SYSTEM_APPS,
      source: 'fallback',
      reason: 'module-error',
    };
  }
};

export const refreshInstalledLauncherApps = async (): Promise<ILauncherAppsLoadResult> => {
  inMemoryAppsCache = null;
  await AsyncStorage.removeItem(APPS_CACHE_STORAGE_KEY).catch(() => undefined);
  return loadInstalledLauncherApps();
};

export const launchInstalledLauncherApp = async (packageName: string): Promise<boolean> => {
  if (!packageName) {
    return false;
  }

  const nativeModule = getNativeModule();
  if (nativeModule?.launchApp) {
    try {
      return await nativeModule.launchApp(packageName);
    } catch (_error) {
      return false;
    }
  }

  if (Platform.OS !== 'android') {
    return false;
  }

  if (packageName === 'pulse:settings') {
    try {
      await Linking.openSettings();
      return true;
    } catch (_error) {
      return false;
    }
  }

  if (packageName.startsWith('pulse:intent:')) {
    const action = packageName.replace('pulse:intent:', '').trim();
    if (!action) {
      return false;
    }
    try {
      await Linking.openURL(`intent:#Intent;action=${action};end`);
      return true;
    } catch (_error) {
      return false;
    }
  }

  const intentUrl = `intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${packageName};end`;
  try {
    await Linking.openURL(intentUrl);
    return true;
  } catch (_error) {
    return false;
  }
};

export const restartCurrentApp = async (): Promise<boolean> => {
  const nativeModule = getNativeModule();
  if (Platform.OS === 'android' && nativeModule?.restartCurrentApp) {
    try {
      return await nativeModule.restartCurrentApp();
    } catch (_error) {
      return false;
    }
  }
  return false;
};
