/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `yarn build` or `yarn build:main`, this file is compiled to
 * `./src/main.prod.js` using webpack. This gives us some performance wins.
 *
 * TODO: Using defaults, following to be looked into before release
 *  - Debug Support
 *  - Auto Update Support
 *  - Logging Support
 *  - Source Map Support
 */

import 'core-js/stable';
import 'regenerator-runtime/runtime';

import path from 'path';
import fs from 'fs';
import http, { IncomingMessage, ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { execFile } from 'child_process';
import * as electronUpdater from 'electron-updater';
import electronLog from 'electron-log/main';
import electronDebug from 'electron-debug';
import _ from 'lodash';

import installExtension, {
  REACT_DEVELOPER_TOOLS,
  REDUX_DEVTOOLS,
} from 'electron-devtools-installer';

import {
  app,
  shell,
  BrowserWindow,
  screen,
  globalShortcut,
  systemPreferences,
  nativeTheme,
} from 'electron';

import {
  IAppMain,
  IAppBuilder,
  IAppModule,
} from './interfaces';

import { IPCMain, IPCCommChannel, IPCRendererCommChannel } from './modules/ipc';
import { PlatformOS } from './modules/platform';
import { DatastoreModule } from './modules/datastore';
import { FileSystemModule } from './modules/file-system';
import { ImageModule } from './modules/image';
import { DeviceModule } from './modules/device';

import { MenuBuilder } from './main/builders';

const sourceMapSupport = require('source-map-support');
const debug = require('debug')('aurora_pulse:main');

const APP_DISPLAY_NAME = 'Aurora Pulse';
const APP_DATA_DIR_NAME = 'Aurora_Pulse';
const APP_LEGACY_DATA_DIR_NAMES = ['AI_Music_Player', 'Aurora'];
type MediaHardwareControlAction = 'play_pause' | 'next_track' | 'previous_track' | 'stop' | 'volume_up' | 'volume_down' | 'volume_mute';
type AppUpdateStatus = 'idle' | 'checking' | 'available' | 'not_available' | 'downloading' | 'downloaded' | 'installing' | 'error';
type UpdateDownloadMode = 'auto' | 'manual';

type AppUpdateSettings = {
  checkOnStartup: boolean;
  downloadMode: UpdateDownloadMode;
  autoInstallOnDownload: boolean;
  betaChannelEnabled: boolean;
};

type AppUpdateState = {
  status: AppUpdateStatus;
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
type AppThemeMode = 'light' | 'dark' | 'auto';
type AppWindowState = {
  hasLaunched?: boolean;
  hasCustomizedWindowState?: boolean;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  isMaximized?: boolean;
  isFullScreen?: boolean;
};

type AppWhatsNewPayload = {
  version: string;
  releaseDate?: string;
  releaseNotes: string;
};

function createElectronLogger(name: string, filePath: string) {
  const logger = electronLog.create({ logId: name });
  logger.transports.file.level = 'info';
  logger.transports.file.maxSize = 10 * 1024 * 1024; // 10 MB
  logger.transports.file.format = `[${name}] [{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}`;
  logger.transports.file.resolvePathFn = () => filePath;

  return logger;
}

class App implements IAppMain {
  readonly env?: string;
  readonly debug: boolean;
  readonly prod: boolean;
  readonly version?: string;
  readonly build?: string;
  readonly platform?: string;
  readonly displayName = APP_DISPLAY_NAME;
  readonly description = 'A local-first music player built with Electron';

  private mainWindow?: BrowserWindow;
  private splashWindow?: BrowserWindow;
  private readonly forceExtensionDownload: boolean;
  private readonly startMinimized?: boolean;
  private readonly resourcesPath: string;
  private readonly htmlFilePath: string;
  private readonly builders: IAppBuilder[] = [];
  private readonly modules: IAppModule[] = [];
  private readonly windowDefaultSizeRatio = 0.8;
  private readonly windowMinWidth = 900;
  private readonly windowMinHeight = 560;
  private readonly dataPath: string;
  private isQuitting = false;
  private localProtocols = new Set(['file:', 'app:']);
  private logsDataDir = 'Logs';
  private logsMainFile = 'main.log';
  private logsRendererFile = 'renderer.log';
  private diagnosticsControlServer?: http.Server;
  private diagnosticsControlToken = '';
  private diagnosticsControlPort = 0;
  private mediaHardwareShortcutRegistrationDisabled = false;
  private mediaHardwareShortcutWarningShown = false;
  private mediaHardwareShortcutLastAttemptAt = 0;
  private mediaHardwareShortcutsRegistered = false;
  private readonly updateSettingsFileName = 'update.settings.json';
  private readonly themeSettingsFileName = 'theme.settings.json';
  private readonly windowStateFileName = 'window.settings.json';
  private readonly whatsNewFileName = 'update.whats-new.json';
  private readonly updateCheckTimeoutMs = 45000;
  private updateSettings: AppUpdateSettings = {
    checkOnStartup: true,
    downloadMode: 'auto',
    autoInstallOnDownload: true,
    betaChannelEnabled: false,
  };

  private updateState: AppUpdateState = {
    status: 'idle',
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    canDownload: false,
    canInstall: false,
  };

  private pendingWhatsNew?: AppWhatsNewPayload;
  private autoUpdaterRegistered = false;
  private rendererEventsRegistered = false;
  private nativeThemeListenerRegistered = false;
  private latestUpdateInfo?: any;
  private themeMode: AppThemeMode = 'auto';

  constructor() {
    this.env = process.env.NODE_ENV;
    this.debug = process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';
    this.prod = process.env.NODE_ENV === 'production';
    this.version = process.env.APP_VERSION;
    this.build = process.env.BUILD_VERSION;
    this.platform = process.platform;
    this.forceExtensionDownload = !!process.env.UPGRADE_EXTENSIONS;
    this.startMinimized = process.env.START_MINIMIZED === 'true';
    this.resourcesPath = process.resourcesPath;
    this.dataPath = this.debug ? `${APP_DATA_DIR_NAME}-debug` : APP_DATA_DIR_NAME;
    this.htmlFilePath = path.join(__dirname, 'index.html');

    this.configureUserDataPath();
    this.migrateLegacyUserDataPath();
    this.configureLogger();
    this.loadUpdateSettings();
    this.loadThemeSettings();
    this.loadPendingWhatsNew();
    this.configureApp();
    this.installSourceMapSupport();
    this.installDebugSupport();
    this.registerBuilders();
    this.registerModules();
    this.registerEvents();

    // console.log generally not allowed, but this one is important
    // eslint-disable-next-line no-console
    console.log('[MAIN_INIT] - %o', {
      env: this.env,
      debug: this.debug,
      prod: this.prod,
      version: this.version,
      build: process.env.BUILD_VERSION,
      platform: this.platform,
      chromium: _.get(process, 'versions.chrome'),
      time: new Date().toISOString(),
    });
  }

  quit(): void {
    app.quit();
  }

  sendMessageToRenderer(messageChannel: string, ...messageArgs: any[]): any {
    const window = this.mainWindow;
    if (!window || window.isDestroyed()) {
      return;
    }
    window.webContents.send(messageChannel, ...messageArgs);
  }

  getAssetPath(...paths: string[]): string {
    const appAssetsPath = app.isPackaged
      ? path.join(this.resourcesPath, 'assets')
      : path.join(__dirname, '../assets');

    return path.join(appAssetsPath, ...paths);
  }

  getDataPath(...paths: string[]): string {
    return path.join(app.getPath('userData'), ...paths);
  }

  getLogsPath(file?: string) {
    if (file) {
      return this.getDataPath(this.logsDataDir, file);
    }

    return this.getDataPath(this.logsDataDir);
  }

  createDataDir(...paths: string[]): string {
    const dataPath = this.getDataPath(...paths);
    fs.mkdirSync(dataPath, { recursive: true });

    return dataPath;
  }

  getCurrentWindow(): BrowserWindow {
    if (!this.mainWindow) {
      throw new Error('App encountered error at getCurrentWindow - App currently has no current window');
    }

    return this.mainWindow;
  }

  getModule<T>(type: { new(data: any): T }): T {
    const module = this.modules.find(m => m instanceof type);
    if (!module) {
      throw new Error(`App encountered error at getModule - Module not found - ${type.name}`);
    }

    return module as T;
  }

  openPath(pathToOpen: string): void {
    shell
      .openPath(pathToOpen)
      .then((errorMessage) => {
        // returns Promise<String
        // resolves with a string containing the error message corresponding to
        // the failure if a failure occurred, otherwise ""
        // @see - https://www.electronjs.org/docs/latest/api/shell
        if (!_.isEmpty(errorMessage)) {
          console.error('encountered error at openPath when opening - %s, error - %s', pathToOpen, errorMessage);
        }
      });
  }

  openLink(linkToOpen: string): void {
    shell
      .openExternal(linkToOpen)
      .then((errorMessage) => {
        if (!_.isEmpty(errorMessage)) {
          console.error('encountered error at openExternal when opening - %s, error - %s', linkToOpen, errorMessage);
        }
      });
  }

  removeAppData() {
    const appDataPath = this.getDataPath();
    this.removeDirectorySafe(appDataPath);
  }

  removePersistedStates() {
    this.sendMessageToRenderer(IPCRendererCommChannel.StateRemovePersisted);
  }

  toggleWindowFill() {
    const { mainWindow } = this;
    if (!mainWindow) return;

    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }

  toggleFullScreen() {
    const { mainWindow } = this;
    if (!mainWindow) return;

    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  }

  toggleDevTools() {
    const { mainWindow } = this;
    if (!this.debug || !mainWindow) return;

    mainWindow.webContents.toggleDevTools();
  }

  reloadApp() {
    const window = this.getCurrentWindow();
    window.webContents.reload();
  }

  private get iconPath(): string {
    let icon = 'icon.png';

    if (this.platform === PlatformOS.Darwin) {
      icon = 'icon-squircle.png';
    } else if (this.platform === PlatformOS.Windows) {
      icon = 'icon.ico';
    }

    return this.getAssetPath('icons', icon);
  }

  private configureApp(): void {
    app.name = APP_DISPLAY_NAME;
    app.setName(APP_DISPLAY_NAME);
    process.title = APP_DISPLAY_NAME;
    app.setAppUserModelId('com.galdo.aurorapulse');

    app.setAboutPanelOptions({
      applicationName: this.displayName,
      applicationVersion: this.version,
      iconPath: this.iconPath,
    });

    // darwin only
    app.dock?.setIcon(this.iconPath);
  }

  private configureUserDataPath(): void {
    const appDataPath = app.getPath('appData');
    app.setPath('userData', path.join(appDataPath, this.dataPath));
  }

  private migrateLegacyUserDataPath(): void {
    const currentUserDataPath = app.getPath('userData');
    if (fs.existsSync(currentUserDataPath) && fs.readdirSync(currentUserDataPath).length > 0) {
      return;
    }

    const legacyUserDataPath = this.findLegacyUserDataPath(currentUserDataPath);
    if (!legacyUserDataPath) {
      return;
    }

    try {
      this.copyDirectoryRecursive(legacyUserDataPath, currentUserDataPath);
    } catch (error: any) {
      console.error('migrateLegacyUserDataPath - encountered error - %o', error);
    }
  }

  private findLegacyUserDataPath(currentUserDataPath: string): string | undefined {
    const appDataPath = app.getPath('appData');
    const debugSuffix = this.debug ? '-debug' : '';
    const legacyBaseNames = APP_LEGACY_DATA_DIR_NAMES.map(name => `${name}${debugSuffix}`);
    const candidates = [
      ...legacyBaseNames.map(name => path.join(appDataPath, name)),
      ...legacyBaseNames.map(name => path.join(appDataPath, 'Electron', name)),
    ];
    const uniqueCandidates = _.uniq(candidates);

    return uniqueCandidates.find((candidatePath) => {
      if (candidatePath === currentUserDataPath || !fs.existsSync(candidatePath)) {
        return false;
      }

      return fs.readdirSync(candidatePath).length > 0;
    });
  }

  private copyDirectoryRecursive(sourcePath: string, destinationPath: string): void {
    fs.mkdirSync(destinationPath, { recursive: true });
    const sourceEntries = fs.readdirSync(sourcePath, {
      withFileTypes: true,
    });

    sourceEntries.forEach((sourceEntry) => {
      const sourceEntryPath = path.join(sourcePath, sourceEntry.name);
      const destinationEntryPath = path.join(destinationPath, sourceEntry.name);

      if (sourceEntry.isDirectory()) {
        this.copyDirectoryRecursive(sourceEntryPath, destinationEntryPath);
      } else {
        fs.copyFileSync(sourceEntryPath, destinationEntryPath);
      }
    });
  }

  private removeDirectorySafe(directory: string) {
    try {
      fs.rmdirSync(directory, {
        recursive: true,
      });
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        console.error('removeDatastore - directory does not exists - %s', directory);
      } else {
        throw error;
      }
    }
  }

  private installSourceMapSupport(): void {
    if (!this.prod) {
      return;
    }

    sourceMapSupport.install();
  }

  private configureLogger() {
    if (!this.prod) {
      return;
    }

    this.createDataDir(this.logsDataDir);

    const mainLog = createElectronLogger('main', this.getLogsPath(this.logsMainFile));
    const rendererLog = createElectronLogger('renderer', this.getLogsPath(this.logsRendererFile));

    electronLog.hooks.push((message) => {
      // @ts-ignore
      if (message.variables.processType === 'renderer') {
        rendererLog[message.level](message.data);
        return false; // prevent default logger from handling it
      }

      return message;
    });

    electronLog.initialize();
    Object.assign(console, mainLog.functions);
  }

  private installDebugSupport(): void {
    if (!this.debug || process.env.ENABLE_ELECTRON_DEBUG !== 'true') {
      return;
    }

    electronDebug();
  }

  private getAutoUpdater() {
    const updaterModule = electronUpdater as any;
    const pickUpdater = (candidate: any) => (
      candidate
        && typeof candidate.checkForUpdates === 'function'
        && typeof candidate.downloadUpdate === 'function'
        && typeof candidate.quitAndInstall === 'function'
        ? candidate
        : undefined
    );

    return pickUpdater(updaterModule)
      || pickUpdater(updaterModule?.autoUpdater)
      || pickUpdater(updaterModule?.default)
      || pickUpdater(updaterModule?.default?.autoUpdater);
  }

  private async installExtensions(): Promise<void> {
    if (!this.debug || process.env.ENABLE_ELECTRON_EXTENSIONS !== 'true') {
      return;
    }

    const extensions = [REACT_DEVELOPER_TOOLS, REDUX_DEVTOOLS];
    debug('installing extensions - %o', extensions);

    await installExtension(extensions, {
      forceDownload: this.forceExtensionDownload,
      loadExtensionOptions: {
        // for reasons unknown (at least to me) extensions were not working, got them fixed after setting 'allowFileAccess' to 'true'
        // @see (issue) - https://github.com/electron/electron/issues/23662#issuecomment-783805586
        // @see (PR) - https://github.com/electron/electron/pull/25198
        allowFileAccess: true,
      },
    })
      .then(() => {
        debug('extensions were installed successfully');
      })
      .catch((error) => {
        console.error('encountered error while installing extensions - %s', error);
      });
  }

  private registerAutoUpdater() {
    if (!app.isPackaged || this.autoUpdaterRegistered) {
      return;
    }
    this.autoUpdaterRegistered = true;

    const autoUpdater = this.getAutoUpdater();
    if (!autoUpdater) {
      this.setUpdateState({
        status: 'error',
        message: 'AutoUpdater konnte nicht initialisiert werden.',
        canDownload: false,
        canInstall: false,
      });
      return;
    }

    autoUpdater.logger = electronLog;
    autoUpdater.autoDownload = this.updateSettings.downloadMode === 'auto';
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.fullChangelog = true;
    autoUpdater.allowPrerelease = this.updateSettings.betaChannelEnabled;

    autoUpdater.on('checking-for-update', () => {
      this.setUpdateState({
        status: 'checking',
        message: '',
      });
    });
    autoUpdater.on('update-not-available', () => {
      this.latestUpdateInfo = undefined;
      this.setUpdateState({
        status: 'not_available',
        availableVersion: undefined,
        releaseDate: undefined,
        releaseNotes: undefined,
        downloadProgressPercent: undefined,
        message: '',
        canDownload: false,
        canInstall: false,
      });
    });
    autoUpdater.on('error', (error: any) => {
      this.handleAutoUpdaterError(error).catch((nestedError) => {
        this.setUpdateState({
          status: 'error',
          message: String((nestedError as any)?.message || nestedError),
          canDownload: false,
          canInstall: false,
        });
      });
    });
    autoUpdater.on('update-available', (info: any) => {
      if (!this.isUpdateInfoCompatible(info)) {
        this.latestUpdateInfo = undefined;
        this.setUpdateState({
          status: 'error',
          message: `Kein kompatibles Update für ${process.platform}/${process.arch} gefunden.`,
          canDownload: false,
          canInstall: false,
        });
        return;
      }
      this.latestUpdateInfo = info;
      this.setUpdateState({
        status: 'available',
        availableVersion: String(info?.version || ''),
        releaseDate: String(info?.releaseDate || ''),
        releaseNotes: this.resolveReleaseNotesFromUpdateInfo(info),
        canDownload: this.updateSettings.downloadMode === 'manual',
        canInstall: false,
        message: '',
      });
    });
    autoUpdater.on('download-progress', (progress: any) => {
      const progressPercent = Number(progress?.percent || 0);
      this.setUpdateState({
        status: 'downloading',
        downloadProgressPercent: progressPercent,
        canDownload: false,
        canInstall: false,
      });
    });
    autoUpdater.on('update-downloaded', (info: any) => {
      this.latestUpdateInfo = info;
      this.setUpdateState({
        status: 'downloaded',
        availableVersion: String(info?.version || ''),
        releaseDate: String(info?.releaseDate || ''),
        releaseNotes: this.resolveReleaseNotesFromUpdateInfo(info),
        canDownload: false,
        canInstall: true,
      });
      if (this.updateSettings.autoInstallOnDownload) {
        setTimeout(() => {
          this.installDownloadedUpdate();
        }, 600);
      }
    });

    if (this.updateSettings.checkOnStartup) {
      this.checkForUpdates();
    }
  }

  private setUpdateState(nextState: Partial<AppUpdateState>) {
    this.updateState = {
      ...this.updateState,
      ...nextState,
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
    };
    this.sendMessageToRenderer(IPCRendererCommChannel.UIAppUpdateStateChanged, this.updateState);
  }

  private getUpdateSettingsPath() {
    return this.getDataPath(this.updateSettingsFileName);
  }

  private getWhatsNewPath() {
    return this.getDataPath(this.whatsNewFileName);
  }

  private getThemeSettingsPath() {
    return this.getDataPath(this.themeSettingsFileName);
  }

  private getWindowStatePath() {
    return this.getDataPath(this.windowStateFileName);
  }

  private loadWindowState(): AppWindowState | undefined {
    try {
      const filePath = this.getWindowStatePath();
      if (!fs.existsSync(filePath)) {
        return undefined;
      }
      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8')) as AppWindowState;
      const hasCustomizedField = Object.prototype.hasOwnProperty.call(payload || {}, 'hasCustomizedWindowState');
      let normalizedHasCustomizedWindowState = payload?.hasCustomizedWindowState === true;
      if (!hasCustomizedField) {
        normalizedHasCustomizedWindowState = payload?.hasLaunched === true
          && (payload?.isMaximized === true || payload?.isFullScreen !== true);
      }
      const bounds = payload?.bounds;
      const hasValidBounds = bounds
        && Number.isFinite(bounds.width) && bounds.width >= this.windowMinWidth
        && Number.isFinite(bounds.height) && bounds.height >= this.windowMinHeight
        && Number.isFinite(bounds.x) && Number.isFinite(bounds.y);
      const normalizedState: AppWindowState = {
        hasLaunched: payload?.hasLaunched === true,
        hasCustomizedWindowState: normalizedHasCustomizedWindowState,
        isMaximized: payload?.isMaximized === true,
        isFullScreen: payload?.isFullScreen === true,
        bounds: hasValidBounds
          ? {
            x: Math.round(bounds.x),
            y: Math.round(bounds.y),
            width: Math.round(bounds.width),
            height: Math.round(bounds.height),
          }
          : undefined,
      };
      if (!hasCustomizedField) {
        this.saveWindowState(normalizedState);
      }
      return normalizedState;
    } catch (_error) {
      return undefined;
    }
  }

  private saveWindowState(windowState: AppWindowState) {
    const safeState: AppWindowState = {
      hasLaunched: windowState.hasLaunched === true,
      hasCustomizedWindowState: windowState.hasCustomizedWindowState === true,
      isMaximized: windowState.isMaximized === true,
      isFullScreen: windowState.isFullScreen === true,
      bounds: windowState.bounds
        ? {
          x: Math.round(windowState.bounds.x),
          y: Math.round(windowState.bounds.y),
          width: Math.max(this.windowMinWidth, Math.round(windowState.bounds.width)),
          height: Math.max(this.windowMinHeight, Math.round(windowState.bounds.height)),
        }
        : undefined,
    };
    const windowStatePath = this.getWindowStatePath();
    fs.mkdirSync(path.dirname(windowStatePath), { recursive: true });
    fs.writeFileSync(windowStatePath, JSON.stringify(safeState), 'utf8');
  }

  private loadUpdateSettings() {
    try {
      const filePath = this.getUpdateSettingsPath();
      if (!fs.existsSync(filePath)) {
        return;
      }
      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const checkOnStartup = Boolean(payload?.checkOnStartup);
      const downloadMode = payload?.downloadMode === 'manual' ? 'manual' : 'auto';
      const autoInstallOnDownload = payload?.autoInstallOnDownload !== false;
      const betaChannelEnabled = Boolean(payload?.betaChannelEnabled);
      this.updateSettings = {
        checkOnStartup,
        downloadMode,
        autoInstallOnDownload,
        betaChannelEnabled,
      };
    } catch (_error) {
      this.updateSettings = {
        checkOnStartup: true,
        downloadMode: 'auto',
        autoInstallOnDownload: true,
        betaChannelEnabled: false,
      };
    }
  }

  private saveUpdateSettings(nextSettings: AppUpdateSettings) {
    const safeSettings: AppUpdateSettings = {
      checkOnStartup: Boolean(nextSettings?.checkOnStartup),
      downloadMode: nextSettings?.downloadMode === 'manual' ? 'manual' : 'auto',
      autoInstallOnDownload: Boolean(nextSettings?.autoInstallOnDownload),
      betaChannelEnabled: Boolean(nextSettings?.betaChannelEnabled),
    };
    this.updateSettings = safeSettings;
    const updateSettingsPath = this.getUpdateSettingsPath();
    fs.mkdirSync(path.dirname(updateSettingsPath), { recursive: true });
    fs.writeFileSync(updateSettingsPath, JSON.stringify(this.updateSettings), 'utf8');
    if (app.isPackaged && this.autoUpdaterRegistered) {
      try {
        const autoUpdater = this.getAutoUpdater();
        if (autoUpdater) {
          autoUpdater.autoDownload = this.updateSettings.downloadMode === 'auto';
          autoUpdater.allowPrerelease = this.updateSettings.betaChannelEnabled;
        }
      } catch (error) {
        debug('saveUpdateSettings - failed to apply updater runtime settings - %o', error);
      }
    }
    return this.updateSettings;
  }

  private loadThemeSettings() {
    try {
      const filePath = this.getThemeSettingsPath();
      if (!fs.existsSync(filePath)) {
        return;
      }
      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const mode = String(payload?.mode || '').trim();
      if (mode === 'light' || mode === 'dark' || mode === 'auto') {
        this.themeMode = mode;
      }
    } catch (_error) {
      this.themeMode = 'auto';
    }
  }

  private saveThemeSettings(nextMode: AppThemeMode): AppThemeMode {
    const safeMode: AppThemeMode = nextMode === 'light' || nextMode === 'dark' ? nextMode : 'auto';
    this.themeMode = safeMode;
    const themeSettingsPath = this.getThemeSettingsPath();
    fs.mkdirSync(path.dirname(themeSettingsPath), { recursive: true });
    fs.writeFileSync(themeSettingsPath, JSON.stringify({ mode: safeMode }), 'utf8');
    return safeMode;
  }

  private resolveSplashThemeVariant(): 'light' | 'dark' {
    if (this.themeMode === 'light' || this.themeMode === 'dark') {
      return this.themeMode;
    }
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  }

  private getMainWindowThemeColors(): {
    mode: 'light' | 'dark';
    backgroundColor: string;
    titleBarSymbolColor: string;
  } {
    const mode = this.resolveSplashThemeVariant();
    if (mode === 'light') {
      return {
        mode,
        backgroundColor: '#ffffff',
        titleBarSymbolColor: '#1a1f24',
      };
    }
    return {
      mode,
      backgroundColor: '#141414',
      titleBarSymbolColor: '#f3f5f7',
    };
  }

  private applyMainWindowTheme(mainWindow?: BrowserWindow): void {
    const targetWindow = mainWindow || this.mainWindow;
    if (!targetWindow || targetWindow.isDestroyed()) {
      return;
    }
    const themeColors = this.getMainWindowThemeColors();
    targetWindow.setBackgroundColor(themeColors.backgroundColor);
    if (this.platform !== PlatformOS.Darwin && typeof (targetWindow as any).setTitleBarOverlay === 'function') {
      (targetWindow as any).setTitleBarOverlay({
        color: themeColors.backgroundColor,
        symbolColor: themeColors.titleBarSymbolColor,
        height: 54,
      });
    }
  }

  private loadPendingWhatsNew() {
    try {
      const filePath = this.getWhatsNewPath();
      if (!fs.existsSync(filePath)) {
        return;
      }
      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!payload?.releaseNotes || !payload?.version) {
        return;
      }
      this.pendingWhatsNew = {
        version: String(payload.version),
        releaseDate: String(payload.releaseDate || ''),
        releaseNotes: String(payload.releaseNotes || ''),
      };
    } catch (_error) {
      this.pendingWhatsNew = undefined;
    }
  }

  private clearPendingWhatsNew() {
    this.pendingWhatsNew = undefined;
    const filePath = this.getWhatsNewPath();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  private resolveReleaseNotesFromUpdateInfo(info: any) {
    const releaseNotes = info?.releaseNotes;
    if (Array.isArray(releaseNotes)) {
      return releaseNotes
        .map(note => String(note?.note || ''))
        .join('\n\n');
    }
    return String(releaseNotes || '');
  }

  private isUpdateInfoCompatible(info: any) {
    const files = Array.isArray(info?.files) ? info.files : [];
    if (files.length === 0) {
      return true;
    }
    let osTokens = ['linux'];
    if (process.platform === PlatformOS.Darwin) {
      osTokens = ['mac', 'darwin'];
    } else if (process.platform === PlatformOS.Windows) {
      osTokens = ['win', 'windows'];
    }
    return files.some((fileEntry: any) => {
      const fileName = String(fileEntry?.url || fileEntry?.path || '').toLowerCase();
      if (!fileName) {
        return false;
      }
      const osMatches = osTokens.some(token => fileName.includes(token));
      if (!osMatches) {
        return false;
      }
      const hasExplicitArchToken = ['arm64', 'x64', 'ia32'].some(archToken => (
        fileName.includes(`-${archToken}-`)
        || fileName.includes(`_${archToken}_`)
        || fileName.includes(archToken)
      ));
      if (!hasExplicitArchToken) {
        return true;
      }
      const archMatches = fileName.includes(`-${process.arch}-`) || fileName.includes(`_${process.arch}_`) || fileName.includes(process.arch);
      return archMatches;
    });
  }

  private async checkForUpdates() {
    if (!app.isPackaged) {
      this.setUpdateState({
        status: 'not_available',
        message: 'Updateprüfung ist nur in Paket-Builds verfügbar.',
      });
      return undefined;
    }
    this.setUpdateState({
      status: 'checking',
      message: '',
      canDownload: false,
      canInstall: false,
    });
    const autoUpdater = this.getAutoUpdater();
    if (!autoUpdater) {
      this.setUpdateState({
        status: 'error',
        message: 'AutoUpdater konnte nicht initialisiert werden.',
        canDownload: false,
        canInstall: false,
      });
      return undefined;
    }
    let timeoutRef: ReturnType<typeof setTimeout> | undefined;
    try {
      const updateCheckPromise = autoUpdater.checkForUpdates();
      const updateCheckTimeoutPromise = new Promise<never>((_resolveTimeout, reject) => {
        timeoutRef = setTimeout(() => {
          reject(new Error('Die Update-Prüfung hat zu lange gedauert. Bitte später erneut versuchen.'));
        }, this.updateCheckTimeoutMs);
      });
      return await Promise.race([updateCheckPromise, updateCheckTimeoutPromise]);
    } catch (error) {
      if (this.updateState.status === 'checking') {
        this.setUpdateState({
          status: 'error',
          message: String((error as any)?.message || error),
          canDownload: false,
          canInstall: false,
        });
      }
      return undefined;
    } finally {
      if (timeoutRef) {
        clearTimeout(timeoutRef);
      }
    }
  }

  private async downloadAvailableUpdate() {
    if (!app.isPackaged) {
      return;
    }
    this.setUpdateState({
      status: 'downloading',
      canDownload: false,
      canInstall: false,
    });
    const autoUpdater = this.getAutoUpdater();
    if (!autoUpdater) {
      this.setUpdateState({
        status: 'error',
        message: 'AutoUpdater konnte nicht initialisiert werden.',
        canDownload: false,
        canInstall: false,
      });
      return;
    }
    await autoUpdater.downloadUpdate();
  }

  private persistWhatsNewFromLatestUpdateInfo() {
    if (!this.latestUpdateInfo) {
      return;
    }
    const payload: AppWhatsNewPayload = {
      version: String(this.latestUpdateInfo?.version || ''),
      releaseDate: String(this.latestUpdateInfo?.releaseDate || ''),
      releaseNotes: this.resolveReleaseNotesFromUpdateInfo(this.latestUpdateInfo),
    };
    fs.writeFileSync(this.getWhatsNewPath(), JSON.stringify(payload));
  }

  private async installDownloadedUpdate() {
    if (!app.isPackaged) {
      return;
    }
    this.persistWhatsNewFromLatestUpdateInfo();
    this.setUpdateState({
      status: 'installing',
      canInstall: false,
    });
    const autoUpdater = this.getAutoUpdater();
    if (!autoUpdater) {
      this.setUpdateState({
        status: 'error',
        message: 'AutoUpdater konnte nicht initialisiert werden.',
        canDownload: false,
        canInstall: false,
      });
      return;
    }
    autoUpdater.quitAndInstall(true, true);
  }

  private async handleAutoUpdaterError(error: any) {
    const rawMessage = String((error as any)?.message || error || '');
    if (this.platform !== PlatformOS.Darwin) {
      this.setUpdateState({
        status: 'error',
        message: rawMessage,
        canDownload: false,
        canInstall: false,
      });
      return;
    }

    const macAppBundlePath = this.getMacAppBundlePathFromError(rawMessage);
    const hasSignatureError = /code signature|did not pass validation|code-anforderungen|beschädigt|damaged/i.test(rawMessage);
    const quarantineAutoClearSuccess = macAppBundlePath
      ? await this.clearMacQuarantine(macAppBundlePath)
      : false;
    const hintMessage = hasSignatureError
      ? this.getMacQuarantineHintMessage(macAppBundlePath, quarantineAutoClearSuccess)
      : '';

    this.setUpdateState({
      status: 'error',
      message: hintMessage ? `${rawMessage}\n\n${hintMessage}` : rawMessage,
      canDownload: false,
      canInstall: false,
    });
  }

  private getMacAppBundlePathFromError(errorMessage: string): string | undefined {
    const fileUrlMatch = String(errorMessage || '').match(/file:\/\/([^\s]+?\.app)/i);
    if (!fileUrlMatch?.[1]) {
      return undefined;
    }
    try {
      return decodeURIComponent(fileUrlMatch[1]);
    } catch (_error) {
      return fileUrlMatch[1];
    }
  }

  private async clearMacQuarantine(appBundlePath: string): Promise<boolean> {
    if (this.platform !== PlatformOS.Darwin) {
      return false;
    }
    const normalizedPath = String(appBundlePath || '').trim();
    if (!normalizedPath || !fs.existsSync(normalizedPath)) {
      return false;
    }
    return new Promise((resolve) => {
      execFile('xattr', ['-dr', 'com.apple.quarantine', normalizedPath], (error) => {
        resolve(!error);
      });
    });
  }

  private getMacQuarantineHintMessage(appBundlePath?: string, autoClearSuccess?: boolean): string {
    const candidatePath = appBundlePath && appBundlePath.trim()
      ? appBundlePath
      : '/Applications/AuroraPulse.app';
    const escapedPath = candidatePath.replace(/"/g, '\\"');
    const command = `xattr -dr com.apple.quarantine "${escapedPath}"`;
    const releaseUrl = 'https://github.com/galdo/aurora/releases';
    const manualOpenHint = 'Bitte versuche zuerst im Finder: Rechtsklick auf AuroraPulse.app → Öffnen.';
    if (autoClearSuccess) {
      return `${manualOpenHint} Falls die Installation weiterhin blockiert ist, lade das aktuelle macOS-Image manuell herunter: ${releaseUrl}\nTerminal-Fallback: ${command}`;
    }
    return `${manualOpenHint} Falls die Installation weiterhin blockiert ist, lade das aktuelle macOS-Image manuell herunter: ${releaseUrl}\nTerminal-Fallback: ${command}`;
  }

  private async createWindow(): Promise<BrowserWindow> {
    await this.installExtensions();
    const isDarwin = this.platform === PlatformOS.Darwin;
    const primaryDisplayWorkArea = screen.getPrimaryDisplay().workAreaSize;
    const defaultWidth = Math.max(
      this.windowMinWidth,
      Math.round(primaryDisplayWorkArea.width * this.windowDefaultSizeRatio),
    );
    const defaultHeight = Math.max(
      this.windowMinHeight,
      Math.round(primaryDisplayWorkArea.height * this.windowDefaultSizeRatio),
    );

    const splashWindow = this.createSplashWindow();
    this.splashWindow = splashWindow;
    splashWindow.once('ready-to-show', () => {
      splashWindow.show();
    });
    splashWindow.loadURL(this.getSplashDataURL());

    const themeColors = this.getMainWindowThemeColors();
    const savedWindowState = this.loadWindowState();
    const savedBounds = savedWindowState?.bounds;
    const mainWindow = new BrowserWindow({
      show: false,
      width: savedBounds?.width || defaultWidth,
      height: savedBounds?.height || defaultHeight,
      x: savedBounds?.x,
      y: savedBounds?.y,
      minWidth: this.windowMinWidth,
      minHeight: this.windowMinHeight,
      icon: this.iconPath,
      title: APP_DISPLAY_NAME,
      titleBarStyle: isDarwin ? 'hiddenInset' : 'hidden',
      ...(!isDarwin ? {
        titleBarOverlay: {
          color: themeColors.backgroundColor,
          symbolColor: themeColors.titleBarSymbolColor,
          height: 54,
        },
      } : {}),
      frame: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        nodeIntegrationInWorker: true,
      },
      backgroundColor: themeColors.backgroundColor,
    });
    this.mainWindow = mainWindow;
    this.applyMainWindowTheme(mainWindow);

    if (this.debug) {
      mainWindow.webContents.on('console-message', (_event, _level, message) => {
        const text = typeof message === 'string' ? message : String(message ?? '');
        if (text.includes('[dap-adb]')) {
          console.log(text);
        }
      });
    }

    this.registerRendererEvents();
    this.startDiagnosticsControlServer();
    let persistWindowStateTimeout: NodeJS.Timeout | undefined;
    let hasCustomizedWindowState = savedWindowState?.hasCustomizedWindowState === true;
    const persistWindowState = () => {
      if (mainWindow.isDestroyed()) {
        return;
      }
      const isFullScreen = mainWindow.isFullScreen();
      const isMaximized = mainWindow.isMaximized();
      if (!hasCustomizedWindowState && (isMaximized || !isFullScreen)) {
        hasCustomizedWindowState = true;
      }
      const bounds = (isFullScreen || isMaximized) ? mainWindow.getNormalBounds() : mainWindow.getBounds();
      this.saveWindowState({
        hasLaunched: true,
        hasCustomizedWindowState,
        bounds: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
        isMaximized,
        isFullScreen,
      });
    };
    const queuePersistWindowState = () => {
      if (persistWindowStateTimeout) {
        clearTimeout(persistWindowStateTimeout);
      }
      persistWindowStateTimeout = setTimeout(() => {
        persistWindowState();
      }, 220);
    };

    let mainWindowShown = false;
    const showMainWindow = () => {
      if (mainWindowShown || mainWindow.isDestroyed()) {
        return;
      }
      mainWindowShown = true;
      this.closeSplashWindow();
      if (this.startMinimized) {
        mainWindow.minimize();
      } else {
        const shouldStartInFullScreen = savedWindowState?.hasLaunched !== true
          || savedWindowState?.hasCustomizedWindowState !== true
          || savedWindowState?.isFullScreen === true;
        if (shouldStartInFullScreen && !mainWindow.isFullScreen()) {
          mainWindow.setFullScreen(true);
        } else if (savedWindowState?.isMaximized === true) {
          mainWindow.maximize();
        }
        mainWindow.show();
        mainWindow.focus();
      }
    };

    mainWindow
      .loadFile(this.htmlFilePath)
      .then(() => {
        debug('main window loaded HTML - %s', this.htmlFilePath);
      })
      .catch((error) => {
        console.error('mainWindow.loadFile encountered error - %o', error);
        return mainWindow.loadURL(this.getStartupErrorDataURL(this.htmlFilePath));
      });

    mainWindow.once('ready-to-show', showMainWindow);
    mainWindow.webContents.once('did-finish-load', showMainWindow);
    const showFallbackTimeout = setTimeout(showMainWindow, 3500);

    mainWindow.on('closed', () => {
      if (persistWindowStateTimeout) {
        clearTimeout(persistWindowStateTimeout);
      }
      clearTimeout(showFallbackTimeout);
      this.closeSplashWindow();
      this.mainWindow = undefined;
    });
    if (!this.nativeThemeListenerRegistered) {
      this.nativeThemeListenerRegistered = true;
      nativeTheme.on('updated', () => {
        if (this.themeMode === 'auto') {
          this.applyMainWindowTheme();
        }
      });
    }

    mainWindow.on('close', (event) => {
      persistWindowState();
      // let the app quit if requested by user
      // else simply hide the window, we let the app run in background
      if (this.isQuitting) {
        this.mainWindow = undefined;
      } else if (this.platform === PlatformOS.Darwin) {
        // on macOS - we keep the renderer process alive but still closing the window
        event.preventDefault();
        mainWindow.hide();
      }
    });
    mainWindow.on('resize', queuePersistWindowState);
    mainWindow.on('move', queuePersistWindowState);
    mainWindow.on('maximize', queuePersistWindowState);
    mainWindow.on('unmaximize', queuePersistWindowState);
    mainWindow.on('enter-full-screen', queuePersistWindowState);
    mainWindow.on('leave-full-screen', queuePersistWindowState);

    // when a new browser window is requested
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      // if navigating externally, let os handle it
      if (!this.isUrlLocal(url)) {
        debug('openExternal using setWindowOpenHandler - %s', url);
        shell.openExternal(url);

        return { action: 'deny' };
      }

      // if it's internal → let the app handle it
      return { action: 'allow' };
    });

    // when navigating away
    mainWindow.webContents.on('will-navigate', (e, url) => {
      if (!this.isUrlLocal(url)) {
        debug('openExternal using will-navigate - %s', url);

        e.preventDefault();
        shell.openExternal(url);
      }
    });

    // run builders
    this.runBuilders(mainWindow);

    // register handler for auto-updates
    this.registerAutoUpdater();

    return mainWindow;
  }

  private closeSplashWindow() {
    if (!this.splashWindow || this.splashWindow.isDestroyed()) {
      return;
    }
    this.splashWindow.close();
    this.splashWindow = undefined;
  }

  private createSplashWindow(): BrowserWindow {
    const splashTheme = this.resolveSplashThemeVariant();
    return new BrowserWindow({
      width: 420,
      height: 240,
      show: false,
      frame: false,
      alwaysOnTop: true,
      center: true,
      transparent: false,
      resizable: false,
      movable: false,
      fullscreenable: false,
      skipTaskbar: true,
      backgroundColor: splashTheme === 'dark' ? '#0d1014' : '#f2f6f8',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
  }

  private getSplashDataURL(): string {
    const splashTheme = this.resolveSplashThemeVariant();
    const isDark = splashTheme === 'dark';
    const splashLogoPath = this.getAssetPath('icons', 'icon-squircle-no-background.png');
    const splashLogoBase64 = fs.existsSync(splashLogoPath)
      ? fs.readFileSync(splashLogoPath).toString('base64')
      : '';
    const splashLogoUrl = splashLogoBase64 ? `data:image/png;base64,${splashLogoBase64}` : '';
    const wrapBackground = isDark
      ? 'radial-gradient(circle at top, #22303c 0%, #141b22 55%, #0d1014 100%)'
      : 'radial-gradient(circle at top, #ffffff 0%, #edf3f6 58%, #e6eef2 100%)';
    const auroraColor = isDark ? '#f7fbff' : '#0f1720';
    const pulseColor = isDark ? '#10b85a' : '#0a9a49';
    const logoOpacity = isDark ? '0.14' : '0.12';
    const titleShadow = isDark ? '0 8px 26px rgba(0, 0, 0, 0.42)' : '0 8px 22px rgba(22, 45, 66, 0.14)';
    const borderColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(32,58,78,0.14)';
    const lineColor = isDark
      ? 'linear-gradient(90deg, rgba(20, 184, 116, 0), rgba(20, 184, 116, 0.9), rgba(20, 184, 116, 0))'
      : 'linear-gradient(90deg, rgba(16, 185, 129, 0), rgba(10, 154, 73, 0.85), rgba(16, 185, 129, 0))';
    const splashHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Meow+Script&display=swap" rel="stylesheet">
  <style>
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      background: ${isDark ? '#0d1014' : '#f2f6f8'};
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .wrap {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: ${wrapBackground};
      color: ${auroraColor};
      border: 1px solid ${borderColor};
      box-sizing: border-box;
    }
    .inner {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      letter-spacing: 0.03em;
      text-shadow: ${titleShadow};
    }
    .logo-bg {
      position: absolute;
      top: -56px;
      width: 170px;
      height: 170px;
      background-image: url("${splashLogoUrl}");
      background-size: contain;
      background-repeat: no-repeat;
      background-position: center;
      opacity: ${logoOpacity};
      pointer-events: none;
    }
    .title {
      position: relative;
      display: flex;
      align-items: baseline;
      justify-content: center;
      gap: 8px;
      line-height: 1;
      white-space: nowrap;
    }
    .title-aurora {
      font-size: 44px;
      font-weight: 700;
      color: ${auroraColor};
      letter-spacing: -0.035em;
    }
    .title-pulse {
      font-size: 62px;
      font-family: "Meow Script", cursive;
      color: ${pulseColor};
      transform: translateY(2px);
    }
    .pulse {
      width: 104px;
      height: 3px;
      border-radius: 8px;
      background: ${lineColor};
      opacity: 0.9;
      animation: pulse 1.65s ease-in-out infinite;
    }
    @keyframes pulse {
      0% { transform: scaleX(0.72); opacity: 0.45; }
      50% { opacity: 1; }
      100% { transform: scaleX(1.06); opacity: 0.45; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="inner">
      <div class="logo-bg"></div>
      <div class="title">
        <span class="title-aurora">Aurora</span>
        <span class="title-pulse">Pulse</span>
      </div>
      <div class="pulse"></div>
    </div>
  </div>
</body>
</html>`;
    return `data:text/html;charset=UTF-8,${encodeURIComponent(splashHtml)}`;
  }

  private getStartupErrorDataURL(failedPath: string): string {
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      background: #141414;
      color: #f3f5f7;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .wrap {
      min-height: 100%;
      display: grid;
      place-items: center;
      padding: 24px;
      box-sizing: border-box;
    }
    .card {
      width: min(760px, calc(100vw - 48px));
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.04);
      padding: 20px;
      box-sizing: border-box;
    }
    h1 {
      margin: 0 0 12px 0;
      font-size: 22px;
      color: #ffffff;
    }
    p {
      margin: 0;
      line-height: 1.5;
      color: #d8dde2;
    }
    code {
      display: block;
      margin-top: 12px;
      padding: 10px;
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.35);
      overflow-wrap: anywhere;
      color: #e7eef7;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${APP_DISPLAY_NAME} konnte die Oberfläche nicht laden</h1>
      <p>Der Build enthält keinen gültigen Einstiegspunkt. Bitte Release erneut herunterladen oder neu installieren.</p>
      <code>${_.escape(failedPath)}</code>
    </div>
  </div>
</body>
</html>`;
    return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
  }

  private registerEvents(): void {
    process.once('SIGINT', () => {
      this.isQuitting = true;
      app.quit();
    });

    process.once('SIGTERM', () => {
      this.isQuitting = true;
      app.quit();
    });

    app.on('window-all-closed', () => {
      // respect the OSX convention of having the application in memory even
      // after all windows have been closed
      if (this.platform !== PlatformOS.Darwin) {
        app.quit();
      }
    });

    app.on('before-quit', () => {
      // this apparently called right before when user requests to quit (not close) the app
      this.isQuitting = true;
      this.sendMessageToRenderer(IPCRendererCommChannel.UIAppBeforeQuit);
      globalShortcut.unregisterAll();
      this.diagnosticsControlServer?.close();
      this.diagnosticsControlServer = undefined;
    });

    app.whenReady()
      .then(async () => {
        app.setName(APP_DISPLAY_NAME);
        app.dock?.setIcon(this.iconPath);
        this.mainWindow = await this.createWindow();
        this.registerMediaHardwareShortcuts();
      })
      .catch(debug);

    app.on('activate', async () => {
      // on macOS, it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open
      if (!this.mainWindow) {
        this.mainWindow = await this.createWindow();
      } else {
        this.mainWindow.show();
      }
      this.registerMediaHardwareShortcuts();
    });

    app.on('browser-window-focus', () => {
      this.registerMediaHardwareShortcuts();
    });
  }

  private registerBuilders(): void {
    debug('registering builders...');

    this.builders.push(new MenuBuilder(this));

    debug('builder registration completed!');
  }

  private registerModules(): void {
    debug('registering modules...');

    this.modules.push(new DatastoreModule(this));
    this.modules.push(new FileSystemModule(this));
    this.modules.push(new ImageModule(this));
    this.modules.push(new DeviceModule(this));

    debug('module registration completed!');
  }

  private runBuilders(mainWindow: BrowserWindow): void {
    this.builders.forEach((builder) => {
      builder.build(mainWindow);
    });
  }

  private registerRendererEvents(): void {
    if (this.rendererEventsRegistered) {
      return;
    }
    this.rendererEventsRegistered = true;

    IPCMain.addSyncMessageHandler(IPCCommChannel.AppToggleWindowFill, () => {
      this.toggleWindowFill();
    });

    IPCMain.addSyncMessageHandler(IPCCommChannel.AppResetSettings, () => {
      this.removeAppData();
      this.reloadApp();
    });

    IPCMain.addSyncMessageHandler(IPCCommChannel.AppReadDetails, () => this.getDetails());
    IPCMain.addSyncMessageHandler(IPCCommChannel.AppReadUpdateSettings, () => this.updateSettings);
    IPCMain.addSyncMessageHandler(IPCCommChannel.AppReadUpdateState, () => this.updateState);
    IPCMain.addSyncMessageHandler(IPCCommChannel.AppReadWhatsNew, () => this.pendingWhatsNew || null);
    IPCMain.addSyncMessageHandler(IPCCommChannel.AppDismissWhatsNew, () => {
      this.clearPendingWhatsNew();
    });
    IPCMain.addAsyncMessageHandler(IPCCommChannel.AppSaveUpdateSettings, async (nextSettings: AppUpdateSettings) => {
      const safeSettings: AppUpdateSettings = {
        checkOnStartup: Boolean(nextSettings?.checkOnStartup),
        downloadMode: nextSettings?.downloadMode === 'manual' ? 'manual' : 'auto',
        autoInstallOnDownload: Boolean(nextSettings?.autoInstallOnDownload),
        betaChannelEnabled: Boolean(nextSettings?.betaChannelEnabled),
      };
      return Promise.resolve(this.saveUpdateSettings(safeSettings));
    });
    IPCMain.addAsyncMessageHandler(IPCCommChannel.AppCheckForUpdates, () => this.checkForUpdates());
    IPCMain.addAsyncMessageHandler(IPCCommChannel.AppDownloadUpdate, () => this.downloadAvailableUpdate());
    IPCMain.addAsyncMessageHandler(IPCCommChannel.AppInstallUpdate, () => this.installDownloadedUpdate());
    IPCMain.addAsyncMessageHandler(IPCCommChannel.AppSetThemeMode, (mode: AppThemeMode) => {
      const savedMode = this.saveThemeSettings(mode);
      this.applyMainWindowTheme();
      return Promise.resolve(savedMode);
    });
  }

  private startDiagnosticsControlServer(): void {
    if (this.diagnosticsControlServer) {
      return;
    }
    this.diagnosticsControlToken = randomBytes(18).toString('hex');
    this.diagnosticsControlServer = http.createServer((request, response) => {
      this.handleDiagnosticsControlRequest(request, response).catch(() => undefined);
    });
    this.diagnosticsControlServer.listen(0, '127.0.0.1', () => {
      const address = this.diagnosticsControlServer?.address();
      if (!address || typeof address === 'string') {
        return;
      }
      this.diagnosticsControlPort = address.port;
      const payload = {
        host: '127.0.0.1',
        port: this.diagnosticsControlPort,
        token: this.diagnosticsControlToken,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        this.getLogsPath('diag-control.json'),
        JSON.stringify(payload, null, 2),
        { encoding: 'utf8' },
      );
    });
  }

  private async handleDiagnosticsControlRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    const method = String(request.method || 'GET').toUpperCase();
    if (requestUrl.pathname === '/diag/health' && method === 'GET') {
      this.writeJsonResponse(response, 200, {
        ok: true,
        port: this.diagnosticsControlPort,
      });
      return;
    }
    const providedToken = String(request.headers['x-aurora-token'] || '');
    if (!providedToken || providedToken !== this.diagnosticsControlToken) {
      this.writeJsonResponse(response, 401, {
        ok: false,
        message: 'unauthorized',
      });
      return;
    }
    if (requestUrl.pathname === '/diag/state' && method === 'GET') {
      const state = await this.executeDiagnosticsScript('window.auroraDiagBridge?.state?.()');
      this.writeJsonResponse(response, 200, {
        ok: true,
        state: state || null,
      });
      return;
    }
    if (requestUrl.pathname === '/diag/events' && method === 'GET') {
      const sinceSeq = Number(requestUrl.searchParams.get('sinceSeq') || 0);
      const limit = Number(requestUrl.searchParams.get('limit') || 500);
      const events = await this.executeDiagnosticsScript(`window.auroraDiagBridge?.events?.(${Number.isFinite(sinceSeq) ? sinceSeq : 0}, ${Number.isFinite(limit) ? limit : 500})`);
      this.writeJsonResponse(response, 200, {
        ok: true,
        latestSeq: Number(events?.latestSeq || 0),
        events: Array.isArray(events?.events) ? events.events : [],
      });
      return;
    }
    if (requestUrl.pathname === '/diag/events/clear' && method === 'POST') {
      const clearResult = await this.executeDiagnosticsScript('window.auroraDiagBridge?.clearEvents?.()');
      this.writeJsonResponse(response, 200, {
        ok: !!clearResult?.ok,
      });
      return;
    }
    if (requestUrl.pathname === '/diag/logs' && method === 'GET') {
      const name = String(requestUrl.searchParams.get('name') || 'dlna').toLowerCase();
      const lines = Number(requestUrl.searchParams.get('lines') || 200);
      const maxLines = Number.isFinite(lines) ? Math.max(1, Math.min(5000, Math.floor(lines))) : 200;
      const logs = this.readDiagnosticsLogTail(name, maxLines);
      this.writeJsonResponse(response, 200, {
        ok: true,
        name,
        lineCount: logs.length,
        lines: logs,
      });
      return;
    }
    if (requestUrl.pathname === '/diag/action' && method === 'POST') {
      const bodyText = await this.readDiagnosticsRequestBody(request);
      let payload: any;
      try {
        payload = bodyText ? JSON.parse(bodyText) : {};
      } catch (_error) {
        this.writeJsonResponse(response, 400, {
          ok: false,
          message: 'invalid_json',
        });
        return;
      }
      const action = String(payload?.action || '').toLowerCase();
      const supportedActions = new Set(['play', 'pause', 'stop', 'next', 'previous', 'play_pause', 'remote_on', 'remote_off']);
      if (!supportedActions.has(action)) {
        this.writeJsonResponse(response, 400, {
          ok: false,
          message: 'invalid_action',
          action,
        });
        return;
      }
      const result = await this.executeDiagnosticsScript(`window.auroraDiagBridge?.run?.(${JSON.stringify(action)})`);
      this.writeJsonResponse(response, 200, {
        ok: true,
        action,
        result: result ?? null,
      });
      return;
    }
    this.writeJsonResponse(response, 404, {
      ok: false,
      message: 'not_found',
    });
  }

  private readDiagnosticsRequestBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let body = '';
      request.on('data', (chunk) => {
        body += Buffer.from(chunk).toString('utf8');
      });
      request.on('end', () => {
        resolve(body);
      });
      request.on('error', () => resolve(''));
    });
  }

  private writeJsonResponse(response: ServerResponse, statusCode: number, payload: any): void {
    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(payload));
  }

  private async executeDiagnosticsScript(script: string): Promise<any> {
    const window = this.mainWindow;
    if (!window || window.isDestroyed()) {
      return undefined;
    }
    return window.webContents.executeJavaScript(script, true);
  }

  private readDiagnosticsLogTail(name: string, maxLines: number): string[] {
    const normalizedName = String(name || '').toLowerCase();
    let logPath = this.getLogsPath('dlna.log');
    if (normalizedName === 'renderer') {
      logPath = this.getLogsPath(this.logsRendererFile);
    } else if (normalizedName === 'main') {
      logPath = this.getLogsPath(this.logsMainFile);
    } else if (normalizedName.endsWith('.log')) {
      logPath = this.getLogsPath(normalizedName);
    }
    if (!fs.existsSync(logPath)) {
      return [];
    }
    const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - maxLines)).filter(Boolean);
  }

  private registerMediaHardwareShortcuts() {
    if (this.mediaHardwareShortcutsRegistered || this.mediaHardwareShortcutRegistrationDisabled) {
      return;
    }
    const now = Date.now();
    if (now - this.mediaHardwareShortcutLastAttemptAt < 3000) {
      return;
    }
    this.mediaHardwareShortcutLastAttemptAt = now;

    if (this.platform === PlatformOS.Darwin) {
      const trustedAccessibility = systemPreferences.isTrustedAccessibilityClient(false);
      if (!trustedAccessibility) {
        if (!this.mediaHardwareShortcutWarningShown) {
          this.mediaHardwareShortcutWarningShown = true;
          console.warn('registerMediaHardwareShortcuts - accessibility permission is missing on macOS; skipping global media keys');
        }
        return;
      }
    }

    const shortcuts: { accelerators: string[]; action: MediaHardwareControlAction; required: boolean }[] = [{
      accelerators: ['MediaPlayPause'],
      action: 'play_pause',
      required: true,
    }, {
      accelerators: ['MediaNextTrack'],
      action: 'next_track',
      required: true,
    }, {
      accelerators: ['MediaPreviousTrack'],
      action: 'previous_track',
      required: true,
    }, {
      accelerators: ['MediaStop'],
      action: 'stop',
      required: true,
    }];

    let failedRegistrationCount = 0;
    shortcuts.forEach(({ accelerators, action, required }) => {
      let isRegisteredForAction = false;
      accelerators.forEach((accelerator) => {
        if (isRegisteredForAction) {
          return;
        }
        try {
          globalShortcut.unregister(accelerator);
          const isRegistered = globalShortcut.register(accelerator, () => {
            this.sendMessageToRenderer(IPCRendererCommChannel.MediaHardwareControl, action);
          });
          if (isRegistered) {
            isRegisteredForAction = true;
          }
        } catch (error) {
          debug('global shortcut register failed - %s - %o', accelerator, error);
        }
      });

      if (required && !isRegisteredForAction) {
        failedRegistrationCount += 1;
      }
    });

    if (failedRegistrationCount === 0) {
      this.mediaHardwareShortcutWarningShown = false;
      this.mediaHardwareShortcutsRegistered = true;
      return;
    }
    if (!this.mediaHardwareShortcutWarningShown) {
      this.mediaHardwareShortcutWarningShown = true;
      console.warn('registerMediaHardwareShortcuts - global registration unavailable (likely claimed by macOS/other app); using MediaSession handlers only');
    }
  }

  private isUrlLocal(url: string): boolean {
    try {
      const { protocol } = new URL(url);

      return this.localProtocols.has(protocol);
    } catch (err: any) {
      console.error('isNavigatingLocally encountered error - %s', err.message);
      return false;
    }
  }

  private getDetails() {
    const accessibilityTrusted = this.platform === PlatformOS.Darwin
      ? systemPreferences.isTrustedAccessibilityClient(false)
      : true;
    return {
      display_name: this.displayName,
      version: this.version,
      build: this.build,
      platform: this.platform,
      arch: process.arch,
      logs_path: this.getLogsPath(this.logsRendererFile),
      media_hardware_shortcuts_registered: this.mediaHardwareShortcutsRegistered,
      media_hardware_shortcuts_accessibility_trusted: accessibilityTrusted,
    };
  }
}

export default new App();
