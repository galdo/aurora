import { IPCCommChannel, IPCRenderer, IPCRendererCommChannel } from '../modules/ipc';
import { I18nService } from './i18n.service';

export type UpdateDownloadMode = 'auto' | 'manual';

export type UpdateSettings = {
  checkOnStartup: boolean;
  downloadMode: UpdateDownloadMode;
  autoInstallOnDownload: boolean;
  betaChannelEnabled: boolean;
};

export type UpdateState = {
  status: 'idle' | 'checking' | 'available' | 'not_available' | 'downloading' | 'downloaded' | 'installing' | 'error';
  currentVersion: string;
  availableVersion?: string;
  downloadProgressPercent?: number;
  releaseDate?: string;
  releaseNotes?: string;
  message?: string;
  platform: string;
  arch: string;
  canDownload: boolean;
  canInstall: boolean;
};

export type WhatsNewPayload = {
  version: string;
  releaseDate?: string;
  releaseNotes: string;
};

const updateChangedEventName = 'aurora:update-state-changed';

function parseLocalizedReleaseNotes(releaseNotes: string, locale: string) {
  if (!releaseNotes.trim()) {
    return releaseNotes;
  }

  const blocks = Array.from(releaseNotes.matchAll(/<!--\s*locale:([a-z]{2})\s*-->([\s\S]*?)(?=(<!--\s*locale:[a-z]{2}\s*-->)|$)/gi));
  if (blocks.length === 0) {
    return releaseNotes;
  }

  const normalizedLocale = String(locale || 'en').slice(0, 2).toLowerCase();
  const byLocale = new Map<string, string>();
  blocks.forEach((block) => {
    const localeCode = String(block[1] || '').toLowerCase();
    const localeContent = String(block[2] || '').trim();
    if (localeCode && localeContent) {
      byLocale.set(localeCode, localeContent);
    }
  });

  return byLocale.get(normalizedLocale) || byLocale.get('en') || releaseNotes;
}

export class UpdateService {
  private static initialized = false;

  private static settings: UpdateSettings = {
    checkOnStartup: true,
    downloadMode: 'auto',
    autoInstallOnDownload: true,
    betaChannelEnabled: false,
  };

  private static state: UpdateState = {
    status: 'idle',
    currentVersion: '',
    platform: '',
    arch: '',
    canDownload: false,
    canInstall: false,
  };

  private static isValidSettings(settings: any): settings is UpdateSettings {
    return settings
      && typeof settings.checkOnStartup === 'boolean'
      && (settings.downloadMode === 'auto' || settings.downloadMode === 'manual')
      && typeof settings.autoInstallOnDownload === 'boolean'
      && typeof settings.betaChannelEnabled === 'boolean';
  }

  static initialize() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    const settings = IPCRenderer.sendSyncMessage(IPCCommChannel.AppReadUpdateSettings);
    if (this.isValidSettings(settings)) {
      this.settings = settings;
    }
    const state = IPCRenderer.sendSyncMessage(IPCCommChannel.AppReadUpdateState);
    if (state && typeof state.status === 'string') {
      this.state = state;
    }
    IPCRenderer.addMessageHandler(IPCRendererCommChannel.UIAppUpdateStateChanged, (nextState: UpdateState) => {
      this.state = nextState;
      window.dispatchEvent(new Event(updateChangedEventName));
    });
  }

  static subscribe(listener: (state: UpdateState) => void): () => void {
    const eventListener = () => listener(this.getState());
    window.addEventListener(updateChangedEventName, eventListener);
    return () => {
      window.removeEventListener(updateChangedEventName, eventListener);
    };
  }

  static getState(): UpdateState {
    return this.state;
  }

  static getSettings(): UpdateSettings {
    return this.settings;
  }

  static async setSettings(nextSettings: UpdateSettings): Promise<UpdateSettings> {
    const savedSettings = await IPCRenderer.sendAsyncMessage(IPCCommChannel.AppSaveUpdateSettings, nextSettings);
    if (this.isValidSettings(savedSettings)) {
      this.settings = savedSettings;
    }
    return this.settings;
  }

  static async checkForUpdates() {
    await IPCRenderer.sendAsyncMessage(IPCCommChannel.AppCheckForUpdates);
  }

  static async downloadUpdate() {
    await IPCRenderer.sendAsyncMessage(IPCCommChannel.AppDownloadUpdate);
  }

  static async installUpdate() {
    await IPCRenderer.sendAsyncMessage(IPCCommChannel.AppInstallUpdate);
  }

  static getWhatsNew(): WhatsNewPayload | undefined {
    const payload = IPCRenderer.sendSyncMessage(IPCCommChannel.AppReadWhatsNew);
    if (!payload || !payload.releaseNotes || !payload.version) {
      return undefined;
    }
    return {
      version: String(payload.version),
      releaseDate: String(payload.releaseDate || ''),
      releaseNotes: parseLocalizedReleaseNotes(String(payload.releaseNotes || ''), I18nService.locale),
    };
  }

  static dismissWhatsNew() {
    IPCRenderer.sendSyncMessage(IPCCommChannel.AppDismissWhatsNew);
  }
}
