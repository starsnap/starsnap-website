import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curriculum, grade, loadProgress, normalize, saveProgress } from './memorize.mjs';

test('contains both 12-verse series in their supplied order', () => {
  assert.deepEqual(Object.keys(curriculum), ['A', 'B']);
  const a = curriculum.A.flatMap(({ entries }) => entries.map(({ reference }) => reference));
  const b = curriculum.B.flatMap(({ entries }) => entries.map(({ reference }) => reference));
  assert.deepEqual(a, ['고린도후서 5:17', '갈라디아서 2:20', '로마서 12:1', '요한복음 14:21', '디모데후서 3:16', '여호수아 1:8', '요한복음 15:7', '빌립보서 4:6–7', '마태복음 18:20', '히브리서 10:24–25', '마태복음 4:19', '로마서 1:16']);
  assert.deepEqual(b, ['로마서 3:23', '이사야 53:6', '로마서 6:23', '히브리서 9:27', '로마서 5:8', '베드로전서 3:18', '에베소서 2:8–9', '디도서 3:5', '요한복음 1:12', '요한계시록 3:20', '요한일서 5:13', '요한복음 5:24']);
});

test('matches Korean input with different spacing, punctuation and Unicode forms', () => {
  assert.equal(normalize(' ＳＴＡＲ 한글！ '), 'star한글');
  assert.equal(grade('평안한 하루, 되세요.', '평안한하루 되세요!').correct, true);
});

test('reports only the matching prefix and rejects extra, missing, or empty answers', () => {
  assert.deepEqual(grade('가나다', '가나다라'), { correct: false, prefix: 3, expectedLength: 3, submittedLength: 4 });
  assert.equal(grade('가나다', '가나').correct, false);
  assert.equal(grade('가나다', '가나다').correct, true);
  assert.equal(grade('가나다', '가나마').prefix, 2);
  assert.equal(grade('!', '?').correct, false);
});

test('restores saved records and surfaces invalid storage', () => {
  let raw = null;
  const storage = { getItem: () => raw, setItem: (_, value) => { raw = value; } };
  assert.deepEqual(loadProgress(storage), []);
  const saved = [{ id: 'B-1', text: '예시 문장', attempts: 1, completed: true }];
  saveProgress(storage, saved);
  assert.deepEqual(loadProgress(storage), saved);
  raw = '[{}]';
  assert.throws(() => loadProgress(storage), /Invalid memorization data/);
});
