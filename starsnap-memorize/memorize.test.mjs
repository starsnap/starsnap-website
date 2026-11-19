import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curriculum, grade, gradeQuestion, loadProgress, normalize, saveProgress, storageKey } from './memorize.mjs';
import { answerDigests } from './answer-digests.mjs';

test('contains both 12-verse series in their supplied order', () => {
  assert.deepEqual(Object.keys(curriculum), ['A', 'B']);
  const a = curriculum.A.flatMap(({ entries }) => entries.map(({ reference }) => reference));
  const b = curriculum.B.flatMap(({ entries }) => entries.map(({ reference }) => reference));
  assert.deepEqual(a, ['고린도후서 5:17', '갈라디아서 2:20', '로마서 12:1', '요한복음 14:21', '디모데후서 3:16', '여호수아 1:8', '요한복음 15:7', '빌립보서 4:6–7', '마태복음 18:20', '히브리서 10:24–25', '마태복음 4:19', '로마서 1:16']);
  assert.deepEqual(b, ['로마서 3:23', '이사야 53:6', '로마서 6:23', '히브리서 9:27', '로마서 5:8', '베드로전서 3:18', '에베소서 2:8–9', '디도서 3:5', '요한복음 1:12', '요한계시록 3:20', '요한일서 5:13', '요한복음 5:24']);
  assert.deepEqual(Object.keys(answerDigests).sort(), [...a, ...b].sort());
  assert(Object.values(answerDigests).every((digest) => /^[0-9a-f]{64}$/.test(digest)));
  assert(curriculum.A.every(({ entries }) => entries.every(({ majorTopic }) => majorTopic === '새로운 삶')));
  assert(curriculum.B.every(({ entries }) => entries.every(({ majorTopic }) => majorTopic === '그리스도를 전파함')));
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

test('grades both topics, the reference, and the passage independently', async () => {
  const verse = curriculum.B[0].entries[0];
  const text = '모든 사람이 죄를 범하였으매 하나님의 영광에 이르지 못하더니';
  const answers = { majorTopic: '그리스도를전파함', topic: '모든 사람이 죄를 범함!', reference: '롬 3:23', text };
  assert.deepEqual(await gradeQuestion(verse, answers), { majorTopic: true, topic: true, reference: true, text: true });
  assert.deepEqual(await gradeQuestion(verse, { ...answers, topic: '죄의 형벌' }), { majorTopic: true, topic: false, reference: true, text: true });
  assert.deepEqual(await gradeQuestion(verse, { ...answers, reference: '롬 32:3' }), { majorTopic: true, topic: true, reference: false, text: true });
  assert.deepEqual(await gradeQuestion(verse, { ...answers, majorTopic: '새로운 삶', text: '다른 본문' }), { majorTopic: false, topic: true, reference: true, text: false });
  const finalB = curriculum.B[5].entries[0];
  for (const topic of ['구원의 확인', '구원의 확신']) {
    assert.equal((await gradeQuestion(finalB, { ...answers, topic })).topic, true);
  }
});

test('accepts common reference formats and requires the correct book and full range', async () => {
  const single = curriculum.B[0].entries[0];
  const range = curriculum.B[3].entries[0];
  const matthew = curriculum.A[4].entries[0];
  const answers = { majorTopic: '', topic: '', reference: '', text: '' };
  const cases = [
    [single, '로마서 3장 23절', true],
    [single, '롬 ３：２３', true],
    [single, '히 3:23', false],
    [single, '롬323', false],
    [matthew, '마태복음 18_20', true],
    [range, '엡 2:8~9', true],
    [range, '에베소서 2:8', false],
    [range, '에베소서 2:8-10', false],
  ];
  for (const [verse, reference, expected] of cases) {
    assert.equal((await gradeQuestion(verse, { ...answers, reference })).reference, expected, reference);
  }
});

test('restores reference-checked records and keeps previous records separate', () => {
  const legacy = '[{"id":"B-1","text":"예시 문장","attempts":0,"completed":true}]';
  const bodyOnly = '[{"id":"B-1","attempts":1,"completed":true}]';
  const topicChecked = '[{"id":"A-1","attempts":2,"completed":true}]';
  const items = new Map([
    ['starsnap-memorize-v1', legacy], ['starsnap-memorize-v2', bodyOnly], ['starsnap-memorize-v3', topicChecked],
  ]);
  const storage = { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) };
  assert.deepEqual(loadProgress(storage), []);
  const saved = [{ id: 'B-1', attempts: 1, completed: true }];
  saveProgress(storage, saved);
  assert.deepEqual(loadProgress(storage), saved);
  assert.equal(items.get('starsnap-memorize-v1'), legacy);
  assert.equal(items.get('starsnap-memorize-v2'), bodyOnly);
  assert.equal(items.get('starsnap-memorize-v3'), topicChecked);
  items.set(storageKey, '[{}]');
  assert.throws(() => loadProgress(storage), /Invalid memorization data/);
});
