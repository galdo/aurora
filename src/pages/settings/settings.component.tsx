import React, { useMemo } from 'react';
import { useSelector } from 'react-redux';
import classNames from 'classnames/bind';

import {
  Button,
  Icon,
  MediaSettingsResetDialog,
  Link,
} from '../../components';

import { Icons, Links } from '../../constants';
import { useModal } from '../../contexts';
import { RootState } from '../../reducers';
import { AppService, I18nService, MediaLibraryService } from '../../services';
import { IDapSyncProgressSnapshot } from '../../services/media-library.service';
import { AppLocale } from '../../services/i18n.service';
import { ThemeService, ThemeMode } from '../../services/theme.service';
import { IPCCommChannel, IPCRenderer } from '../../modules/ipc';
import { mediaLocalStore, MediaLocalStateActionType } from '../../providers/media-local/media-local.store';

import styles from './settings.component.css';

const cx = classNames.bind(styles);
const AppLogo = require('../../../assets/icons/icon.png');

const languageOptions: AppLocale[] = ['de', 'en', 'fr', 'it', 'es'];

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

export function SettingsPage() {
  const { showModal } = useModal();
  const themeMode = useMemo<ThemeMode>(() => ThemeService.mode, []);
  const [hideArtist, setHideArtist] = React.useState(false);
  const [locale, setLocale] = React.useState<AppLocale>(I18nService.locale);
  const [dapTargetDirectory, setDapTargetDirectory] = React.useState('');
  const [dapAutoSyncEnabled, setDapAutoSyncEnabled] = React.useState(false);
  const [dapDeleteMissingOnDevice, setDapDeleteMissingOnDevice] = React.useState(true);
  const [dapSyncProgress, setDapSyncProgress] = React.useState<IDapSyncProgressSnapshot>(MediaLibraryService.getDapSyncProgressSnapshot());
  const mediaLocalState = React.useSyncExternalStore(
    mediaLocalStore.subscribe,
    mediaLocalStore.getState,
  );

  React.useEffect(() => {
    const saved = localStorage.getItem(UI_SETTINGS_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setHideArtist(!!parsed.hideArtist);
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
    const onLocaleChanged = () => {
      setLocale(I18nService.locale);
    };

    window.addEventListener('aurora:locale-changed', onLocaleChanged);
    return () => {
      window.removeEventListener('aurora:locale-changed', onLocaleChanged);
    };
  }, []);

  const toggleHideArtist = () => {
    const newValue = !hideArtist;
    setHideArtist(newValue);
    localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({ hideArtist: newValue }));
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
  const groupCompilationsByFolder = mediaLocalState.settings?.library?.group_compilations_by_folder || false;

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
                    onClick={() => ThemeService.set('light')}
                  >
                    {I18nService.getString('label_theme_light')}
                  </button>
                  <button
                    type="button"
                    className={cx('theme-switch-item', { active: themeMode === 'dark' })}
                    onClick={() => ThemeService.set('dark')}
                  >
                    {I18nService.getString('label_theme_dark')}
                  </button>
                  <button
                    type="button"
                    className={cx('theme-switch-item', { active: themeMode === 'auto' })}
                    onClick={() => ThemeService.set('auto')}
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
                <div>
                  <div className={cx('settings-subheading')}>{I18nService.getString('label_settings_hide_artist')}</div>
                  <div className={cx('settings-description')}>{I18nService.getString('label_settings_hide_artist_description')}</div>
                </div>
                <div className={cx('theme-switch')}>
                  <button
                    type="button"
                    className={cx('theme-switch-item', { active: hideArtist })}
                    onClick={toggleHideArtist}
                  >
                    {hideArtist
                      ? I18nService.getString('label_toggle_on')
                      : I18nService.getString('label_toggle_off')}
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
                    className={cx('theme-switch-item', { active: groupCompilationsByFolder })}
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
                    className={cx('theme-switch-item', { active: dapAutoSyncEnabled })}
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
                    className={cx('theme-switch-item', { active: dapDeleteMissingOnDevice })}
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
                  <span>{dapProgressStatusLabel}</span>
                  <span>
                    {dapProgressPercent}
                    %
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
                  <span>
                    {dapSyncProgress.processedItems}
                    {' / '}
                    {dapSyncProgress.totalItems}
                  </span>
                  <span>
                    {I18nService.getString('label_settings_dap_time_remaining')}
                    {' '}
                    {formatDuration(dapSyncProgress.etaMs)}
                  </span>
                </div>
                {!!dapSyncProgress.resumedFromProcessedItems && !dapSyncProgress.isRunning && (
                  <div className={cx('settings-description')}>
                    {I18nService.getString('label_settings_dap_resumable').replace('{count}', String(dapSyncProgress.resumedFromProcessedItems))}
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
          <div className={cx('settings-info-logo')} style={{ backgroundImage: `url(${AppLogo})` }}/>
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
              </div>
            </div>
            <div className={cx('settings-info-item')}>
              <Icon name={Icons.Bug}/>
              <div>
                <div className={cx('settings-info-title')}>
                  {`${AppService.details.display_name} ${AppService.details.version} (${AppService.details.build})`}
                </div>
                <Link href={Links.ProjectReportIssue} className={cx('settings-info-link')}>
                  {I18nService.getString('link_report_issue')}
                </Link>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
