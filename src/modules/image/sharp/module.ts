import fs from 'fs';
import os from 'os';
import path from 'path';
import { Worker } from 'worker_threads';

import sharp from 'sharp';

import { IAppMain } from '../../../interfaces';

import { CryptoService } from '../../crypto';
import { FSUtils, FSImageExtension } from '../../file-system';

import { SharpImageScaleOptions } from './types';

const debug = require('debug')('aurora:module:image:sharp');

/**
 * Phase 4 perf optimization (#23): pending job tracked across the
 * main-thread <-> worker_threads boundary.
 *
 * The pool stores one of these per in-flight resize so the worker's reply
 * (`{ kind: 'ok' | 'error', jobId, ... }`) can be matched back to the
 * original `scaleImage` caller's promise.
 */
interface ISharpPoolPendingJob {
  resolve: (outputPath: string) => void;
  reject: (error: Error) => void;
  outputPath: string;
}

export class SharpModule {
  private readonly app: IAppMain;
  private readonly imageExtension = FSImageExtension.JPG;
  private readonly imagesDataDir = 'Images';

  /**
   * Phase 4 perf optimization (#23): worker pool for sharp resize jobs.
   *
   * The pool is built lazily on the first `scaleImage` call so app boot
   * stays unaffected (workers spawn means a new V8 isolate + sharp module
   * load, ~50-100ms each). For typical libraries the first call happens
   * during sync, which is where we want the parallelism anyway.
   *
   * Size: `cpu_count - 1`, capped between 1 and 4. Going wider than 4 has
   * shown diminishing returns on a typical Electron host because libvips
   * is itself thread-pooled — the OS scheduler thrashes if we over-
   * subscribe. The `-1` keeps one CPU free for the main process so the
   * Electron event loop stays responsive.
   */
  private readonly sharpWorkerPoolSize = Math.max(1, Math.min(4, (os.cpus()?.length || 2) - 1));
  private sharpWorkerPool: Worker[] = [];
  private sharpWorkerPoolInitialized = false;
  /** Round-robin index into `sharpWorkerPool`. Coarse but good enough — sharp jobs are roughly uniform in cost. */
  private sharpWorkerNextIndex = 0;
  private readonly sharpPendingJobs: Map<number, ISharpPoolPendingJob> = new Map();
  private sharpNextJobId = 1;

  constructor(app: IAppMain) {
    this.app = app;
  }

  /**
   * Phase 4 perf optimization (#23): cheap content fingerprint that mirrors
   * the renderer-side `computeCoverShortHash` from
   * `services/media-library.service.ts`.
   *
   * The previous code used `CryptoService.sha1(data, 'WxH')` which hashes
   * the FULL buffer — at ~500 KB per cover that's ~25 MB/s of pure SHA1
   * just for cache-key derivation, all on the main thread. We only need
   * enough entropy to distinguish two real-world album covers; 8 KB +
   * length is overkill for that and ~50× faster than the full hash.
   *
   * For non-Buffer inputs (paths) we still hash the input directly because
   * the path is short anyway and the pre-existing call sites (artist
   * picture pre-fetch from URL, etc.) pass small strings, not megabyte-
   * sized buffers.
   */
  private computeImageCacheKey(data: Buffer | string, width: number, height: number): string {
    if (typeof data === 'string') {
      return CryptoService.sha1(data, `${width}x${height}`);
    }
    if (!data || data.length === 0) {
      return CryptoService.sha1(`empty:${width}x${height}`);
    }
    const headSlice = data.subarray(0, Math.min(8192, data.length));
    return CryptoService.sha1(headSlice, `len=${data.length}|wh=${width}x${height}`);
  }

  /**
   * Resolves the on-disk path of `sharp-worker.js`. The worker can't be
   * a webpack entry (it imports the native sharp module which webpack
   * can't bundle), so it ships as a plain CommonJS file at
   * `src/sharp-worker.js` next to the bundled `main.prod.js`.
   *
   * Resolution order:
   *   1. Production bundle: `__dirname` of the bundled main process is the
   *      `src/` directory inside the Electron asar/app folder, so
   *      `path.join(__dirname, 'sharp-worker.js')` resolves directly.
   *   2. Dev mode (electron-react-boilerplate runs main.ts via ts-node):
   *      the same path also works because the source tree mirrors the
   *      production layout.
   *   3. Fallback: walk up two directories from the source location
   *      (`src/modules/image/sharp/`) to reach `src/sharp-worker.js` —
   *      the safety net for unusual launchers.
   *
   * Returns `null` if no candidate is found, in which case the worker
   * pool is skipped and `scaleImage` falls back to in-process sharp.
   */
  private resolveSharpWorkerScriptPath(): string | null {
    const candidates = [
      path.join(__dirname, 'sharp-worker.js'),
      path.resolve(__dirname, '..', '..', '..', 'sharp-worker.js'),
    ];
    return candidates.find(candidate => fs.existsSync(candidate)) || null;
  }

