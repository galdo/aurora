/* eslint-disable no-restricted-syntax, no-continue, no-await-in-loop, no-useless-escape,
   @typescript-eslint/no-use-before-define, no-void, no-nested-ternary -- adb shell/streaming */
import { execFile, spawn } from 'child_process';
import { createInterface } from 'readline';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { format, promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Per `adb shell` invocation — avoids indefinite hangs on slow/broken transports. */
const ADB_SHELL_DEFAULT_TIMEOUT_MS = 30_000;
const ADB_SHELL_WRITABLE_PROBE_TIMEOUT_MS = 25_000;
const ADB_SHELL_STAT_TIMEOUT_MS = 90_000;
const ADB_SHELL_MKDIR_TIMEOUT_MS = 120_000;

const debug = require('debug')('aurora:service:dap_adb');

/** `debug()` only hits the Chromium console; mirror to stderr when DEBUG includes this namespace (see main process `console-message` forward). */
function dapLog(message: string, ...args: unknown[]) {
  debug(message, ...args);
  if (process.env.NODE_ENV !== 'development') {
    return;
  }
  if (!String(process.env.DEBUG || '').includes('dap_adb')) {
    return;
  }
  // eslint-disable-next-line no-console
  console.warn('[dap-adb]', args.length ? format(message, ...args) : message);
}

/** Mirrors host DAP sync state entry shape (see media-library.service). */
export interface AdbDapSyncStateEntry {
  sourceSize: number;
  sourceMtimeMs: number;
  sourceHash?: string;
  destinationSize?: number;
  destinationMtimeMs?: number;
  destinationHash?: string;
}

export function shellSingleQuote(arg: string): string {
  return `'${String(arg).replace(/'/g, '\'\\\'\'')}'`;
}

/** Combine user cancel with a wall-clock timeout (adb devices often hangs if the server/USB is wedged). */
function combineUserAbortWithTimeout(userSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSig = typeof AbortSignal !== 'undefined' && typeof (AbortSignal as any).timeout === 'function'
    ? (AbortSignal as any).timeout(timeoutMs)
    : (() => {
      const c = new AbortController();
      setTimeout(() => c.abort(), timeoutMs);
      return c.signal;
    })();
  if (!userSignal) {
    return timeoutSig;
  }
  if (typeof (AbortSignal as any).any === 'function') {
    return (AbortSignal as any).any([userSignal, timeoutSig]);
  }
  return userSignal;
}

async function execAdb(
  adbPath: string,
  args: string[],
  options?: { signal?: AbortSignal; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(adbPath, args, {
    encoding: 'utf8',
    maxBuffer: options?.maxBuffer ?? 50 * 1024 * 1024,
    ...(options?.signal ? { signal: options.signal } : {}),
  } as Parameters<typeof execFileAsync>[2]);
  return {
    stdout: String((result as { stdout?: string }).stdout || ''),
    stderr: String((result as { stderr?: string }).stderr || ''),
  };
}

function parseAdbDevicesList(output: string): string[] {
  const serials: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('List of devices')) {
      continue;
    }
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length >= 2 && parts[1] === 'device') {
      serials.push(parts[0]);
    }
  }
  return serials;
}

/**
 * Tokens usable with `adb -s`. Some hosts/OEMs list a single `?` in column 1 while the row is still `device`
 * (see `adb devices -l` for model/usb); we must accept that id — it is what adb expects for `-s`.
 */
export function isPlausibleAdbDeviceSerial(serial: string): boolean {
  const s = String(serial || '').trim();
  if (s.length < 1) {
    return false;
  }
  if (s === '*') {
    return false;
  }
  if (s === '?') {
    return true;
  }
  if (s.length < 2) {
    return false;
  }
  return /^[a-zA-Z0-9._\-:]+$/.test(s);
}

