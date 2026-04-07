const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

function oldParse(filePath) {
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
    const internalId = String((doc && doc.id) || '');
    if (!internalId) {
      return;
    }
    docsByInternalId.set(internalId, doc);
  });
  return docsByInternalId.size;
}

async function newParse(filePath) {
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
    lineReader.on('line', (line) => {
      if (!line.trim()) {
        return;
      }
      let doc;
      try {
        doc = JSON.parse(line);
      } catch (_error) {
        return;
      }
      const internalId = String((doc && doc.id) || '');
      if (!internalId) {
        return;
      }
      docsByInternalId.set(internalId, doc);
    });
    lineReader.on('close', resolve);
    lineReader.on('error', reject);
    readStream.on('error', reject);
  });
  return docsByInternalId.size;
}

async function profile(label, fn) {
  if (global.gc) {
    global.gc();
  }
  const start = process.hrtime.bigint();
  const startRss = process.memoryUsage().rss;
  const size = await fn();
  if (global.gc) {
    global.gc();
  }
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  const endRss = process.memoryUsage().rss;
  return {
    label,
    size,
    durationMs: Number(durationMs.toFixed(2)),
    rssDeltaMb: Number(((endRss - startRss) / (1024 * 1024)).toFixed(2)),
  };
}

function buildDataset(filePath, itemCount) {
  const chunkSize = 4000;
  const chunks = [];
  for (let index = 0; index < itemCount; index += 1) {
    const doc = JSON.stringify({
      id: `doc-${index}`,
      provider: 'media_local',
      provider_id: `provider-${index}`,
      track_name: `Track ${index}`,
      extra: {
        file_path: `/music/library/${index}.flac`,
        file_size: 1024 + (index % 8192),
        file_mtime: 1700000000000 + index,
      },
    });
    chunks.push(doc);
    if (chunks.length >= chunkSize) {
      fs.appendFileSync(filePath, `${chunks.join('\n')}\n`, 'utf8');
      chunks.length = 0;
    }
  }
  if (chunks.length > 0) {
    fs.appendFileSync(filePath, `${chunks.join('\n')}\n`, 'utf8');
  }
}

async function main() {
  const itemCount = Number(process.argv[2] || 150000);
  const filePath = path.join(os.tmpdir(), `aurora-export-parser-benchmark-${itemCount}.db`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  buildDataset(filePath, itemCount);

  const oldResult = await profile('old', () => Promise.resolve(oldParse(filePath)));
  const newResult = await profile('new', () => newParse(filePath));
  const output = {
    itemCount,
    filePath,
    oldResult,
    newResult,
    speedupFactor: Number(
      (oldResult.durationMs / Math.max(newResult.durationMs, 0.0001)).toFixed(2),
    ),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  fs.unlinkSync(filePath);
}

main().catch((error) => {
  process.stderr.write(`${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});
