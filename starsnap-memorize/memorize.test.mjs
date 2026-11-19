import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curriculum, grade, loadProgress, normalize, saveProgress, storageKey } from './memorize.mjs';
import { answerDigests } from './answer-digests.mjs';

test('contains both 12-verse series in their supplied order', () => {
  assert.deepEqual(Object.keys(curriculum), ['A', 'B']);
  const a = curriculum.A.flatMap(({ entries }) => entries.map(({ reference }) => reference));
  const b = curriculum.B.flatMap(({ entries }) => entries.map(({ reference }) => reference));
  assert.deepEqual(a, ['고린도후서 5:17', '갈라디아서 2:20', '로마서 12:1', '요한복음 14:21', '디모데후서 3:16', '여호수아 1:8', '요한복음 15:7', '빌립보서 4:6–7', '마태복음 18:20', '히브리서 10:24–25', '마태복음 4:19', '로마서 1:16']);
  assert.deepEqual(b, ['로마서 3:23', '이사야 53:6', '로마서 6:23', '히브리서 9:27', '로마서 5:8', '베드로전서 3:18', '에베소서 2:8–9', '디도서 3:5', '요한복음 1:12', '요한계시록 3:20', '요한일서 5:13', '요한복음 5:24']);
  assert.deepEqual(Object.keys(answerDigests).sort(), [...a, ...b].sort());
  assert(Object.values(answerDigests).every((digest) => /^[0-9a-f]{64}$/.test(digest)));
});

test('checks the reference with different Korean spacing, punctuation and Unicode forms', async () => {
  assert.equal(normalize(' ＳＴＡＲ 한글！ '), 'star한글');
  const answer = '모든사람이 죄를 범하였으매, 하나님의 영광에 이르지 못하더니.';
  assert.equal(await grade('로마서 3:23', answer.normalize('NFD')), true);
  assert.equal(await grade('로마서 6:23', answer), false);
});

test('rejects incomplete, altered, and empty answers', async () => {
  assert.equal(await grade('로마서 3:23', '모든 사람이 죄를 범하였으매'), false);
  assert.equal(await grade('로마서 3:23', '모든 사람이 죄를 범하였으므로 하나님의 영광에 이르지 못하더니'), false);
  assert.equal(await grade('로마서 3:23', '?!'), false);
});

test('keeps previous manual checks separate and restores only new records', () => {
  const legacy = '[{"id":"B-1","text":"예시 문장","attempts":0,"completed":true}]';
  const items = new Map([['starsnap-memorize-v1', legacy]]);
  const storage = { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) };
  assert.deepEqual(loadProgress(storage), []);
  const saved = [{ id: 'B-1', attempts: 1, completed: true }];
  saveProgress(storage, saved);
  assert.deepEqual(loadProgress(storage), saved);
  assert.equal(items.get('starsnap-memorize-v1'), legacy);
  items.set(storageKey, '[{}]');
  assert.throws(() => loadProgress(storage), /Invalid memorization data/);
});