export async function resolveAdbExecutable(signal?: AbortSignal): Promise<string> {
  const candidates: string[] = [];
  const push = (c?: string) => {
    if (c && !c.includes('undefined')) {
      candidates.push(c);
    }
  };
  push(process.env.ADB_PATH);
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (androidHome) {
    push(path.join(androidHome, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'));
  }
  if (process.platform === 'darwin') {
    push(path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'));
  }
  push('adb');

  const tried = new Set<string>();
  for (const candidate of candidates) {
    if (tried.has(candidate)) {
      continue;
    }
    tried.add(candidate);
    try {
      await execAdb(candidate, ['version'], { signal, maxBuffer: 256 * 1024 });
      dapLog('Using adb at %s', candidate);
      return candidate;
    } catch (_e) {
      /* try next */
    }
  }
  throw new Error('ADB_NOT_FOUND');
}

export async function getAuthorizedAdbDeviceSerial(adbPath: string, signal?: AbortSignal): Promise<string> {
  const devicesListTimeoutMs = 45_000;
  dapLog('Running: adb devices (timeout %d ms)…', devicesListTimeoutMs);
  const execSig = combineUserAbortWithTimeout(signal, devicesListTimeoutMs);
  let stdout: string;
  try {
    ({ stdout } = await execAdb(adbPath, ['devices'], { signal: execSig, maxBuffer: 1024 * 1024 }));
  } catch (e) {
    if (signal?.aborted) {
      throw e;
    }
    const name = String((e as Error)?.name || '');
    const msg = String((e as Error)?.message || e);
    if (name === 'AbortError' || /aborted/i.test(msg)) {
      throw new Error('ADB_DEVICES_TIMED_OUT');
    }
    throw e;
  }
  dapLog('adb devices finished, parsing…');
  if (/\bunauthorized\b/i.test(stdout)) {
    throw new Error('ADB_UNAUTHORIZED');
  }
  const serialsRaw = parseAdbDevicesList(stdout);
  const serials = serialsRaw.filter(isPlausibleAdbDeviceSerial);
  if (serials.length < serialsRaw.length) {
    dapLog(
      'Dropped implausible adb id(s) from list: %o',
      serialsRaw.filter(s => !isPlausibleAdbDeviceSerial(s)),
    );
  }

  // Exactly one device in "device" state: use that id from `adb devices` only (DAP addresses one device).
  if (serials.length === 1) {
    const chosen = serials[0];
    if (chosen === '?') {
      dapLog(
        'Single ADB device id is "?" (seen on some USB stacks); using adb -s ? — check "adb devices -l" for model.',
      );
    } else {
      dapLog('Single ADB device; using id from adb devices: %s', chosen);
    }
    return chosen;
  }

  if (serials.length === 0) {
    if (serialsRaw.length > 0) {
      dapLog('adb devices (truncated):\n%s', stdout.slice(0, 1500));
      throw new Error('ADB_INVALID_DEVICE_SERIAL');
    }
    throw new Error('ADB_NO_DEVICE');
  }

  // Multiple devices: disambiguate with ANDROID_SERIAL only.
  let envSerial = String(process.env.ANDROID_SERIAL || '').trim();
  if (envSerial && !isPlausibleAdbDeviceSerial(envSerial)) {
    dapLog('Ignoring ANDROID_SERIAL (not a valid adb -s id): %j', envSerial);
    envSerial = '';
  }
  if (envSerial && serials.includes(envSerial)) {
    dapLog('Multiple ADB devices; using ANDROID_SERIAL: %s', envSerial);
    return envSerial;
  }
  throw new Error('ADB_MULTIPLE_DEVICES');
}

type AdbShellShOptions = {
  signal?: AbortSignal;
  /** Wall-clock cap for this shell invocation (combined with user abort via AbortSignal.any). */
  timeoutMs?: number;
};

/**
 * Run one `adb shell` **string** as the device shell would parse it. Paths must use {@link shellSingleQuote}
 * so `( ) & | !` etc. are literal. (argv-style `adb shell mkdir -p -- /a (b)` is still merged by adb/sh and
 * breaks on parentheses — that was causing `syntax error: unexpected '('`.)
 */
async function adbShellLine(
  adbPath: string,
  serial: string,
  line: string,
  options?: AdbShellShOptions,
): Promise<string> {
  const signal = options?.signal;
  const timeoutMs = options?.timeoutMs ?? 0;
  const execSig = timeoutMs > 0
    ? combineUserAbortWithTimeout(signal, timeoutMs)
    : signal;
  const { stdout } = await execAdb(adbPath, ['-s', serial, 'shell', line], {
    signal: execSig,
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout || '';
}

/**
 * Run `adb shell <argv...>` for **path-free** commands (`printenv`, `cat`, `ls`, …).
 */
async function adbShellArgv(
  adbPath: string,
  serial: string,
  shellArgs: string[],
  options?: AdbShellShOptions,
): Promise<string> {
  const signal = options?.signal;
  const timeoutMs = options?.timeoutMs ?? 0;
  const execSig = timeoutMs > 0
    ? combineUserAbortWithTimeout(signal, timeoutMs)
    : signal;
  const { stdout } = await execAdb(adbPath, ['-s', serial, 'shell', ...shellArgs], {
    signal: execSig,
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout || '';
}

/** Read one env var on the device without `sh -c` (avoids adb splitting + broken `printf "$VAR"`). */
async function adbShellPrintEnv(
  adbPath: string,
  serial: string,
  varName: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(varName)) {
    return '';
  }
  try {
    const out = await adbShellArgv(adbPath, serial, ['printenv', varName], {
      signal,
      timeoutMs: ADB_SHELL_DEFAULT_TIMEOUT_MS,
    });
    return out.trim();
  } catch (_e) {
    return '';
  }
}

function sortSdCandidatesFirst(paths: string[]): string[] {
  const score = (p: string) => {
    const base = path.posix.basename(p.replace(/\/$/, ''));
    if (/^[0-9A-F]{4}-[0-9A-F]{4}$/i.test(base)) {
      return 0;
    }
    if (/^[0-9A-F-]{9,}$/i.test(base)) {
      return 1;
    }
    if (base === 'sdcard1' || base === 'extSdCard' || base === 'external_sd' || /^microsd|card\d*$/i.test(base)) {
      return 2;
    }
    if (p.startsWith('/mnt/media_rw/')) {
      return 3;
    }
    if (base === 'sdcard') {
      return 40;
    }
    return 15;
  };
  return [...paths].sort((a, b) => score(a) - score(b) || a.localeCompare(b));
}

/** Names under `/storage` that are never removable media (OEMs may expose odd layouts, e.g. DAPs). */
const STORAGE_LS_NAME_BLOCKLIST = new Set([
  'acct', 'apex', 'bin', 'bugreports', 'cache', 'config', 'data', 'data_mirror', 'debug_ramdisk', 'dev', 'etc',
  'init', 'linkerconfig', 'metadata', 'mnt', 'odm', 'odm_dlkm', 'oem', 'postinstall', 'proc', 'product',
  'second_stage_resources', 'sys', 'system', 'system_dlkm', 'system_ext', 'vendor', 'vendor_dlkm',
  'storage', 'self', 'obb', 'emulated',
  'init.environ.rc',
]);

/**
 * Include any sane directory name under `/storage` except known system fakes.
 * A strict UUID-only allowlist hid real SD mounts (OEM-specific names, `sdcard`, etc.).
 */
function isAllowedStorageVolumeDirName(name: string): boolean {
  const n = String(name || '').trim();
  if (n.length < 2 || n.length > 80) {
    return false;
  }
  if (STORAGE_LS_NAME_BLOCKLIST.has(n.toLowerCase())) {
    return false;
  }
  if (/\.(rc|te)$/i.test(n)) {
    return false;
  }
  if (!/^[a-zA-Z0-9._\-]+$/.test(n)) {
    return false;
  }
  return true;
}

/**
 * Normalize a single storage path from the device. Rejects full `printenv` dumps and other garbage
 * (some transports return an entire environment when `printenv` is parsed wrong).
 */
function coalesceAndroidStoragePath(raw: string): string {
  const t = String(raw || '').trim();
  if (!t) {
    return '';
  }
  if (t.includes('\n') || t.includes('\r')) {
    return '';
  }
  if (t.length > 512) {
    return '';
  }
  if (!t.startsWith('/')) {
    return '';
  }
  if (/[=]/.test(t) && (t.includes('PATH=') || t.includes('BOOTCLASSPATH') || t.includes('DEX2OAT'))) {
    return '';
  }
  return t.replace(/\/+$/, '');
}

/** `SECONDARY_STORAGE` is often colon-separated paths. */
function parseSecondaryStoragePaths(raw: string): string[] {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return [];
  }
  const chunks = trimmed.includes(':') ? trimmed.split(':') : [trimmed];
  const out: string[] = [];
  for (const chunk of chunks) {
    const c = coalesceAndroidStoragePath(chunk.trim());
    if (!c) {
      continue;
    }
    if (c.startsWith('/mnt/media_rw/') && !c.includes('/emulated')) {
      out.push(c);
      continue;
    }
    if (c.startsWith('/storage/') && !c.includes('/emulated')) {
      out.push(c);
    }
  }
  return out;
}

function parseStoragePathsFromSmListVolumes(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const pathMatch = line.match(/(\/storage\/[0-9A-F]{4}-[0-9A-F]{4}[^\s)]*)/i);
    if (pathMatch && !pathMatch[1].includes('/emulated')) {
      out.push(pathMatch[1].replace(/\/$/, ''));
      continue;
    }
    const uuidOnly = line.match(/\b([0-9A-F]{4}-[0-9A-F]{4})\b/i);
    if (uuidOnly && /\bpublic\b/i.test(line) && !line.includes('/emulated')) {
      out.push(`/storage/${uuidOnly[1]}`);
    }
  }
  return out;
}

function parseStoragePathsFromProcMounts(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const mountPoint = parts[1];
    if (!mountPoint) {
      continue;
    }
    const clean = mountPoint.replace(/\/$/, '');
    if (clean.includes('/emulated') || clean.includes('/self')) {
      continue;
    }
    if (clean.startsWith('/storage/')) {
      const base = path.posix.basename(clean);
      if (STORAGE_LS_NAME_BLOCKLIST.has(base.toLowerCase())) {
        continue;
      }
      out.push(clean);
      continue;
    }
    if (clean.startsWith('/mnt/media_rw/')) {
      const rest = clean.replace(/^\/mnt\/media_rw\//, '').split('/')[0];
      if (rest && (/^[0-9A-F]{4}-[0-9A-F]{4}$/i.test(rest) || /^[0-9A-F][0-9A-F-]{6,}$/i.test(rest))) {
        out.push(clean);
      }
    }
  }
  return out;
}

export async function resolveDapStorageBasePath(
  adbPath: string,
  serial: string,
  signal?: AbortSignal,
): Promise<string> {
  dapLog('Resolving writable storage base on device (SD-first)…');
  async function isWritableBase(base: string): Promise<boolean> {
    const stamp = `.aurora_dap_probe_${Date.now()}`;
    const t = `${base.replace(/\/$/, '')}/${stamp}`;
    try {
      await adbShellLine(adbPath, serial, `touch ${shellSingleQuote(t)}`, {
        signal,
        timeoutMs: ADB_SHELL_WRITABLE_PROBE_TIMEOUT_MS,
      });
      await adbShellLine(adbPath, serial, `rm -f ${shellSingleQuote(t)}`, {
        signal,
        timeoutMs: ADB_SHELL_WRITABLE_PROBE_TIMEOUT_MS,
      });
      return true;
    } catch (err) {
      dapLog('writable probe failed for %s: %s', base, String((err as Error)?.message || err));
      return false;
    }
  }

  const seen = new Set<string>();
  const orderedSdCandidates: string[] = [];

  const pushUnique = (p: string) => {
    const n = p.replace(/\/$/, '');
    if (!n || seen.has(n)) {
      return;
    }
    seen.add(n);
    orderedSdCandidates.push(n);
  };

  let smOut = '';
  try {
    smOut = await adbShellArgv(adbPath, serial, ['sm', 'list-volumes'], {
      signal,
      timeoutMs: ADB_SHELL_DEFAULT_TIMEOUT_MS,
    });
  } catch (_e) {
    smOut = '';
  }
  dapLog('sm list-volumes probe done (%d chars)', smOut.length);
  for (const p of parseStoragePathsFromSmListVolumes(smOut)) {
    pushUnique(p);
  }

  const secondaryRaw = await adbShellPrintEnv(adbPath, serial, 'SECONDARY_STORAGE', signal);
  const secondaryPaths = parseSecondaryStoragePaths(secondaryRaw);
  dapLog('SECONDARY_STORAGE (printenv argv) done, len=%d, paths=%o', secondaryRaw.length, secondaryPaths);
  for (const secondary of secondaryPaths) {
    pushUnique(secondary);
  }

  let mountsOut = '';
  try {
    mountsOut = await adbShellArgv(adbPath, serial, ['cat', '/proc/mounts'], {
      signal,
      timeoutMs: ADB_SHELL_DEFAULT_TIMEOUT_MS,
    });
  } catch (_e) {
    mountsOut = '';
  }
  dapLog('/proc/mounts probe done (%d chars)', mountsOut.length);
  for (const p of parseStoragePathsFromProcMounts(mountsOut)) {
    pushUnique(p);
  }

  let ls = '';
  try {
    ls = await adbShellArgv(adbPath, serial, ['ls', '-1', '/storage'], {
      signal,
      timeoutMs: ADB_SHELL_DEFAULT_TIMEOUT_MS,
    });
  } catch (_e) {
    ls = '';
  }
  dapLog('ls /storage probe done (%d chars)', ls.length);
  const names = ls.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const RESERVED_UNDER_STORAGE = new Set(['emulated', 'self', 'obb']);
  const fromLs: string[] = [];
  for (const name of names) {
    if (RESERVED_UNDER_STORAGE.has(name)) {
      continue;
    }
    if (!isAllowedStorageVolumeDirName(name)) {
      continue;
    }
    fromLs.push(`/storage/${name}`);
  }
  if (fromLs.length > 0) {
    dapLog('Storage volume dir candidates from ls: %o', fromLs);
  }
  for (const p of sortSdCandidatesFirst(fromLs)) {
    pushUnique(p);
  }

  let mediaRwLs = '';
  try {
    mediaRwLs = await adbShellArgv(adbPath, serial, ['ls', '-1', '/mnt/media_rw'], {
      signal,
      timeoutMs: ADB_SHELL_DEFAULT_TIMEOUT_MS,
    });
  } catch (_e) {
    mediaRwLs = '';
  }
  dapLog('ls /mnt/media_rw probe done (%d chars)', mediaRwLs.length);
  for (const name of mediaRwLs.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    if (!/^[0-9A-F]{4}-[0-9A-F]{4}$/i.test(name) && !/^[0-9A-F][0-9A-F-]{6,}$/i.test(name)) {
      continue;
    }
    pushUnique(`/mnt/media_rw/${name}`);
  }

  const tryOrder = sortSdCandidatesFirst(orderedSdCandidates);

  dapLog('DAP ADB storage candidates (SD-first): %o', tryOrder);

  for (const base of tryOrder) {
    dapLog('Checking writable: %s', base);
    if (await isWritableBase(base)) {
      dapLog('Using removable / external storage base: %s', base);
      return base.replace(/\/$/, '');
    }
  }

  const extRaw = await adbShellPrintEnv(adbPath, serial, 'EXTERNAL_STORAGE', signal);
  const ext = coalesceAndroidStoragePath(extRaw);
  dapLog('EXTERNAL_STORAGE (printenv argv) done, rawLen=%d, path=%j', extRaw.length, ext);
  const fallback = ext || '/storage/emulated/0';
  dapLog('Falling back to primary shared storage: %s', fallback);
  return fallback.replace(/\/$/, '') || '/storage/emulated/0';
}

export function joinDevicePosixPath(root: string, relativeUnix: string): string {
  const r = relativeUnix.split(/[/\\]/).filter(Boolean).join('/');
  const base = String(root || '').replace(/\/+$/, '');
  return `${base}/${r}`;
}

export async function remoteFileStat(
  adbPath: string,
  serial: string,
  remotePath: string,
  signal?: AbortSignal,
): Promise<{ size: number; mtimeMs: number } | null> {
  let out: string;
  try {
    const line = `stat -c ${shellSingleQuote('%s %Y')} ${shellSingleQuote(remotePath)}`;
    out = await adbShellLine(adbPath, serial, line, { signal, timeoutMs: ADB_SHELL_STAT_TIMEOUT_MS });
  } catch (_e) {
    return null;
  }
  const line = out.trim().split(/\r?\n/).filter(Boolean)[0];
  if (!line) {
    return null;
  }
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) {
    return null;
  }
  const size = Number(parts[0]);
  const mtimeSec = Number(parts[1]);
  if (!Number.isFinite(size) || size < 0) {
    return null;
  }
  return {
    size,
    mtimeMs: (Number.isFinite(mtimeSec) ? mtimeSec : 0) * 1000,
  };
}

export async function remoteMkdirP(
  adbPath: string,
  serial: string,
  remoteDir: string,
  signal?: AbortSignal,
): Promise<void> {
  const line = `mkdir -p ${shellSingleQuote(remoteDir)}`;
  await adbShellLine(adbPath, serial, line, {
    signal,
    timeoutMs: ADB_SHELL_MKDIR_TIMEOUT_MS,
  });
}

function resolveLocalPathForAdb(localPath: string): string {
  const resolved = path.resolve(localPath);
  if (process.platform === 'win32') {
    return path.normalize(resolved);
  }
  return resolved;
}

/**
 * Push one file to the device. Spaces in folder/file names are preserved: host path is resolved on disk,
 * remote path is passed as a single argv token (no shell splitting).
 */
export async function adbPushLocalFile(
  adbPath: string,
  serial: string,
  localPath: string,
  remotePath: string,
  signal?: AbortSignal,
): Promise<void> {
  const localAbs = resolveLocalPathForAdb(localPath);
  await fs.promises.access(localAbs, fs.constants.R_OK).catch(() => {
    throw new Error(`ADB push: cannot read local file: ${localAbs}`);
  });
  const remoteArg = String(remotePath || '').trim().replace(/\/{2,}/g, '/');
  await execAdb(adbPath, ['-s', serial, 'push', localAbs, remoteArg], {
    signal,
    maxBuffer: 10 * 1024 * 1024,
  });
}

export async function adbPullToLocalFile(
  adbPath: string,
  serial: string,
  remotePath: string,
  localPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const localAbs = resolveLocalPathForAdb(localPath);
  const remoteArg = String(remotePath || '').trim().replace(/\/{2,}/g, '/');
  await execAdb(adbPath, ['-s', serial, 'pull', remoteArg, localAbs], {
    signal,
    maxBuffer: 10 * 1024 * 1024,
  });
}

export async function remoteUnlink(
  adbPath: string,
  serial: string,
  remotePath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const line = `rm -f ${shellSingleQuote(remotePath)}`;
    await adbShellLine(adbPath, serial, line, {
      signal,
      timeoutMs: ADB_SHELL_DEFAULT_TIMEOUT_MS,
    });
    return true;
  } catch (_e) {
    return false;
  }
}

export async function remoteListFilesRecursive(
  adbPath: string,
  serial: string,
  rootDir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const acc: string[] = [];
  await forEachRemoteFileLine(adbPath, serial, rootDir, async (p) => {
    acc.push(p);
  }, signal);
  return acc;
}

/**
 * Stream `find <root> -type f` line-by-line (no giant stdout string — avoids renderer OOM on large libraries).
 */
export function forEachRemoteFileLine(
  adbPath: string,
  serial: string,
  rootDir: string,
  onLine: (remotePath: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const script = `find ${shellSingleQuote(rootDir)} -type f 2>/dev/null`;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('DAP_SYNC_ABORTED'));
      return;
    }
    const child = spawn(adbPath, ['-s', serial, 'shell', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onAbort = () => {
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    let chain: Promise<void> = Promise.resolve();
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (l) => {
      const t = l.trim().replace(/\r/g, '');
      if (!t) {
        return;
      }
      chain = chain.then(() => Promise.resolve(onLine(t))).catch((e) => {
        child.kill('SIGTERM');
        reject(e);
      });
    });
    rl.on('close', () => {
      void chain
        .then(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        })
        .catch(reject);
    });
    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.stderr?.on('data', () => {
      /* ignore */
    });
  });
}