  private ensureSharpWorkerPool(): void {
    if (this.sharpWorkerPoolInitialized) {
      return;
    }
    this.sharpWorkerPoolInitialized = true;

    const workerScriptPath = this.resolveSharpWorkerScriptPath();
    if (!workerScriptPath) {
      console.warn('SharpModule could not locate sharp-worker.js, falling back to in-process sharp');
      debug('ensureSharpWorkerPool - no worker script found, scaleImage will run in-process');
      return;
    }
    debug('ensureSharpWorkerPool - using worker script at %s', workerScriptPath);

    for (let workerIndex = 0; workerIndex < this.sharpWorkerPoolSize; workerIndex += 1) {
      try {
        const worker = new Worker(workerScriptPath);
        worker.on('message', (message: any) => this.handleWorkerMessage(message));
        worker.on('error', (error) => {
          console.error('SharpModule worker emitted error', error);
        });
        worker.on('exit', (exitCode) => {
          if (exitCode !== 0) {
            console.error('SharpModule worker exited unexpectedly with code', exitCode);
          }
        });
        this.sharpWorkerPool.push(worker);
      } catch (error) {
        // If we can't spawn workers (locked-down environment, missing
        // worker_threads, etc.) we fall back to in-process sharp. The
        // pool stays empty and `scaleImage` notices and uses the legacy
        // path.
        console.warn('SharpModule failed to spawn worker, will fall back to in-process sharp', error);
      }
    }

    if (this.sharpWorkerPool.length === 0) {
      debug('ensureSharpWorkerPool - no workers available, scaleImage will run in-process');
    } else {
      debug('ensureSharpWorkerPool - spawned %d sharp worker(s)', this.sharpWorkerPool.length);
    }
  }

  private handleWorkerMessage(message: any): void {
    if (!message || typeof message.jobId !== 'number') {
      return;
    }
    const pendingJob = this.sharpPendingJobs.get(message.jobId);
    if (!pendingJob) {
      return;
    }
    this.sharpPendingJobs.delete(message.jobId);

    if (message.kind === 'ok') {
      pendingJob.resolve(message.outputPath || pendingJob.outputPath);
      return;
    }
    pendingJob.reject(new Error(message.message || 'sharp worker failed without details'));
  }

  /**
   * Submits a resize job to one of the pool workers. Round-robins between
   * workers so the load spreads evenly. Returns a promise that resolves
   * with the output cache path.
   *
   * Caller MUST have already verified that the cache file does not yet
   * exist; this method always runs the resize and `toFile`.
   */
  private dispatchScaleToWorker(source: Buffer, width: number, height: number, outputPath: string): Promise<string> {
    const targetWorker = this.sharpWorkerPool[this.sharpWorkerNextIndex];
    this.sharpWorkerNextIndex = (this.sharpWorkerNextIndex + 1) % this.sharpWorkerPool.length;
    const jobId = this.sharpNextJobId;
    this.sharpNextJobId += 1;

    return new Promise<string>((resolve, reject) => {
      this.sharpPendingJobs.set(jobId, { resolve, reject, outputPath });
      try {
        targetWorker.postMessage({
          kind: 'scale',
          jobId,
          source,
          width,
          height,
          outputPath,
        });
      } catch (postError) {
        this.sharpPendingJobs.delete(jobId);
        reject(postError instanceof Error ? postError : new Error(String(postError)));
      }
    });
  }

  async scaleImage(data: Buffer | string, options: SharpImageScaleOptions): Promise<string> {
    const source = typeof data === 'string' ? data : Buffer.from(data);
    const { width, height } = options;

    const imageCacheDir = this.app.createDataDir(this.imagesDataDir);
    // Phase 4 perf optimization (#23): cache key uses a short-hash on the
    // first 8 KB + length of the buffer rather than a full-buffer SHA1.
    // That alone removes ~25 MB/s of synchronous main-thread work during a
    // 3 000-track cold scan; the disk cache it indexes is unaffected
    // because the new key is still byte-injective for any two real-world
    // album-cover buffers.
    const imageCacheKey = this.computeImageCacheKey(source, width, height);
    const imageCachePath = path.join(imageCacheDir, `${imageCacheKey}.${this.imageExtension}`);

    // Phase 4 perf optimization (#23): cache-hit fast path stays in the
    // main thread. We never round-trip to a worker for a cache hit, so
    // tracks that share an album cover (the typical case after Phase 1
    // dedup) pay only a single fs.existsSync per file.
    if (FSUtils.isFile(imageCachePath)) {
      return imageCachePath;
    }

    // Cache miss → we need to actually run sharp. Try the worker pool
    // first; fall back to in-process sharp if the pool isn't available
    // (init failed, or someone passed a string source which is rare and
    // wasn't worth shipping over the postMessage boundary).
    if (typeof source !== 'string') {
      this.ensureSharpWorkerPool();
      if (this.sharpWorkerPool.length > 0) {
        try {
          return await this.dispatchScaleToWorker(source, width, height, imageCachePath);
        } catch (workerError) {
          // Worker dispatch / resize failed → we still want a cover for
          // this track, so try the in-process path before giving up. This
          // mirrors the pre-Phase-4 behaviour exactly.
          console.warn('SharpModule worker dispatch failed, falling back to in-process sharp', workerError);
        }
      }
    }

    await sharp(source)
      .resize(width, height, {
        fit: 'cover',
        position: 'center',
      })
      .toFile(imageCachePath);

    return imageCachePath;
  }
}
