const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const datastoreNames = [
  'media_providers',
  'media_artists',
  'media_albums',
  'media_tracks',
  'media_playlists',
  'media_liked_tracks',
  'media_pinned_items',
];

function parseArgs(argv) {
  const args = {
    debug: false,
    output: '',
    dbDir: '',
  };
  argv.forEach((arg, index) => {
    if (arg === '--debug') {
      args.debug = true;
    }
    if (arg === '--output') {
      args.output = argv[index + 1] || '';
    }
    if (arg === '--db-dir') {
      args.dbDir = argv[index + 1] || '';
    }
  });
  return args;
}

function resolveDbDir(args) {
  if (args.dbDir) {
    return path.resolve(args.dbDir);
  }
  const appDataDirName = args.debug ? 'Aurora_Pulse-debug' : 'Aurora_Pulse';
  return path.join(os.homedir(), 'Library', 'Application Support', appDataDirName, 'Databases');
}

async function parseDatastoreFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const docsByInternalId = new Map();
  const readStream = fs.createReadStream(filePath, {
    encoding: 'utf8',
    highWaterMark: 1024 * 1024,
  });
  const lineReader = readline.createInterface({
    input: readStream,
    crlfDelay: Infinity,
  });

  await new Promise((resolve, reject) => {
    lineReader.on('line', (rawLine) => {
      const line = String(rawLine || '');
      if (!line.trim()) {
        return;
      }
      let doc;
      try {
        doc = JSON.parse(line);
      } catch (_error) {
        return;
      }
      if (!doc || typeof doc !== 'object') {
        return;
      }
      const internalIdRaw = Reflect.get(doc, '_id') || doc.id;
      if (doc.$$deleted && internalIdRaw) {
        docsByInternalId.delete(String(internalIdRaw));
        return;
      }
      if (Object.keys(doc).some((key) => key.startsWith('$$'))) {
        return;
      }
      const internalId = String(internalIdRaw || '');
      if (!internalId) {
        return;
      }
      docsByInternalId.set(internalId, doc);
    });
    lineReader.on('close', resolve);
    lineReader.on('error', reject);
    readStream.on('error', reject);
  });

  return Array.from(docsByInternalId.values());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbDir = resolveDbDir(args);
  if (!fs.existsSync(dbDir)) {
    process.stderr.write(`Datastore directory not found: ${dbDir}\n`);
    process.exit(1);
  }

  const exportPayload = {
    generated_at: new Date().toISOString(),
    db_dir: dbDir,
    collections: {},
  };

  const collectionEntries = await Promise.all(datastoreNames.map(async (name) => {
    const filePath = path.join(dbDir, `${name}.db`);
    return [name, await parseDatastoreFile(filePath)];
  }));
  exportPayload.collections = Object.fromEntries(collectionEntries);

  const defaultOutputFileName = `aurora-library-export-${Date.now()}.json`;
  const outputPath = path.resolve(args.output || defaultOutputFileName);
  fs.writeFileSync(outputPath, JSON.stringify(exportPayload, null, 2), 'utf8');

  process.stdout.write(`Library export written to ${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});
