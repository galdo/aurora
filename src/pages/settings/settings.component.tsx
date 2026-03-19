import React from 'react';
import { useSelector } from 'react-redux';
import classNames from 'classnames/bind';
import log from 'electron-log/renderer';
import fs from 'fs';
import path from 'path';

import {
  Button,
  Icon,
  MediaSettingsResetDialog,
  Link,
} from '../../components';

import { Icons, Links } from '../../constants';
import { useModal } from '../../contexts';
import { RootState } from '../../reducers';
import {
  AppService,
  BitPerfectService,
  DlnaService,
  I18nService,
  MediaLibraryService,
  UpdateService,
} from '../../services';
import { IDapSyncProgressSnapshot } from '../../services/media-library.service';
import { AppLocale } from '../../services/i18n.service';
import { ThemeService, ThemeMode } from '../../services/theme.service';
import { IPCCommChannel, IPCRenderer } from '../../modules/ipc';
import { mediaLocalStore, MediaLocalStateActionType } from '../../providers/media-local/media-local.store';
import { DlnaState } from '../../services/dlna.service';
import { BitPerfectState } from '../../services/bit-perfect.service';
import { UpdateSettings, UpdateState, WhatsNewPayload } from '../../services/update.service';

import styles from './settings.component.css';

const cx = classNames.bind(styles);
const appLogoModule = require('../../../assets/icons/icon-squircle-no-background.png');

const AppLogo = appLogoModule.default || appLogoModule;

const languageOptions: AppLocale[] = ['de', 'en', 'fr', 'it', 'es', 'pt', 'zh', 'ja', 'pl', 'tr', 'ru', 'hi'];

function sanitizeHtmlContent(rawHtml: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(rawHtml || ''), 'text/html');
  const blockedTags = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta'];
  blockedTags.forEach((tagName) => {
    doc.querySelectorAll(tagName).forEach(node => node.remove());
  });
  doc.querySelectorAll('*').forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const attributeName = String(attribute.name || '').toLowerCase();
      const attributeValue = String(attribute.value || '').trim().toLowerCase();
      if (attributeName.startsWith('on')) {
        element.removeAttribute(attribute.name);
        return;
      }
      if (
        (attributeName === 'href' || attributeName === 'src')
        && (
          attributeValue.startsWith(`java${'script'}:`)
          || attributeValue.startsWith('data:text/html')
        )
      ) {
        element.removeAttribute(attribute.name);
      }
    });
  });
  return doc.body.innerHTML;
}

function ProviderSettings() {
  const mediaProviderRegistry = useSelector((state: RootState) => state.mediaProviderRegistry);

  return (
    <>
      {
        mediaProviderRegistry.mediaProviders.map((mediaRegisteredProvider) => {
          const mediaProviderSettingsComponent = mediaRegisteredProvider.mediaSettingsService.getSettingsComponent();

          if (mediaProviderSettingsComponent) {
            return (
              <div
                key={mediaRegisteredProvider.mediaProviderIdentifier}
              >
                {React.createElement(mediaProviderSettingsComponent, {
                  cx,
                })}
              </div>
            );
          }

          return (
            <></>
          );
        })
      }
    </>
  );
}

const UI_SETTINGS_KEY = 'aurora:ui-settings';
type ArtistViewMode = 'off' | 'artists' | 'album_artists';

