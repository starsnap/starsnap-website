import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('network dashboard no longer renders the brand-to-school supply flow', async () => {
  const source = await readFile(path.join(projectRoot, 'app/components/network-views.tsx'), 'utf8');
  assert.doesNotMatch(source, /브랜드에서 학교까지 이어지는 공급 흐름/);
  assert.doesNotMatch(source, /ORDER FLOW/);
  assert.doesNotMatch(source, /function organizationFlow/);
  assert.match(source, /export function NetworkDashboardSummary/);
});