/** Basis for “copy or skip” when comparing local file vs remote (see console `compareBasis` / `compareDetail`). */
export type AdbDestinationCompareBasis =
  | 'remote_missing'
  | 'size_mismatch'
  | 'uptodate_zero_bytes'
  | 'uptodate_cached_hashes'
  | 'hash_mismatch'
  | 'uptodate_hash_match';

export async function checkAdbDestinationCurrent(input: {
  adbPath: string;
  serial: string;
  sourcePath: string;
  remotePath: string;
  sourceMeta?: { sourceSize?: number; sourceMtimeMs?: number; syncStateEntry?: AdbDapSyncStateEntry; signal?: AbortSignal };
  hashLocalFile: (filePath: string, signal?: AbortSignal) => Promise<string | undefined>;
  hashRemoteFile: (remote: string, signal?: AbortSignal) => Promise<string | undefined>;
}): Promise<{
    isCurrent: boolean;
    syncStateEntry?: AdbDapSyncStateEntry;
    compareBasis?: AdbDestinationCompareBasis;
    compareDetail?: string;
  }> {
  const { signal } = input.sourceMeta || {};
  if (signal?.aborted) {
    throw new Error('DAP_SYNC_ABORTED');
  }
  const destStats = await remoteFileStat(input.adbPath, input.serial, input.remotePath, signal);
  if (!destStats) {
    return {
      isCurrent: false,
      compareBasis: 'remote_missing',
      compareDetail: 'remote stat failed or file does not exist',
    };
  }

  const sourceStats = (!input.sourceMeta?.sourceSize || !input.sourceMeta?.sourceMtimeMs)
    ? await fs.promises.stat(input.sourcePath).catch(() => undefined)
    : undefined;
  const sourceSize = Number(input.sourceMeta?.sourceSize || sourceStats?.size || 0);
  const sourceMtimeMs = Number(input.sourceMeta?.sourceMtimeMs || sourceStats?.mtimeMs || 0);
  if (!Number.isFinite(sourceSize) || sourceSize < 0 || destStats.size !== sourceSize) {
    return {
      isCurrent: false,
      compareBasis: 'size_mismatch',
      compareDetail: `local_bytes=${sourceSize} remote_bytes=${destStats.size}`,
    };
  }

  if (sourceSize === 0) {
    return {
      isCurrent: true,
      compareBasis: 'uptodate_zero_bytes',
      compareDetail: 'both sizes 0',
      syncStateEntry: {
        sourceSize,
        sourceMtimeMs,
        destinationSize: destStats.size,
        destinationMtimeMs: destStats.mtimeMs,
      },
    };
  }

  const cachedEntry = input.sourceMeta?.syncStateEntry;
  if (cachedEntry
    && cachedEntry.sourceSize === sourceSize
    && cachedEntry.sourceMtimeMs === sourceMtimeMs
    && cachedEntry.destinationSize === destStats.size
    && Number(cachedEntry.destinationMtimeMs || 0) === Number(destStats.mtimeMs || 0)
    && !!cachedEntry.sourceHash
    && cachedEntry.sourceHash === cachedEntry.destinationHash) {
    return {
      isCurrent: true,
      compareBasis: 'uptodate_cached_hashes',
      compareDetail: `sha1=${cachedEntry.sourceHash.slice(0, 8)}… (sync state)`,
      syncStateEntry: cachedEntry,
    };
  }

  const sourceHash = (cachedEntry
    && cachedEntry.sourceSize === sourceSize
    && cachedEntry.sourceMtimeMs === sourceMtimeMs
    && cachedEntry.sourceHash)
    ? cachedEntry.sourceHash
    : await input.hashLocalFile(input.sourcePath, signal);
  const destinationHash = (cachedEntry
    && cachedEntry.destinationSize === destStats.size
    && Number(cachedEntry.destinationMtimeMs || 0) === Number(destStats.mtimeMs || 0)
    && cachedEntry.destinationHash)
    ? cachedEntry.destinationHash
    : await input.hashRemoteFile(input.remotePath, signal);

  const match = !!sourceHash && !!destinationHash && sourceHash === destinationHash;
  const basis: AdbDestinationCompareBasis = match ? 'uptodate_hash_match' : 'hash_mismatch';
  const detail = sourceHash && destinationHash
    ? (match
      ? `sha1=${sourceHash.slice(0, 8)}…`
      : `sha1_local=${sourceHash.slice(0, 8)}… sha1_remote=${destinationHash.slice(0, 8)}…`)
    : `local_hash=${sourceHash ? `${sourceHash.slice(0, 8)}…` : 'missing'} remote_hash=${destinationHash ? `${destinationHash.slice(0, 8)}…` : 'missing'}`;

  return {
    isCurrent: match,
    compareBasis: basis,
    compareDetail: detail,
    syncStateEntry: {
      sourceSize,
      sourceMtimeMs,
      sourceHash,
      destinationSize: destStats.size,
      destinationMtimeMs: destStats.mtimeMs,
      destinationHash,
    },
  };
}

