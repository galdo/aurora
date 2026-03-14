import fs from 'fs';
import path from 'path';
import { ChildProcess, spawn, spawnSync } from 'child_process';

type BitPerfectBackend = 'none' | 'mpv';

export type BitPerfectState = {
  enabled: boolean;
  active: boolean;
  backend: BitPerfectBackend;
  binaryPath?: string;
  processId?: number;
  currentFilePath?: string;
  lastError?: string;
  suggestedBufferMs: number;
};

const debug = require('debug')('aurora:service:bit_perfect');

export class BitPerfectService {
  private static readonly storageKey = 'aurora:bit-perfect-settings';
  private static readonly eventName = 'aurora:bit-perfect-state-changed';
  private static readonly suggestedBufferMs = 200;
  private static enabled = false;
  private static backend: BitPerfectBackend = 'none';
  private static binaryPath?: string;
  private static currentProcess?: ChildProcess;
  private static currentFilePath?: string;
  private static lastError?: string;
  private static initialized = false;

  static initialize() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.loadSettings();
    this.backend = this.resolveBackend();
    this.emitState();
  }

  static subscribe(listener: (state: BitPerfectState) => void): () => void {
    const eventListener = () => listener(this.getState());
    window.addEventListener(this.eventName, eventListener);
    return () => {
      window.removeEventListener(this.eventName, eventListener);
    };
  }

  static getState(): BitPerfectState {
    return {
      enabled: this.enabled,
      active: !!this.currentProcess,
      backend: this.backend,
      binaryPath: this.binaryPath,
      processId: this.currentProcess?.pid,
      currentFilePath: this.currentFilePath,
      lastError: this.lastError,
      suggestedBufferMs: this.suggestedBufferMs,
    };
  }

  static async setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.persistSettings();
    if (!enabled) {
      this.stopPlayback();
      this.lastError = undefined;
    } else {
      this.backend = this.resolveBackend();
      if (this.backend === 'none') {
        this.lastError = 'Kein kompatibles Bit-Perfect Backend gefunden. Installiere mpv.';
      } else {
        this.lastError = undefined;
      }
    }
    this.emitState();
  }

  static isEnabled() {
    return this.enabled;
  }

  static playTrack(filePath: string, startSeconds = 0) {
    if (!this.enabled) {
      return;
    }
    if (!filePath || !fs.existsSync(filePath)) {
      this.lastError = 'Bit-Perfect Quelle nicht gefunden.';
      this.emitState();
      return;
    }

    this.backend = this.resolveBackend();
    if (this.backend === 'none') {
      this.lastError = 'Kein kompatibles Bit-Perfect Backend gefunden. Installiere mpv.';
      this.emitState();
      return;
    }

    this.stopPlayback();
    this.currentFilePath = filePath;
    this.lastError = undefined;

    try {
      const args = [
        '--no-terminal',
        '--really-quiet',
        '--no-video',
        '--force-window=no',
        '--audio-display=no',
        '--osc=no',
        '--idle=no',
        '--audio-exclusive=yes',
        '--cache=no',
        `--audio-buffer=${(this.suggestedBufferMs / 1000).toFixed(2)}`,
      ];
      if (startSeconds > 0) {
        args.push(`--start=${Math.max(0, startSeconds)}`);
      }
      args.push(filePath);

      const executablePath = this.binaryPath || 'mpv';
      const childProcess = spawn(executablePath, args, {
        stdio: 'ignore',
      });
      this.currentProcess = childProcess;
      childProcess.once('error', (error) => {
        this.lastError = String(error?.message || error);
        this.currentProcess = undefined;
        this.emitState();
      });
      childProcess.once('close', () => {
        this.currentProcess = undefined;
        this.emitState();
      });
    } catch (error: any) {
      this.lastError = String(error?.message || error);
      debug('playTrack failed - %o', error);
    }
    this.emitState();
  }

  static seekTrack(filePath: string, startSeconds: number) {
    if (!this.enabled) {
      return;
    }
    this.playTrack(filePath, startSeconds);
  }

  static stopPlayback() {
    if (!this.currentProcess) {
      return;
    }
    try {
      this.currentProcess.kill();
    } catch (error) {
      debug('stopPlayback kill failed - %o', error);
    }
    this.currentProcess = undefined;
    this.emitState();
  }

  private static emitState() {
    window.dispatchEvent(new Event(this.eventName));
  }

  private static loadSettings() {
    try {
      const rawSettings = localStorage.getItem(this.storageKey);
      if (!rawSettings) {
        return;
      }
      const parsedSettings = JSON.parse(rawSettings);
      this.enabled = Boolean(parsedSettings?.enabled);
    } catch (_error) {
      this.enabled = false;
    }
  }

  private static persistSettings() {
    localStorage.setItem(this.storageKey, JSON.stringify({
      enabled: this.enabled,
    }));
  }

  private static resolveBackend(): BitPerfectBackend {
    const bundledPath = this.resolveBundledMpvPath();
    if (bundledPath) {
      this.binaryPath = bundledPath;
      return 'mpv';
    }

    const whichCommand = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(whichCommand, ['mpv'], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (result.status === 0) {
      const firstLine = String(result.stdout || '')
        .split(/\r?\n/)
        .map(item => item.trim())
        .find(Boolean);
      this.binaryPath = firstLine || 'mpv';
      return 'mpv';
    }
    this.binaryPath = undefined;
    return 'none';
  }

  private static resolveBundledMpvPath(): string | undefined {
    const { platform, arch, resourcesPath } = process;
    const executableName = platform === 'win32' ? 'mpv.exe' : 'mpv';
    const baseCandidates = [
      path.resolve(resourcesPath || '', 'assets/bin/mpv'),
      path.resolve(process.cwd(), 'assets/bin/mpv'),
    ];

    const relativeCandidates = [
      `${platform}-${arch}/${executableName}`,
      `${platform}/${arch}/${executableName}`,
      `${platform}/${executableName}`,
      executableName,
      `${platform}-${arch}/mpv.app/Contents/MacOS/mpv`,
      `${platform}/mpv.app/Contents/MacOS/mpv`,
    ];

    const candidatePath = baseCandidates
      .flatMap(basePath => relativeCandidates.map(relativePath => path.resolve(basePath, relativePath)))
      .find(fs.existsSync);

    if (!candidatePath) {
      return undefined;
    }

    try {
      if (platform !== 'win32') {
        fs.chmodSync(candidatePath, 0o755);
      }
    } catch (error) {
      debug('resolveBundledMpvPath chmod failed - %o', error);
    }

    return candidatePath;
  }
}
