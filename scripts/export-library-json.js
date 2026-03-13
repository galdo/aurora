const fs = require('fs');
const path = require('path');
const os = require('os');

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

function parseDatastoreFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  const docsByInternalId = new Map();
  lines.forEach((line) => {
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
  return Array.from(docsByInternalId.values());
}

function main() {
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

  datastoreNames.forEach((name) => {
    const filePath = path.join(dbDir, `${name}.db`);
    exportPayload.collections[name] = parseDatastoreFile(filePath);
  });

  const defaultOutputFileName = `aurora-library-export-${Date.now()}.json`;
  const outputPath = path.resolve(args.output || defaultOutputFileName);
  fs.writeFileSync(outputPath, JSON.stringify(exportPayload, null, 2), 'utf8');

  process.stdout.write(`Library export written to ${outputPath}\n`);
}

main();
