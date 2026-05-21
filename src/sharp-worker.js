// Phase 4 perf optimization (#23): worker-thread for sharp resize jobs.
//
// Why a worker?
//   sharp is internally multi-threaded via libvips, but each invocation
//   still does meaningful work on the calling thread: argument marshalling,
//   colorspace conversion setup, output encoding (libjpeg/libpng), and the
//   final fs.writeFile. During a 3 000-track cold-scan that synchronous
//   work piles up on the Electron main process, blocking IPC handlers
//   for the renderer (UI flips, datastore queries, file-system streaming).
//
//   Moving the actual `sharp(buf).resize().toFile()` into a worker frees
//   the main process to keep handling renderer IPC + file-walk events
//   while resize jobs run in parallel on real OS threads.
//
// Why JavaScript and not TypeScript?
//   The renderer/main bundle is built by webpack via electron-forge. The
//   worker file gets resolved at runtime via `__filename` of the module
//   that imports it; shipping a plain `.js` keeps it independent of the
//   build pipeline — it's loaded directly by Node's worker_threads API
//   from the same path the SharpModule itself lives in. No extra webpack
//   entry, no copy step in the forge config.
//
// What does it expect / return?
//   Each message is `{ kind: 'scale', jobId, source, width, height, outputPath }`
//   where `source` is a Node Buffer (transferred, not copied). The worker
//   replies with either `{ kind: 'ok', jobId, outputPath }` or
//   `{ kind: 'error', jobId, message }`. The pool in `module.ts` keeps
//   track of pending jobs by jobId and resolves the matching promise.
//
//   We deliberately do NOT do the cache-key hashing or the `fs.existsSync`
//   in here — those stay synchronous in the main thread so a cache hit
//   never even has to round-trip to a worker. See the comments in
//   `SharpModule.scaleImage` for that fast path.

/* eslint-disable */
const { parentPort } = require('worker_threads');
const sharp = require('sharp');

if (!parentPort) {
  // We were loaded outside of a worker context — bail out so we don't
  // fail with a confusing stack trace later.
  throw new Error('sharp-worker.js must be run via worker_threads');
}

parentPort.on('message', async (message) => {
  if (!message || message.kind !== 'scale') {
    return;
  }
  const { jobId, source, width, height, outputPath } = message;
  try {
    // The buffer was sent through `postMessage` with structured cloning;
    // sharp accepts it directly. We don't need to wrap it in Buffer.from
    // again — the worker's V8 isolate already received an exact copy.
    await sharp(source)
      .resize(width, height, {
        fit: 'cover',
        position: 'center',
      })
      .toFile(outputPath);
    parentPort.postMessage({ kind: 'ok', jobId, outputPath });
  } catch (error) {
    parentPort.postMessage({
      kind: 'error',
      jobId,
      message: String(error && error.message ? error.message : error),
    });
  }
});