export function SettingsPage() {
  const { showModal } = useModal();
  const [themeMode, setThemeMode] = React.useState<ThemeMode>(ThemeService.mode);
  const [artistViewMode, setArtistViewMode] = React.useState<ArtistViewMode>('artists');
  const [locale, setLocale] = React.useState<AppLocale>(I18nService.locale);
  const [dapTargetDirectory, setDapTargetDirectory] = React.useState('');
  const [dapAutoSyncEnabled, setDapAutoSyncEnabled] = React.useState(false);
  const [dapDeleteMissingOnDevice, setDapDeleteMissingOnDevice] = React.useState(true);
  const [dapSyncProgress, setDapSyncProgress] = React.useState<IDapSyncProgressSnapshot>(MediaLibraryService.getDapSyncProgressSnapshot());
  const [dlnaState, setDlnaState] = React.useState<DlnaState>(DlnaService.getState());
  const [bitPerfectState, setBitPerfectState] = React.useState<BitPerfectState>(BitPerfectService.getState());
  const [updateSettings, setUpdateSettings] = React.useState<UpdateSettings>(UpdateService.getSettings());
  const [updateState, setUpdateState] = React.useState<UpdateState>(UpdateService.getState());
  const [updateSettingsSaving, setUpdateSettingsSaving] = React.useState(false);
  const [updateSettingsError, setUpdateSettingsError] = React.useState('');
  const [whatsNewPayload, setWhatsNewPayload] = React.useState<WhatsNewPayload | undefined>(() => UpdateService.getWhatsNew());
  const mediaLocalState = React.useSyncExternalStore(
    mediaLocalStore.subscribe,
    mediaLocalStore.getState,
  );

  React.useEffect(() => {
    const saved = localStorage.getItem(UI_SETTINGS_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        const parsedMode = String(parsed.artistViewMode || '').trim();
        if (parsedMode === 'off' || parsedMode === 'artists' || parsedMode === 'album_artists') {
          setArtistViewMode(parsedMode);
        } else {
          setArtistViewMode(parsed.hideArtist ? 'off' : 'artists');
        }
      } catch (e) {
        // ignore
      }
    }
  }, []);

  React.useEffect(() => {
    const settings = MediaLibraryService.getDapSyncSettings();
    setDapTargetDirectory(settings.targetDirectory);
    setDapAutoSyncEnabled(settings.autoSyncEnabled);
    setDapDeleteMissingOnDevice(settings.deleteMissingOnDevice);
  }, []);

  React.useEffect(() => MediaLibraryService.subscribeDapSyncProgress((snapshot) => {
    setDapSyncProgress(snapshot);
  }), []);

  React.useEffect(() => {
    DlnaService.initialize();
    BitPerfectService.initialize();
    UpdateService.initialize();
    setDlnaState(DlnaService.getState());
    setBitPerfectState(BitPerfectService.getState());
    setUpdateSettings(UpdateService.getSettings());
    setUpdateState(UpdateService.getState());
    setWhatsNewPayload(UpdateService.getWhatsNew());

    const unsubscribeDlna = DlnaService.subscribe((state) => {
      setDlnaState(state);
    });
    const unsubscribeBitPerfect = BitPerfectService.subscribe((state) => {
      setBitPerfectState(state);
    });
    const unsubscribeUpdate = UpdateService.subscribe((state) => {
      setUpdateState(state);
    });
    return () => {
      unsubscribeDlna();
      unsubscribeBitPerfect();
      unsubscribeUpdate();
    };
  }, []);

  React.useEffect(() => {
    const onLocaleChanged = () => {
      setLocale(I18nService.locale);
    };

    window.addEventListener('aurora:locale-changed', onLocaleChanged);
    return () => {
      window.removeEventListener('aurora:locale-changed', onLocaleChanged);
    };
  }, []);

  React.useEffect(() => {
    const logoCandidates = [
      path.resolve(process.cwd(), 'assets/icons/icon-squircle-no-background.png'),
      path.resolve(process.resourcesPath || '', 'assets/icons/icon-squircle-no-background.png'),
      path.resolve(__dirname, '../../../assets/icons/icon-squircle-no-background.png'),
    ];
    const uniqueLogoCandidates = Array.from(new Set(logoCandidates));
    uniqueLogoCandidates.forEach((candidatePath) => {
      log.info('[SETTINGS_LOGO] path="%s" exists=%s', candidatePath, fs.existsSync(candidatePath));
    });
  }, []);

  const updateArtistViewMode = (nextMode: ArtistViewMode) => {
    setArtistViewMode(nextMode);
    localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({
      hideArtist: nextMode === 'off',
      artistViewMode: nextMode,
    }));
    window.dispatchEvent(new Event('aurora:settings-changed'));
  };

  const persistDapSettings = (nextSettings: {
    targetDirectory: string;
    autoSyncEnabled: boolean;
    deleteMissingOnDevice: boolean;
  }) => {
    MediaLibraryService.saveDapSyncSettings(nextSettings);
    setDapTargetDirectory(nextSettings.targetDirectory);
    setDapAutoSyncEnabled(nextSettings.autoSyncEnabled);
    setDapDeleteMissingOnDevice(nextSettings.deleteMissingOnDevice);
  };

  const dapProgressPercent = dapSyncProgress.totalItems > 0
    ? Math.min(100, Math.round((dapSyncProgress.processedItems / dapSyncProgress.totalItems) * 100))
    : 0;
  const dapUnchangedFiles = Math.max(
    0,
    Number(dapSyncProgress.processedItems || 0) - Number(dapSyncProgress.copiedFiles || 0) - Number(dapSyncProgress.deletedFiles || 0),
  );
  const formatDuration = (durationMs?: number) => {
    if (!durationMs || durationMs <= 0) {
      return '0:00';
    }

    const totalSeconds = Math.ceil(durationMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  };
  const dapProgressStatusLabels = {
    idle: I18nService.getString('label_settings_dap_status_idle'),
    planning: I18nService.getString('label_settings_dap_status_planning'),
    copying: I18nService.getString('label_settings_dap_status_copying'),
    cleaning: I18nService.getString('label_settings_dap_status_cleaning'),
    done: I18nService.getString('label_settings_dap_status_done'),
    aborted: I18nService.getString('label_settings_dap_status_aborted'),
    error: I18nService.getString('label_settings_dap_status_error'),
  };
  const dapProgressStatusLabel = dapProgressStatusLabels[dapSyncProgress.phase] || I18nService.getString('label_settings_dap_status_idle');
  const originalRepositoryLink = Links.ProjectOriginal || Links.Project;
  const forkFeatureItems = [
    I18nService.getString('settings_info_feature_cd_import'),
    I18nService.getString('settings_info_feature_album_sorting'),
    I18nService.getString('settings_info_feature_podcasts'),
    I18nService.getString('settings_info_feature_playlists'),
    I18nService.getString('settings_info_feature_dap_sync'),
    I18nService.getString('settings_info_feature_multilanguage'),
    I18nService.getString('settings_info_feature_equalizer'),
    I18nService.getString('settings_info_feature_ui'),
  ];
  const aiSourceLinks = [
    {
      href: Links.SourceTrae,
      label: I18nService.getString('settings_info_ai_source_trae'),
    },
    {
      href: Links.SourceGptCodex,
      label: I18nService.getString('settings_info_ai_source_gpt_codex'),
    },
    {
      href: Links.SourceGeminiPro,
      label: I18nService.getString('settings_info_ai_source_gemini_pro'),
    },
  ];
  const whatsNewTitle = I18nService.getString('label_settings_whats_new');
  const whatsNewHtml = React.useMemo(() => sanitizeHtmlContent(String(whatsNewPayload?.releaseNotes || '')), [whatsNewPayload?.releaseNotes]);
  const updateStateLabelMap: Record<UpdateState['status'], string> = {
    idle: I18nService.getString('label_settings_updates_status_idle'),
    checking: I18nService.getString('label_settings_updates_status_checking'),
    available: I18nService.getString('label_settings_updates_status_available'),
    not_available: I18nService.getString('label_settings_updates_status_not_available'),
    downloading: I18nService.getString('label_settings_updates_status_downloading'),
    downloaded: I18nService.getString('label_settings_updates_status_downloaded'),
    installing: I18nService.getString('label_settings_updates_status_installing'),
    error: I18nService.getString('label_settings_updates_status_error'),
  };
  const autoUpdateEnabled = updateSettings.checkOnStartup
    && updateSettings.downloadMode === 'auto'
    && updateSettings.autoInstallOnDownload;
  const applyUpdateSettings = React.useCallback(async (nextSettings: UpdateSettings) => {
    setUpdateSettings(nextSettings);
    setUpdateSettingsSaving(true);
    setUpdateSettingsError('');
    try {
      const savedSettings = await UpdateService.setSettings(nextSettings);
      setUpdateSettings(savedSettings);
    } catch (error) {
      console.error(error);
      setUpdateSettings(UpdateService.getSettings());
      setUpdateSettingsError(I18nService.getString('label_settings_updates_save_error'));
    } finally {
      setUpdateSettingsSaving(false);
    }
  }, []);
  const groupCompilationsByFolder = mediaLocalState.settings?.library?.group_compilations_by_folder || false;
  const appDetails = AppService.details;
  const updateMessageUrlMatches = Array.from(String(updateState.message || '').matchAll(/https?:\/\/[^\s]+/g)).map(match => String(match[0]));
  const mediaKeysRegistered = !!appDetails.media_hardware_shortcuts_registered;
  const mediaKeysAccessibilityTrusted = appDetails.platform === 'darwin'
    ? !!appDetails.media_hardware_shortcuts_accessibility_trusted
    : true;
  const handleThemeChange = (mode: ThemeMode) => {
    ThemeService.set(mode);
    IPCRenderer.sendAsyncMessage(IPCCommChannel.AppSetThemeMode, mode).catch(() => undefined);
    setThemeMode(mode);
  };

  return (
    <div className={cx('settings-container', 'container-fluid')}>
      <div className={cx('settings-header')}>
        {I18nService.getString('label_settings_header')}
      </div>
      <div className={cx('settings-layout')}>
        <div className={cx('settings-main-column', 'app-scrollable')}>
          <div className={cx('settings-section', 'settings-card')}>
            <div className={cx('settings-heading')}>{I18nService.getString('label_settings_view_interface')}</div>
            <div className={cx('settings-content')}>
              <div className={cx('settings-row')}>
                <div>
                  <div className={cx('settings-subheading')}>{I18nService.getString('label_settings_theme')}</div>
                  <div className={cx('settings-description')}>{I18nService.getString('label_settings_theme_description')}</div>
                </div>
                <div className={cx('theme-switch')}>
                  <button
                    type="button"
                    className={cx('theme-switch-item', { active: themeMode === 'light' })}
                    onClick={() => handleThemeChange('light')}
                  >
                    {I18nService.getString('label_theme_light')}
                  </button>
                  <button
                    type="button"
                    className={cx('theme-switch-item', { active: themeMode === 'dark' })}
                    onClick={() => handleThemeChange('dark')}
                  >
                    {I18nService.getString('label_theme_dark')}
                  </button>
                  <button
                    type="button"
                    className={cx('theme-switch-item', { active: themeMode === 'auto' })}
                    onClick={() => handleThemeChange('auto')}
                  >
                    {I18nService.getString('label_theme_auto')}
                  </button>
                </div>
              </div>
              <div className={cx('settings-row')}>
                <div>
                  <div className={cx('settings-subheading')}>{I18nService.getString('label_settings_language')}</div>
                  <div className={cx('settings-description')}>{I18nService.getString('label_settings_language_description')}</div>
                </div>
                <div style={{ minWidth: '180px' }}>
                  <select
                    className="form-control"
                    value={locale}
                    onChange={(event) => {
                      I18nService.setLocale(event.target.value);
                    }}
                  >
                    {languageOptions.map(languageOption => (
                      <option key={languageOption} value={languageOption}>
                        {I18nService.getString(`label_language_${languageOption}`)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className={cx('settings-row')}>
                <div className={cx('settings-row-content')}>
                  <div className={cx('settings-subheading')}>{I18nService.getString('label_settings_artist_view_mode')}</div>
                  <div className={cx('settings-description')}>{I18nService.getString('label_settings_artist_view_mode_description')}</div>
                </div>
                <div className={cx('theme-switch', 'settings-row-switch-right')}>
                  <button
                    type="button"
                    className={cx('theme-switch-item', { active: artistViewMode === 'off' })}
                    onClick={() => updateArtistViewMode('off')}
                  >
                    {I18nService.getString('label_artist_view_mode_off')}
                  </button>
                  <button
                    type="button"
                    className={cx('theme-switch-item', { active: artistViewMode === 'album_artists' })}
                    onClick={() => updateArtistViewMode('album_artists')}
                  >
                    {I18nService.getString('label_artist_view_mode_album_artists')}
                  </button>
                  <button
                    type="button"
                    className={cx('theme-switch-item', { active: artistViewMode === 'artists' })}
                    onClick={() => updateArtistViewMode('artists')}
                  >
                    {I18nService.getString('label_artist_view_mode_artists')}
                  </button>
                </div>
              </div>
              <div className={cx('settings-row')}>
                <div>
                  <div className={cx('settings-subheading')}>{I18nService.getString('label_settings_group_compilations')}</div>
                  <div className={cx('settings-description')}>{I18nService.getString('label_settings_group_compilations_details')}</div>
                </div>
                <div className={cx('theme-switch')}>
                  <button
                    type="button"
                    className={cx('theme-switch-item', 'theme-switch-item-toggle', { active: groupCompilationsByFolder })}
                    onClick={() => {
                      mediaLocalStore.dispatch({
                        type: MediaLocalStateActionType.ToggleGroupCompilations,
                      });
                    }}
                  >
                    {groupCompilationsByFolder
                      ? I18nService.getString('label_toggle_on')
                      : I18nService.getString('label_toggle_off')}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className={cx('settings-section', 'settings-card')}>
            <div className={cx('settings-heading')}>{I18nService.getString('label_settings_sources_directories')}</div>
            <div className={cx('settings-content')}>
              <ProviderSettings/>
            </div>
          </div>

          {appDetails.platform === 'darwin' && (
            <div className={cx('settings-section', 'settings-card')}>
              <div className={cx('settings-heading')}>
                {I18nService.getString('label_settings_media_keys_heading')}
              </div>
              <div className={cx('settings-content')}>
                <div className={cx('settings-compact-meta')}>
                  <span className={cx('settings-compact-label')}>Shortcuts</span>
                  <strong>
                    {mediaKeysRegistered
                      ? I18nService.getString('label_settings_media_keys_status_active')
                      : I18nService.getString('label_settings_media_keys_status_inactive')}
                  </strong>
                  <span className={cx('settings-compact-separator')}>•</span>
                  <span className={cx('settings-compact-label')}>Accessibility</span>
                  <strong>
                    {mediaKeysAccessibilityTrusted
                      ? I18nService.getString('label_settings_media_keys_status_allowed')
                      : I18nService.getString('label_settings_media_keys_status_missing')}
                  </strong>
                </div>
                <details className={cx('settings-details-block')}>
                  <summary>{I18nService.getString('label_settings_media_keys_heading')}</summary>
                  <div className={cx('settings-technical-grid')}>
                    <div className={cx('settings-technical-item')}>
                      <span>{I18nService.getString('label_settings_media_keys_global_shortcuts')}</span>
                      <strong>
                        {mediaKeysRegistered
                          ? I18nService.getString('label_settings_media_keys_global_shortcuts_enabled')
                          : I18nService.getString('label_settings_media_keys_global_shortcuts_disabled')}
                      </strong>
                    </div>
                    <div className={cx('settings-technical-item')}>
                      <span>{I18nService.getString('label_settings_media_keys_accessibility')}</span>
                      <strong>
                        {mediaKeysAccessibilityTrusted
                          ? I18nService.getString('label_settings_media_keys_accessibility_allowed')
                          : I18nService.getString('label_settings_media_keys_accessibility_missing')}
                      </strong>
                    </div>
                  </div>
                  <div className={cx('settings-action-row')}>
                    <Link
                      href="x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
                      className={cx('settings-info-link')}
                    >
                      {I18nService.getString('label_settings_media_keys_open_accessibility')}
                    </Link>
                  </div>
                  <div className={cx('settings-description')}>
                    {I18nService.getString('label_settings_media_keys_restart_hint')}
                  </div>
                </details>
              </div>
            </div>
          )}

          <div className={cx('settings-section', 'settings-card')}>
            <div className={cx('settings-heading')}>
              DAP Sync
            </div>
            <div className={cx('settings-content')}>
              <div className={cx('settings-row')}>
                <div>
                  <div className={cx('settings-subheading')}>{I18nService.getString('label_settings_dap_target_directory')}</div>
                  <div className={cx('settings-description')}>
                    {dapTargetDirectory || I18nService.getString('label_settings_dap_no_directory')}
                  </div>
                </div>
                <Button
                  variant={['secondary']}
                  onButtonSubmit={() => {
                    const selectedDirectory = IPCRenderer.sendSyncMessage(IPCCommChannel.FSSelectDirectory);
                    if (!selectedDirectory) {
                      return;
                    }

                    persistDapSettings({
                      targetDirectory: selectedDirectory,
                      autoSyncEnabled: dapAutoSyncEnabled,
                      deleteMissingOnDevice: dapDeleteMissingOnDevice,
                    });
                  }}
                >
                  {I18nService.getString('button_settings_dap_select_directory')}
                </Button>
              </div>
              <div className={cx('settings-row')}>
                <div>
                  <div className={cx('settings-subheading')}>{I18nService.getString('label_settings_dap_auto_sync')}</div>
                  <div className={cx('settings-description')}>
                    {I18nService.getString('label_settings_dap_auto_sync_desc')}
                  </div>
                </div>
                <div className={cx('theme-switch')}>
                  <button
                    type="button"
                    className={cx('theme-switch-item', 'theme-switch-item-toggle', { active: dapAutoSyncEnabled })}
                    onClick={() => {
                      persistDapSettings({
                        targetDirectory: dapTargetDirectory,
                        autoSyncEnabled: !dapAutoSyncEnabled,
                        deleteMissingOnDevice: dapDeleteMissingOnDevice,
                      });
                    }}
                  >
                    {dapAutoSyncEnabled
                      ? I18nService.getString('label_toggle_on')
                      : I18nService.getString('label_toggle_off')}
                  </button>
                </div>
              </div>
              <div className={cx('settings-row')}>
                <div>
                  <div className={cx('settings-subheading')}>{I18nService.getString('label_settings_dap_delete_missing')}</div>
                  <div className={cx('settings-description')}>
                    {I18nService.getString('label_settings_dap_delete_missing_desc')}
                  </div>
                </div>
                <div className={cx('theme-switch')}>
                  <button
                    type="button"
                    className={cx('theme-switch-item', 'theme-switch-item-toggle', { active: dapDeleteMissingOnDevice })}
                    onClick={() => {
                      persistDapSettings({
                        targetDirectory: dapTargetDirectory,
                        autoSyncEnabled: dapAutoSyncEnabled,
                        deleteMissingOnDevice: !dapDeleteMissingOnDevice,
                      });
                    }}
                  >
                    {dapDeleteMissingOnDevice
                      ? I18nService.getString('label_toggle_on')
                      : I18nService.getString('label_toggle_off')}
                  </button>
                </div>
              </div>
              <div className={cx('dap-progress-container')}>
                <div className={cx('dap-progress-header')}>
                  <span className={cx('dap-progress-header-title')}>
                    <span>{dapProgressStatusLabel}</span>
                    {dapSyncProgress.isRunning && (
                      <button
                        type="button"
                        className={cx('dap-progress-cancel-button')}
                        onClick={() => {
                          MediaLibraryService.cancelDapLibrarySync();
                        }}
                        title="Kopiervorgang abbrechen"
                        aria-label="Kopiervorgang abbrechen"
                      >
                        <Icon name={Icons.Close}/>
                      </button>
                    )}
                  </span>
                  <span className={cx('dap-progress-header-actions')}>
                    <span>
                      {dapProgressPercent}
                      %
                    </span>
                  </span>
                </div>
                <div className={cx('dap-progress-track')}>
                  <div
                    className={cx('dap-progress-bar')}
                    style={{
                      width: `${dapProgressPercent}%`,
                    }}
                  />
                </div>
                <div className={cx('dap-progress-meta')}>
                  <span className={cx('dap-progress-meta-item')}>
                    Geprüft
                    {' '}
                    {dapSyncProgress.processedItems}
                    {' / '}
                    {dapSyncProgress.totalItems}
                  </span>
                  <span className={cx('dap-progress-meta-separator')}>•</span>
                  <span className={cx('dap-progress-meta-item')}>
                    Kopiert
                    {' '}
                    {dapSyncProgress.copiedFiles}
                  </span>
                  <span className={cx('dap-progress-meta-separator')}>•</span>
                  <span className={cx('dap-progress-meta-item')}>
                    Unverändert
                    {' '}
                    {dapUnchangedFiles}
                  </span>
                  <span className={cx('dap-progress-meta-separator')}>•</span>
                  <span className={cx('dap-progress-meta-item')}>
                    Gelöscht
                    {' '}
                    {dapSyncProgress.deletedFiles}
                  </span>
                  <span className={cx('dap-progress-meta-separator')}>•</span>
                  <span className={cx('dap-progress-meta-item')}>
                    {I18nService.getString('label_settings_dap_time_remaining')}
                    {' '}
                    {formatDuration(dapSyncProgress.etaMs)}
                  </span>
                </div>
                {!!dapSyncProgress.resumedFromProcessedItems && !dapSyncProgress.isRunning && (
                  <div className={cx('settings-description')}>
                    {I18nService.getString('label_settings_dap_resumable', {
                      count: String(dapSyncProgress.resumedFromProcessedItems),
                    })}
                  </div>
                )}
                {dapSyncProgress.errorMessage && (
                  <div className={cx('settings-description')}>
                    {dapSyncProgress.errorMessage}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className={cx('settings-section', 'settings-card')}>
            <div className={cx('settings-heading')}>
              {I18nService.getString('label_settings_audio_output')}
            </div>
            <div className={cx('settings-content')}>
              <div className={cx('settings-row')}>
                <div>
                  <div className={cx('settings-subheading')}>{I18nService.getString('label_settings_bit_perfect')}</div>
                  <div className={cx('settings-description')}>
                    {I18nService.getString('label_settings_bit_perfect_description')}
                  </div>
                  <div className={cx('settings-compact-meta')}>
                    <span className={cx('settings-compact-label')}>{I18nService.getString('label_settings_status')}</span>
                    <strong>
                      {bitPerfectState.active
                        ? I18nService.getString('label_settings_status_active')
                        : I18nService.getString('label_settings_status_idle')}
                    </strong>
                    <span className={cx('settings-compact-separator')}>•</span>
                    <span className={cx('settings-compact-label')}>{I18nService.getString('label_settings_backend')}</span>
                    <strong>{bitPerfectState.backend}</strong>
                  </div>
                </div>
                <div className={cx('theme-switch')}>
                  <button
                    type="button"
                    className={cx('theme-switch-item', 'theme-switch-item-toggle', { active: bitPerfectState.enabled })}
                    onClick={() => {
                      BitPerfectService.setEnabled(!bitPerfectState.enabled).catch((error) => {
                        console.error(error);
                      });
                    }}
                  >
                    {bitPerfectState.enabled
                      ? I18nService.getString('label_toggle_on')
                      : I18nService.getString('label_toggle_off')}
                  </button>
                </div>
              </div>
              <div className={cx('settings-row')}>
                <div>
                  <div className={cx('settings-subheading')}>{I18nService.getString('label_settings_dlna_server')}</div>
                  <div className={cx('settings-description')}>
                    {I18nService.getString('label_settings_dlna_server_description')}
                  </div>
                  <div className={cx('settings-compact-meta')}>
                    <span className={cx('settings-compact-label')}>{I18nService.getString('label_settings_status')}</span>
                    <strong>
                      {dlnaState.running
                        ? I18nService.getString('label_settings_status_running')
                        : I18nService.getString('label_settings_status_stopped')}
                    </strong>
                    <span className={cx('settings-compact-separator')}>•</span>
                    <span className={cx('settings-compact-label')}>{I18nService.getString('label_settings_server')}</span>
                    <strong>{`${(dlnaState.ipAddresses[0] || dlnaState.hostname || 'localhost')}:${dlnaState.port}`}</strong>
                  </div>
                </div>
                <div className={cx('theme-switch')}>
                  <button
                    type="button"
                    className={cx('theme-switch-item', 'theme-switch-item-toggle', { active: dlnaState.enabled })}
                    onClick={() => {
                      DlnaService.setEnabled(!dlnaState.enabled).catch((error) => {
                        console.error(error);
                      });
                    }}
                  >
                    {dlnaState.enabled
                      ? I18nService.getString('label_toggle_on')
                      : I18nService.getString('label_toggle_off')}
                  </button>
                </div>
              </div>
              {(bitPerfectState.lastError || dlnaState.lastError) && (
                <div className={cx('settings-inline-error')}>
                  {bitPerfectState.lastError || dlnaState.lastError}
                </div>
              )}
              <details className={cx('settings-details-block')}>
                <summary>{I18nService.getString('label_settings_technical_diagnostics')}</summary>
                <div className={cx('settings-technical-grid')}>
                  <div className={cx('settings-technical-item')}>
                    <span>{I18nService.getString('label_settings_dlna_description_url')}</span>
                    <strong>{dlnaState.descriptionUrl}</strong>
                  </div>
                  <div className={cx('settings-technical-item')}>
                    <span>{I18nService.getString('label_settings_dlna_content_url')}</span>
                    <strong>{dlnaState.contentUrl}</strong>
                  </div>
                  <div className={cx('settings-technical-item')}>
                    <span>{I18nService.getString('label_settings_dlna_stream_url')}</span>
                    <strong>{dlnaState.currentStreamUrl}</strong>
                  </div>
                  <div className={cx('settings-technical-item')}>
                    <span>{I18nService.getString('label_settings_dlna_network')}</span>
                    <strong>{dlnaState.ipAddresses.join(', ') || '-'}</strong>
                  </div>
                  <div className={cx('settings-technical-item')}>
                    <span>{I18nService.getString('label_settings_bit_perfect_binary')}</span>
                    <strong>{bitPerfectState.binaryPath || '-'}</strong>
                  </div>
                  <div className={cx('settings-technical-item')}>
                    <span>{I18nService.getString('label_settings_bit_perfect_process_id')}</span>
                    <strong>{bitPerfectState.processId || '-'}</strong>
                  </div>
                </div>
              </details>
            </div>
          </div>

          <div className={cx('settings-section', 'settings-card')}>
            <div className={cx('settings-heading')}>
              {I18nService.getString('label_settings_updates_heading')}
            </div>
            <div className={cx('settings-content')}>
              <div className={cx('settings-row')}>
                <div>
                  <div className={cx('settings-subheading')}>{I18nService.getString('label_settings_updates_auto')}</div>
                  <div className={cx('settings-description')}>
                    {I18nService.getString('label_settings_updates_auto_description')}
                  </div>
                </div>
                <div className={cx('theme-switch')}>
                  <button
                    type="button"
                    className={cx('theme-switch-item', 'theme-switch-item-toggle', { active: autoUpdateEnabled })}
                    disabled={updateSettingsSaving}
                    onClick={() => {
                      const currentSettings = updateSettings;
                      if (autoUpdateEnabled) {
                        applyUpdateSettings({
                          checkOnStartup: false,
                          downloadMode: 'manual',
                          autoInstallOnDownload: false,
                          betaChannelEnabled: currentSettings.betaChannelEnabled,
                        }).catch(console.error);
                      } else {
                        applyUpdateSettings({
                          checkOnStartup: true,
                          downloadMode: 'auto',
                          autoInstallOnDownload: true,
                          betaChannelEnabled: currentSettings.betaChannelEnabled,
                        }).catch(console.error);
                      }
                    }}
                  >
                    {autoUpdateEnabled
                      ? I18nService.getString('label_toggle_on')
                      : I18nService.getString('label_toggle_off')}
                  </button>
                </div>
              </div>
              <div className={cx('settings-row')}>
                <div>
                  <div className={cx('settings-subheading')}>{I18nService.getString('label_settings_updates_beta_channel')}</div>
                  <div className={cx('settings-description')}>
                    {I18nService.getString('label_settings_updates_beta_description')}
                  </div>
                </div>
                <div className={cx('theme-switch')}>
                  <button
                    type="button"
                    className={cx('theme-switch-item', 'theme-switch-item-toggle', { active: updateSettings.betaChannelEnabled })}
                    disabled={updateSettingsSaving}
                    onClick={() => {
                      applyUpdateSettings({
                        ...updateSettings,
                        betaChannelEnabled: !updateSettings.betaChannelEnabled,
                      }).catch(console.error);
                    }}
                  >
                    {updateSettings.betaChannelEnabled
                      ? I18nService.getString('label_toggle_on')
                      : I18nService.getString('label_toggle_off')}
                  </button>
                </div>
              </div>
              <div className={cx('settings-compact-meta')}>
                <span className={cx('settings-compact-label')}>{I18nService.getString('label_settings_status')}</span>
                <strong>{updateStateLabelMap[updateState.status]}</strong>
                {updateState.availableVersion && (
                  <>
                    <span className={cx('settings-compact-separator')}>•</span>
                    <span className={cx('settings-compact-label')}>{I18nService.getString('label_settings_version')}</span>
                    <strong>{updateState.availableVersion}</strong>
                  </>
                )}
                {Number.isFinite(updateState.downloadProgressPercent) && (
                  <>
                    <span className={cx('settings-compact-separator')}>•</span>
                    <span className={cx('settings-compact-label')}>{I18nService.getString('label_settings_download')}</span>
                    <strong>{`${Math.round(Number(updateState.downloadProgressPercent || 0))}%`}</strong>
                  </>
                )}
              </div>
              {!!updateSettingsError && (
                <div className={cx('settings-inline-error')}>
                  {updateSettingsError}
                </div>
              )}
              {!!updateState.message && (
                <div className={cx('settings-inline-error')}>
                  {updateState.message}
                  {updateMessageUrlMatches.length > 0 && (
                    <div className={cx('settings-info-source-links')}>
                      {updateMessageUrlMatches.map(url => (
                        <Link key={url} href={url} className={cx('settings-info-link')}>
                          {url}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {!autoUpdateEnabled && (
                <div className={cx('settings-action-row')}>
                  <Button
                    variant={['secondary']}
                    onButtonSubmit={() => {
                      UpdateService.checkForUpdates().catch(console.error);
                    }}
                  >
                    {I18nService.getString('button_settings_check_updates')}
                  </Button>
                  {updateState.canDownload && (
                    <Button
                      variant={['secondary']}
                      onButtonSubmit={() => {
                        UpdateService.downloadUpdate().catch(console.error);
                      }}
                    >
                      {I18nService.getString('button_settings_download_update')}
                    </Button>
                  )}
                  {updateState.canInstall && (
                    <Button
                      variant={['secondary']}
                      onButtonSubmit={() => {
                        UpdateService.installUpdate().catch(console.error);
                      }}
                    >
                      {I18nService.getString('button_settings_install_update')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className={cx('settings-section', 'settings-card')}>
            <div className={cx('settings-heading')}>
              {I18nService.getString('label_settings_maintenance')}
            </div>
            <div className={cx('settings-content')}>
              <div>
                {I18nService.getString('label_settings_reset_app_description')}
              </div>
              <div>
                <Button
                  className={cx('settings-reset-button')}
                  variant={['danger']}
                  onButtonSubmit={() => {
                    showModal(MediaSettingsResetDialog);
                  }}
                >
                  {I18nService.getString('button_settings_reset_app')}
                </Button>
              </div>
            </div>
          </div>
        </div>
        <aside className={cx('settings-info-column', 'app-scrollable', 'locked')}>
          <div className={cx('settings-info-heading')}>
            {I18nService.getString('label_settings_info')}
          </div>
          <div className={cx('settings-info-content')}>
            <div className={cx('settings-info-item')}>
              <Icon name={Icons.Github}/>
              <div>
                <div className={cx('settings-info-title')}>{I18nService.getString('settings_info_fork_title')}</div>
                <div className={cx('settings-description')}>
                  {I18nService.getString('settings_info_fork_desc_1')}
                </div>
                <div className={cx('settings-description')}>
                  {I18nService.getString('settings_info_fork_desc_2')}
                </div>
                <div className={cx('settings-description')}>
                  {I18nService.getString('settings_info_fork_desc_3')}
                </div>
                <div className={cx('settings-info-subtitle')}>{I18nService.getString('settings_info_feature_list_title')}</div>
                <ul className={cx('settings-info-feature-list')}>
                  {forkFeatureItems.map(featureItem => (
                    <li key={featureItem}>{featureItem}</li>
                  ))}
                </ul>
                <Link href={originalRepositoryLink} className={cx('settings-info-link')}>
                  {I18nService.getString('link_open_original_repo')}
                </Link>
              </div>
            </div>
            <div className={cx('settings-info-item')}>
              <Icon name={Icons.Refresh}/>
              <div>
                <div className={cx('settings-info-title')}>{I18nService.getString('settings_info_ai_title')}</div>
                <div className={cx('settings-description')}>
                  {I18nService.getString('settings_info_ai_desc')}
                </div>
                <div className={cx('settings-info-source-links')}>
                  {aiSourceLinks.map(sourceLink => (
                    <Link
                      key={sourceLink.href}
                      href={sourceLink.href}
                      className={cx('settings-info-source-link')}
                    >
                      {sourceLink.label}
                    </Link>
                  ))}
                </div>
              </div>
            </div>
            <div className={cx('settings-info-item')}>
              <Icon name={Icons.Bug}/>
              <div>
                <div className={cx('settings-info-title')}>
                  {`${appDetails.display_name} ${appDetails.version} (${appDetails.build})`}
                </div>
                <Link href={Links.ProjectReportIssue} className={cx('settings-info-link')}>
                  {I18nService.getString('link_report_issue')}
                </Link>
              </div>
            </div>
            {whatsNewPayload && (
              <div className={cx('settings-info-item')}>
                <Icon name={Icons.Refresh}/>
                <div>
                  <div className={cx('settings-info-title')}>
                    {`${whatsNewTitle} (${whatsNewPayload.version})`}
                  </div>
                  <div className={cx('settings-description', 'settings-whats-new-content')}>
                    <div dangerouslySetInnerHTML={{ __html: whatsNewHtml }}/>
                  </div>
                  <div className={cx('settings-action-row')}>
                    <Button
                      variant={['secondary']}
                      onButtonSubmit={() => {
                        UpdateService.dismissWhatsNew();
                        setWhatsNewPayload(undefined);
                      }}
                    >
                      {I18nService.getString('button_settings_mark_read')}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className={cx('settings-info-logo')}>
            <img src={AppLogo} alt="Aurora Pulse Logo" className={cx('settings-info-logo-image')}/>
          </div>
        </aside>
      </div>
    </div>
  );
}
