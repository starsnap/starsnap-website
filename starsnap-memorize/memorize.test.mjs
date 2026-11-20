import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curriculum, grade, gradeMajorTopic, gradeQuestion, loadProgress, normalize, resetSeriesProgress, saveProgress, storageKey } from './memorize.mjs';
import { answerDigests } from './answer-digests.mjs';
import { reviewMistakes } from './verse-review.mjs';

test('groups nearby letter edits into readable comparisons in the submitted text', () => {
  const compare = (reference, text) => reviewMistakes(reference, text)
    .map(({ start, end, correct }) => [text.slice(start, end), correct]);
  assert.deepEqual(
    compare('사는 것이 아니요 오직 나를 위하여', '사는 것이 아니라 오직 나를 위해'),
    [['아니라', '아니요'], ['위해', '위하여']],
  );
  assert.deepEqual(compare('육체 가운데 사는 것은', '가운데 사는것을'), [['가운데', '육체 가운데'], ['것을', '것은']]);
  assert.deepEqual(compare('육체 가운데 사는 것은', '육체 가운데 무척 사는 것은'), [['무척', '']]);
  assert.deepEqual(compare('육체 가운데 사는 것은', '육체 가운자데 사는 것은'), [['가운자데', '가운데']]);
  assert.deepEqual(compare('가 나 다 라 마', '‘가 나\n다 라 마!’'), []);
  assert.deepEqual(compare('나 여기 있다', 'ㄱㅏ 여기 있다'), [['ㄱㅏ', '나']]);
  assert.deepEqual(compare('가', '가'.normalize('NFD')), []);
  assert.deepEqual(compare('가 나 다 라 마', ''), [['', null]]);
});

test('contains both 12-verse series in their supplied order', () => {
  assert.deepEqual(Object.keys(curriculum), ['A', 'B']);
  const a = curriculum.A.flatMap(({ entries }) => entries.map(({ reference }) => reference));
  const b = curriculum.B.flatMap(({ entries }) => entries.map(({ reference }) => reference));
  assert.deepEqual(a, ['고린도후서 5:17', '갈라디아서 2:20', '로마서 12:1', '요한복음 14:21', '디모데후서 3:16', '여호수아 1:8', '요한복음 15:7', '빌립보서 4:6–7', '마태복음 18:20', '히브리서 10:24–25', '마태복음 4:19', '로마서 1:16']);
  assert.deepEqual(b, ['로마서 3:23', '이사야 53:6', '로마서 6:23', '히브리서 9:27', '로마서 5:8', '베드로전서 3:18', '에베소서 2:8–9', '디도서 3:5', '요한복음 1:12', '요한계시록 3:20', '요한일서 5:13', '요한복음 5:24']);
  assert.deepEqual(Object.keys(answerDigests).sort(), [...a, ...b].sort());
  assert(Object.values(answerDigests).every((digest) => /^[0-9a-f]{64}$/.test(digest)));
  assert(curriculum.A.every(({ entries }) => entries.every(({ series }) => series === 'A')));
  assert(curriculum.B.every(({ entries }) => entries.every(({ series }) => series === 'B')));
});

