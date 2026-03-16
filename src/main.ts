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
import electronUpdater from 'electron-updater';
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
  private mediaHardwareShortcutRegistrationDisabled = false;
  private mediaHardwareShortcutWarningShown = false;
  private mediaHardwareShortcutLastAttemptAt = 0;
  private mediaHardwareShortcutsRegistered = false;
  private readonly updateSettingsFileName = 'update.settings.json';
  private readonly whatsNewFileName = 'update.whats-new.json';
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
  private latestUpdateInfo?: any;

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
    app.setAppUserModelId('com.bbbneo333.aurorapulse');

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

    const { autoUpdater } = electronUpdater;

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
    autoUpdater.on('error', (error) => {
      this.setUpdateState({
        status: 'error',
        message: String((error as any)?.message || error),
      });
    });
    autoUpdater.on('update-available', (info) => {
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
    autoUpdater.on('download-progress', (progress) => {
      const progressPercent = Number(progress?.percent || 0);
      this.setUpdateState({
        status: 'downloading',
        downloadProgressPercent: progressPercent,
        canDownload: false,
        canInstall: false,
      });
    });
    autoUpdater.on('update-downloaded', (info) => {
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
        electronUpdater.autoUpdater.autoDownload = this.updateSettings.downloadMode === 'auto';
        electronUpdater.autoUpdater.allowPrerelease = this.updateSettings.betaChannelEnabled;
      } catch (error) {
        debug('saveUpdateSettings - failed to apply updater runtime settings - %o', error);
      }
    }
    return this.updateSettings;
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
    return electronUpdater.autoUpdater.checkForUpdates();
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
    await electronUpdater.autoUpdater.downloadUpdate();
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
    electronUpdater.autoUpdater.quitAndInstall(true, true);
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

    const mainWindow = new BrowserWindow({
      show: false,
      width: defaultWidth,
      height: defaultHeight,
      minWidth: this.windowMinWidth,
      minHeight: this.windowMinHeight,
      icon: this.iconPath,
      title: APP_DISPLAY_NAME,
      titleBarStyle: isDarwin ? 'hiddenInset' : 'hidden',
      ...(!isDarwin ? {
        titleBarOverlay: {
          color: '#141414',
          symbolColor: '#f3f5f7',
          height: 54,
        },
      } : {}),
      frame: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        nodeIntegrationInWorker: true,
      },
      backgroundColor: '#141414',
    });
    this.mainWindow = mainWindow;

    this.registerRendererEvents();

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
      clearTimeout(showFallbackTimeout);
      this.closeSplashWindow();
      this.mainWindow = undefined;
    });

    mainWindow.on('close', (event) => {
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
    return new BrowserWindow({
      width: 420,
      height: 240,
      show: false,
      frame: false,
      alwaysOnTop: true,
      center: true,
      transparent: true,
      resizable: false,
      movable: false,
      fullscreenable: false,
      skipTaskbar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
  }

  private getSplashDataURL(): string {
    const splashHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      background: transparent;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .wrap {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: radial-gradient(circle at top, #282828 0%, #151515 56%, #0e0e0e 100%);
      color: #f5f5f5;
      border-radius: 16px;
    }
    .inner {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      letter-spacing: 0.03em;
    }
    .title {
      font-size: 30px;
      font-weight: 700;
      color: #fff;
    }
    .pulse {
      width: 56px;
      height: 4px;
      border-radius: 8px;
      background: linear-gradient(90deg, #7f5af0, #2cb67d, #7f5af0);
      background-size: 200% 100%;
      animation: pulse 1.5s linear infinite;
    }
    @keyframes pulse {
      0% { background-position: 0% 50%; opacity: 0.5; }
      50% { opacity: 1; }
      100% { background-position: 100% 50%; opacity: 0.5; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="inner">
      <div class="title">${APP_DISPLAY_NAME}</div>
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
    }, {
      accelerators: ['VolumeUp', 'MediaVolumeUp'],
      action: 'volume_up',
      required: false,
    }, {
      accelerators: ['VolumeDown', 'MediaVolumeDown'],
      action: 'volume_down',
      required: false,
    }, {
      accelerators: ['VolumeMute', 'MediaVolumeMute'],
      action: 'volume_mute',
      required: false,
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
