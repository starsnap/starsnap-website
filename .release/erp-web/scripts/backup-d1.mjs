import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, open, rename, rm } from 'node:fs/promises';
import { backup, DatabaseSync } from 'node:sqlite';

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) {
  console.error('Usage: node scripts/backup-d1.mjs <source.sqlite> <output.sqlite>');
  process.exit(2);
}

try {
  await access(outputPath);
  throw new Error(`Refusing to overwrite an existing backup: ${outputPath}`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
const temporarySidecars = [`${temporaryPath}-shm`, `${temporaryPath}-wal`];
let completed = false;
try {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, temporaryPath);
  } finally {
    source.close();
  }

  const snapshot = new DatabaseSync(temporaryPath, { readOnly: true });
  let quickCheck;
  let foreignKeyIssues;
  let counts;
  try {
    quickCheck = snapshot.prepare('PRAGMA quick_check').get()?.quick_check;
    foreignKeyIssues = snapshot.prepare('PRAGMA foreign_key_check').all();
    const tables = snapshot.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    ).all();
    counts = Object.fromEntries(tables.map(({ name }) => [
      name,
      Number(snapshot.prepare(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`).get().count),
    ]));
  } finally {
    snapshot.close();
  }
  await Promise.all(temporarySidecars.map((path) => rm(path, { force: true })));

  if (quickCheck !== 'ok' || foreignKeyIssues.length !== 0) {
    throw new Error(`Invalid D1 backup: quick_check=${quickCheck}, foreign_key_issues=${foreignKeyIssues.length}`);
  }

  // Windows requires a writable handle for FlushFileBuffers (fsync).
  const handle = await open(temporaryPath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  const sha256 = await sha256File(temporaryPath);
  await rename(temporaryPath, outputPath);
  completed = true;
  console.log(JSON.stringify({ outputPath, sha256, quickCheck, foreignKeyIssues: 0, counts }));
} finally {
  await Promise.all([
    ...temporarySidecars,
    ...(completed ? [] : [temporaryPath]),
  ].map((path) => rm(path, { force: true })));
}