test('checks each series major topic independently', () => {
  assert.equal(gradeMajorTopic('A', '새로운삶!'), true);
  assert.equal(gradeMajorTopic('B', '그리스도를 전파함'), true);
  assert.equal(gradeMajorTopic('B', '새로운 삶'), false);
  assert.equal(gradeMajorTopic('C', '새로운 삶'), false);
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

test('grades the minor topic, reference, and passage independently of the major topic', async () => {
  const verse = curriculum.B[0].entries[0];
  const text = '모든 사람이 죄를 범하였으매 하나님의 영광에 이르지 못하더니';
  const answers = { topic: '모든 사람이 죄를 범함!', book: '롬', chapter: '3', startVerse: '23', endVerse: '', text };
  assert.deepEqual(await gradeQuestion(verse, answers), { topic: true, reference: true, text: true });
  assert.deepEqual(await gradeQuestion(verse, { ...answers, topic: '죄의 형벌' }), { topic: false, reference: true, text: true });
  assert.deepEqual(await gradeQuestion(verse, { ...answers, chapter: '32', startVerse: '3' }), { topic: true, reference: false, text: true });
  assert.deepEqual(await gradeQuestion(verse, { ...answers, text: '다른 본문' }), { topic: true, reference: true, text: false });
  const finalB = curriculum.B[5].entries[0];
  for (const topic of ['구원의 확인', '구원의 확신']) {
    assert.equal((await gradeQuestion(finalB, { ...answers, topic })).topic, true);
  }
});

test('checks chapters and verse endpoints as separate numbers', async () => {
  const single = curriculum.B[0].entries[0];
  const range = curriculum.B[3].entries[0];
  const matthew = curriculum.A[4].entries[0];
  const answers = { topic: '', text: '' };
  const cases = [
    [single, '로마서', '3', '23', '', true],
    [single, '롬', '３', '２３', '', true],
    [single, '로마서', '3장', '23', '', false],
    [single, '히', '3', '23', '', false],
    [single, '롬', '23', '3', '', false],
    [single, '롬', '3', '23', '24', false],
    [matthew, '마태복음', '18', '20', '', true],
    [range, '엡', '2', '8', '9', true],
    [range, '에베소서', '2', '8', '', false],
    [range, '에베소서', '2', '8-9', '', false],
    [range, '에베소서', '2', '8', '10', false],
  ];
  for (const [verse, book, chapter, startVerse, endVerse, expected] of cases) {
    const result = await gradeQuestion(verse, { ...answers, book, chapter, startVerse, endVerse });
    assert.equal(result.reference, expected, `${book} ${chapter}:${startVerse}–${endVerse}`);
  }
});

test('restores past completions and recognizes their series major topics', () => {
  const previous = [
    { id: 'A-1', attempts: 2, completed: true },
    { id: 'A-2', attempts: 1, completed: true },
    { id: 'B-1', attempts: 3, completed: false },
  ];
  const items = new Map([['starsnap-memorize-v3', JSON.stringify(previous)]]);
  const storage = { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) };
  assert.deepEqual(loadProgress(storage), { entries: [], completedSeries: [] });
  items.set('starsnap-memorize-v4', JSON.stringify(previous));
  assert.deepEqual(loadProgress(storage), { entries: previous, completedSeries: ['A'] });
  const saved = { entries: previous, completedSeries: ['A', 'B'] };
  saveProgress(storage, saved);
  assert.deepEqual(loadProgress(storage), saved);
  assert.equal(items.get('starsnap-memorize-v4'), JSON.stringify(previous));
  const cleared = { entries: [], completedSeries: [] };
  saveProgress(storage, cleared);
  assert.deepEqual(loadProgress(storage), cleared);
  assert.equal(items.get('starsnap-memorize-v4'), JSON.stringify(previous));
  items.set(storageKey, '[{}]');
  assert.throws(() => loadProgress(storage), /Invalid memorization data/);
  items.set(storageKey, JSON.stringify({ entries: [], completedSeries: ['C'] }));
  assert.throws(() => loadProgress(storage), /Invalid memorization data/);
});

test('resets just the chosen series, including when the records were migrated', () => {
  const a = [{ id: 'A-1', attempts: 2, completed: true }, { id: 'A-2', attempts: 3, completed: false }];
  const b = [{ id: 'B-1', attempts: 4, completed: true }];
  const previous = JSON.stringify([...a, ...b]);
  const items = new Map([['starsnap-memorize-v4', previous]]);
  const storage = { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) };
  const migrated = loadProgress(storage);
  assert.deepEqual(resetSeriesProgress(migrated, 'B'), { entries: a, completedSeries: ['A'] });
  saveProgress(storage, resetSeriesProgress(migrated, 'A'));
  assert.deepEqual(loadProgress(storage), { entries: b, completedSeries: ['B'] });
  assert.equal(items.get('starsnap-memorize-v4'), previous);
});