export async function hashRemoteFileViaPull(
  adbPath: string,
  serial: string,
  remotePath: string,
  hashFn: (filePath: string, signal?: AbortSignal) => Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const tmp = path.join(os.tmpdir(), `aurora-adb-hash-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await adbPullToLocalFile(adbPath, serial, remotePath, tmp, signal);
    const h = await hashFn(tmp, signal);
    return h;
  } catch (_e) {
    return undefined;
  } finally {
    await fs.promises.unlink(tmp).catch(() => undefined);
  }
}

export async function walkLocalFilesRecursive(directoryPath: string): Promise<string[]> {
  const directoryEntries = await fs.promises.readdir(directoryPath, { withFileTypes: true }).catch(() => []);
  const filePaths = await Promise.all(directoryEntries.map(async (directoryEntry) => {
    const fullPath = path.join(directoryPath, directoryEntry.name);
    if (directoryEntry.isDirectory()) {
      return walkLocalFilesRecursive(fullPath);
    }
    return [fullPath];
  }));
  return filePaths.flat();
}

export async function isAdbDeviceReachable(
  adbPath: string,
  serial: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const { stdout } = await execAdb(adbPath, ['-s', serial, 'get-state'], { signal, maxBuffer: 4096 });
    return String(stdout).trim() === 'device';
  } catch (_e) {
    return false;
  }
}
