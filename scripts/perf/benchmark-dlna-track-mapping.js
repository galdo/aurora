const fs = require('fs');
const os = require('os');
const path = require('path');

function getMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.flac') {
    return 'audio/flac';
  }
  if (extension === '.wav') {
    return 'audio/wav';
  }
  if (extension === '.aiff' || extension === '.aif' || extension === '.aifc') {
    return 'audio/aiff';
  }
  if (extension === '.m4a' || extension === '.mp4') {
    return 'audio/mp4';
  }
  if (extension === '.ogg') {
    return 'audio/ogg';
  }
  return 'audio/mpeg';
}

function oldCreate(track) {
  const filePath = String(track.extra?.file_path || '').trim();
  if (!filePath || !fs.existsSync(filePath)) {
    return undefined;
  }
  const fileStats = fs.statSync(filePath);
  return {
    id: String(track.id || track.provider_id || filePath),
    providerId: String(track.provider_id || ''),
    title: String(track.track_name || path.basename(filePath)),
    artist: String(track.track_artists?.map((artist) => artist.artist_name).join(', ') || ''),
    artistIds: (track.track_artist_ids || []).map((artistId) => String(artistId || '')).filter(Boolean),
    album: String(track.track_album?.album_name || ''),
    albumId: String(track.track_album_id || ''),
    duration: Number(track.track_duration || 0),
    filePath,
    mimeType: getMimeType(filePath),
    fileSize: Number(fileStats.size || 0),
  };
}

function newCreate(track, albumById, artistById) {
  const filePath = String(track.extra?.file_path || '').trim();
  if (!filePath) {
    return undefined;
  }
  const fileSizeFromExtra = Number(track.extra?.file_size);
  const fileSize = Number.isFinite(fileSizeFromExtra) && fileSizeFromExtra > 0
    ? fileSizeFromExtra
    : 0;
  const artistIds = (track.track_artist_ids || []).map((artistId) => String(artistId || '')).filter(Boolean);
  const artistNames = artistIds
    .map((artistId) => artistById.get(artistId))
    .filter(Boolean);
  const albumId = String(track.track_album_id || '');
  const albumName = String(albumById.get(albumId) || '');
  return {
    id: String(track.id || track.provider_id || filePath),
    providerId: String(track.provider_id || ''),
    title: String(track.track_name || path.basename(filePath)),
    artist: String(artistNames.join(', ') || ''),
    artistIds,
    album: albumName,
    albumId,
    duration: Number(track.track_duration || 0),
    filePath,
    mimeType: getMimeType(filePath),
    fileSize,
  };
}

function run(label, fn) {
  if (global.gc) {
    global.gc();
  }
  const startHeap = process.memoryUsage().heapUsed;
  const start = process.hrtime.bigint();
  const result = fn();
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  if (global.gc) {
    global.gc();
  }
  const endHeap = process.memoryUsage().heapUsed;
  return {
    label,
    durationMs: Number(durationMs.toFixed(2)),
    heapDeltaMb: Number(((endHeap - startHeap) / (1024 * 1024)).toFixed(2)),
    count: result.length,
  };
}

function main() {
  const sampleCount = Number(process.argv[2] || 50000);
  const tempFilePath = path.join(os.tmpdir(), 'aurora-dlna-perf-sample.flac');
  fs.writeFileSync(tempFilePath, 'x'.repeat(4096));

  const albumById = new Map();
  const artistById = new Map();
  for (let i = 0; i < 2000; i += 1) {
    albumById.set(`album-${i}`, `Album ${i}`);
    artistById.set(`artist-${i}`, `Artist ${i}`);
  }

  const tracks = Array.from({ length: sampleCount }).map((_, index) => ({
    id: `track-${index}`,
    provider_id: `provider-track-${index}`,
    track_name: `Track ${index}`,
    track_duration: 210,
    track_artist_ids: [`artist-${index % 2000}`],
    track_artists: [{ artist_name: `Artist ${index % 2000}` }],
    track_album_id: `album-${index % 2000}`,
    track_album: { album_name: `Album ${index % 2000}` },
    extra: {
      file_path: tempFilePath,
      file_size: 4096,
    },
  }));

  const oldProfile = run('old', () => tracks.map(oldCreate).filter(Boolean));
  const newProfile = run(
    'new',
    () => tracks.map((track) => newCreate(track, albumById, artistById)).filter(Boolean),
  );

  const output = {
    sampleCount,
    oldProfile,
    newProfile,
    speedupFactor: Number(
      (oldProfile.durationMs / Math.max(newProfile.durationMs, 0.0001)).toFixed(2),
    ),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main();
