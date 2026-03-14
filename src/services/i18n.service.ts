import LocalizedStrings, { LocalizedStringsMethods } from 'react-localization';

import { IPCRenderer, IPCCommChannel } from '../modules/ipc';

export type AppLocale = 'de' | 'en' | 'fr' | 'it' | 'es' | 'pt' | 'zh' | 'ja' | 'pl' | 'tr' | 'ru' | 'hi';

export class I18nService {
  private static readonly localeAssetPath = 'locales';
  private static readonly localeDefault: AppLocale = 'en';
  private static readonly localeStorageKey = 'app_locale';
  private static readonly localeChangeEventName = 'aurora:locale-changed';
  private static readonly localeSupported: AppLocale[] = ['de', 'en', 'fr', 'it', 'es', 'pt', 'zh', 'ja', 'pl', 'tr', 'ru', 'hi'];
  private static readonly localeStrings: LocalizedStringsMethods = new LocalizedStrings({
    de: this.getLocaleFile('de'),
    en: this.getLocaleFile('en'),
    fr: this.getLocaleFile('fr'),
    it: this.getLocaleFile('it'),
    es: this.getLocaleFile('es'),
    pt: this.getLocaleFile('pt'),
    zh: this.getLocaleFile('zh'),
    ja: this.getLocaleFile('ja'),
    pl: this.getLocaleFile('pl'),
    tr: this.getLocaleFile('tr'),
    ru: this.getLocaleFile('ru'),
    hi: this.getLocaleFile('hi'),
  });

  static getString(key: string, values?: Record<string, string | number | JSX.Element>): string {
    const languageStrings = this.localeStrings as unknown as Record<string, string>;
    const template = languageStrings[key] || key;
    // @ts-ignore
    return this.localeStrings.formatString(template, values) as string;
  }

  static initialize(): void {
    const localeStored = localStorage.getItem(this.localeStorageKey);
    if (this.isLocaleSupported(localeStored)) {
      this.setLocale(localeStored, false);
      return;
    }

    this.setLocale(this.getSystemLocale(), false);
  }

  static get locale(): AppLocale {
    const localeCurrent = this.localeStrings.getLanguage();
    if (this.isLocaleSupported(localeCurrent)) {
      return localeCurrent;
    }

    return this.localeDefault;
  }

  static setLocale(locale: string, persist = true): void {
    const localeNormalized = this.isLocaleSupported(locale)
      ? locale
      : this.localeDefault;
    this.localeStrings.setLanguage(localeNormalized);
    document.documentElement.setAttribute('lang', localeNormalized);

    if (persist) {
      localStorage.setItem(this.localeStorageKey, localeNormalized);
    }

    window.dispatchEvent(new Event(this.localeChangeEventName));
  }

  private static getSystemLocale(): AppLocale {
    const localeSystem = navigator.language
      .toLowerCase()
      .split('-')[0];
    if (this.isLocaleSupported(localeSystem)) {
      return localeSystem;
    }

    return this.localeDefault;
  }

  private static isLocaleSupported(locale?: string | null): locale is AppLocale {
    return !!locale && this.localeSupported.includes(locale as AppLocale);
  }

  private static getLocaleFile(locale: string): object {
    const localeRaw = IPCRenderer.sendSyncMessage(IPCCommChannel.FSReadAsset, [this.localeAssetPath, `${locale}.json`], {
      encoding: 'utf8',
    });
    return JSON.parse(localeRaw);
  }
}
