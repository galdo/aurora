function oldResolve(albumId, albums, tracks) {
  const selectedAlbum = albums.find((album) => album.id === albumId);
  if (!selectedAlbum) {
    return [];
  }
  const selectedFingerprint = String(selectedAlbum.sourceFingerprint || '').trim();
  const matchingAlbumIds = albums
    .filter((album) => {
      const candidateFingerprint = String(album.sourceFingerprint || '').trim();
      return selectedFingerprint
        && candidateFingerprint
        && candidateFingerprint === selectedFingerprint;
    })
    .map((album) => album.id);

  const targetAlbumIds = [albumId, ...matchingAlbumIds];
  const directTracks = tracks.filter((track) => targetAlbumIds.includes(track.track_album_id));
  const fileSources = Array.from(
    new Set(directTracks.map((track) => String(track.fileSource || '')).filter(Boolean)),
  );
  const fromFileSources = fileSources.length > 0
    ? tracks.filter((track) => fileSources.includes(track.fileSource))
    : [];
  const byId = new Map();
  [...directTracks, ...fromFileSources].forEach((track) => byId.set(track.id, track));
  return Array.from(byId.values());
}

function newResolve(albumId, albumsByFingerprint, tracksByAlbumId) {
  const albumIds = albumsByFingerprint.get(albumId) || [albumId];
  const result = [];
  albumIds.forEach((currentAlbumId) => {
    const albumTracks = tracksByAlbumId.get(currentAlbumId) || [];
    result.push(...albumTracks);
  });
  return result;
}

function profile(label, fn) {
  if (global.gc) {
    global.gc();
  }
  const start = process.hrtime.bigint();
  const result = fn();
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  return {
    label,
    durationMs: Number(durationMs.toFixed(2)),
    count: result.length,
  };
}

function buildDataset(albumCount, tracksPerAlbum, compMergeSize) {
  const albums = [];
  const tracks = [];
  let trackCounter = 0;
  for (let index = 0; index < albumCount; index += 1) {
    const fingerprintGroup = Math.floor(index / compMergeSize);
    const sourceFingerprint = `fp-${fingerprintGroup}`;
    const albumId = `album-${index}`;
    albums.push({
      id: albumId,
      sourceFingerprint,
    });
    for (let trackIndex = 0; trackIndex < tracksPerAlbum; trackIndex += 1) {
      tracks.push({
        id: `track-${trackCounter}`,
        track_album_id: albumId,
        fileSource: `/music/group-${fingerprintGroup}`,
      });
      trackCounter += 1;
    }
  }

  const albumsByFingerprint = new Map();
  const idsByFingerprint = new Map();
  albums.forEach((album) => {
    const ids = idsByFingerprint.get(album.sourceFingerprint) || [];
    ids.push(album.id);
    idsByFingerprint.set(album.sourceFingerprint, ids);
  });
  albums.forEach((album) => {
    albumsByFingerprint.set(album.id, idsByFingerprint.get(album.sourceFingerprint) || [album.id]);
  });

  const tracksByAlbumId = new Map();
  tracks.forEach((track) => {
    const items = tracksByAlbumId.get(track.track_album_id) || [];
    items.push(track);
    tracksByAlbumId.set(track.track_album_id, items);
  });

  return {
    albums,
    tracks,
    albumsByFingerprint,
    tracksByAlbumId,
  };
}

function main() {
  const albumCount = Number(process.argv[2] || 12000);
  const tracksPerAlbum = Number(process.argv[3] || 9);
  const compMergeSize = Number(process.argv[4] || 3);
  const dataset = buildDataset(albumCount, tracksPerAlbum, compMergeSize);
  const targetAlbumId = `album-${Math.floor(albumCount / 2)}`;

  const oldResult = profile('old', () => oldResolve(targetAlbumId, dataset.albums, dataset.tracks));
  const newResult = profile(
    'new',
    () => newResolve(targetAlbumId, dataset.albumsByFingerprint, dataset.tracksByAlbumId),
  );

  const output = {
    albumCount,
    tracksPerAlbum,
    totalTracks: dataset.tracks.length,
    oldResult,
    newResult,
    speedupFactor: Number(
      (oldResult.durationMs / Math.max(newResult.durationMs, 0.0001)).toFixed(2),
    ),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main();
