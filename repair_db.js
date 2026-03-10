const fs = require('fs');

const dbPath = '/Users/I743956/Library/Application Support/Electron/Aurora-debug/Databases/media_albums.db';
const backupPath = `${dbPath}.bak`;
const getInternalId = (doc) => {
  if (!doc) {
    return undefined;
  }
  const { _id: internalId } = doc;
  return internalId;
};
const writeStdout = (message) => process.stdout.write(`${message}\n`);
const writeStderr = (message) => process.stderr.write(`${message}\n`);

if (!fs.existsSync(dbPath)) {
  writeStderr(`Database file not found: ${dbPath}`);
  process.exit(1);
}

const content = fs.readFileSync(dbPath, 'utf8');
const lines = content.split('\n').filter((line) => line.trim().length > 0);

writeStdout(`Read ${lines.length} lines from ${dbPath}`);

const providerIdMap = new Map();

lines.forEach((line, index) => {
  try {
    const doc = JSON.parse(line);

    if (doc.provider_id) {
      if (providerIdMap.has(doc.provider_id)) {
        const prevDoc = providerIdMap.get(doc.provider_id);
        if (getInternalId(prevDoc) !== getInternalId(doc)) {
          writeStdout(`Conflict found! provider_id: ${doc.provider_id}`);
          writeStdout(`  Existing _id: ${getInternalId(prevDoc)}`);
          writeStdout(`  New _id: ${getInternalId(doc)}`);
        }
      }
      providerIdMap.set(doc.provider_id, doc);
    }
  } catch (error) {
    writeStderr(`Error parsing line ${index}: ${error.message}`);
  }
});

const uniqueDocs = Array.from(providerIdMap.values());
const newContent = `${uniqueDocs.map((doc) => JSON.stringify(doc)).join('\n')}\n`;

writeStdout(`Writing ${uniqueDocs.length} unique documents back to DB.`);

fs.copyFileSync(dbPath, backupPath);
fs.writeFileSync(dbPath, newContent);

writeStdout('Database repair complete.');
