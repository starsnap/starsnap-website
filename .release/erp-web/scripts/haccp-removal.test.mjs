import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { moduleIdsForOrganization } from '../app/lib/organization-modules.ts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoots = ['app', 'db'];
const ignoredFiles = new Set(['db/postgres-migrations.ts']);

async function sourceFiles(relativeDirectory) {
  const directory = path.join(projectRoot, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relativePath);
    return /\.(?:mjs|ts|tsx)$/.test(entry.name) ? [relativePath] : [];
  }));
  return nested.flat();
}

test('all organization menus exclude the retired HACCP module', () => {
  for (const organizationType of ['BRAND', 'DEALER', 'BIDDER']) {
    assert.equal(moduleIdsForOrganization(organizationType).includes('haccp'), false);
  }
});

test('runtime source and smoke tooling contain no HACCP feature references', async () => {
  const files = (await Promise.all(runtimeRoots.map(sourceFiles))).flat()
    .filter((file) => !ignoredFiles.has(file));
  files.push('scripts/api-smoke.mjs');

  const matches = [];
  for (const file of files) {
    const source = await readFile(path.join(projectRoot, file), 'utf8');
    if (/haccp/i.test(source)) matches.push(file);
  }
  assert.deepEqual(matches, []);
});

test('legacy HACCP table is preserved but never imported or truncated', async () => {
  const source = await readFile(path.join(projectRoot, 'scripts/migrate-d1-to-postgres.mjs'), 'utf8');
  assert.match(source, /const retiredTables = \['haccp_checks'\]/);
  assert.doesNotMatch(source, /\{ table: 'haccp_checks', columns:/);
  assert.doesNotMatch(source, /replacedDestinationTables = \[[\s\S]*?'haccp_checks'/);
  assert.match(source, /const retiredSnapshots = await snapshotRetiredTables\(client\)/);
  assert.match(source, /\[\.\.\.retiredTables, \.\.\.replacedDestinationTables\]/);
  assert.match(source, /await restoreRetiredTables\(client, retiredSnapshots\)/);
});
