import { normalize } from './memorize.mjs';

const segmenter = new Intl.Segmenter('ko');

function sourceSpans(text, characters) {
  const segments = [...segmenter.segment(text)];
  const localCharacters = [];
  const spans = [];
  for (const { segment, index } of segments) {
    for (const character of normalize(segment)) {
      localCharacters.push(character);
      spans.push([index, index + segment.length]);
    }
  }
  if (localCharacters.join('') === characters.join('')) return spans;

  // Compatibility characters can compose across the original grapheme boundaries.
  spans.length = 0;
  let previous = [];
  for (const { segment, index } of segments) {
    const end = index + segment.length;
    const next = [...normalize(text.slice(0, end))];
    let shared = 0;
    while (shared < previous.length && previous[shared] === next[shared]) shared++;
    const start = spans[shared]?.[0] ?? index;
    spans.length = shared;
    while (spans.length < next.length) spans.push([start, end]);
    previous = next;
  }
  return spans;
}

function insideWord(text, spans, index) {
  return index > 0 && index < spans.length &&
    !/\s/u.test(text.slice(spans[index - 1][1], spans[index][0]));
}

export function reviewMistakes(reference, text) {
  const expected = [...normalize(reference)];
  const entered = [...normalize(text)];
  const referenceSpans = sourceSpans(reference, expected);
  const textSpans = sourceSpans(text, entered);
  const rows = Array.from({ length: expected.length + 1 }, () => new Uint16Array(entered.length + 1));
  for (let i = expected.length; i >= 0; i--) {
    rows[i][entered.length] = expected.length - i;
    for (let j = entered.length - 1; j >= 0; j--) {
      if (i === expected.length) rows[i][j] = entered.length - j;
      else if (expected[i] === entered[j]) rows[i][j] = rows[i + 1][j + 1];
      else rows[i][j] = 1 + Math.min(rows[i + 1][j + 1], rows[i + 1][j], rows[i][j + 1]);
    }
  }

  const path = [[0, 0]];
  const changed = [];
  const matches = [];
  let i = 0;
  let j = 0;
  while (i < expected.length || j < entered.length) {
    const match = i < expected.length && j < entered.length && expected[i] === entered[j];
    const step = matches.length;
    matches.push(match);
    if (match) {
      i++;
      j++;
    } else {
      const previous = changed.at(-1);
      if (previous?.[1] === step) previous[1]++;
      else changed.push([step, step + 1]);
      const distance = rows[i][j] - 1;
      if (i < expected.length && rows[i + 1][j] === distance) i++;
      else if (j < entered.length && rows[i][j + 1] === distance) j++;
      else {
        i++;
        j++;
      }
    }
    path.push([i, j]);
  }

  const phrases = [];
  for (let [start, end] of changed) {
    const hasReference = path[start][0] !== path[end][0];
    const wordAt = (step) => hasReference
      ? insideWord(reference, referenceSpans, path[step][0])
      : insideWord(text, textSpans, path[step][1]);
    while (matches[start - 1] && wordAt(start)) start--;
    while (matches[end] && wordAt(end)) end++;
    // Anchor a missing word to a nearby matching word in the submitted text.
    if (path[start][1] === path[end][1]) {
      if (matches[end]) {
        do { end++; } while (matches[end] && wordAt(end));
      } else if (matches[start - 1]) {
        do { start--; } while (matches[start - 1] && wordAt(start));
      }
    }
    const previous = phrases.at(-1);
    if (previous && start < previous[1]) previous[1] = Math.max(previous[1], end);
    else phrases.push([start, end]);
  }

  // Review can show short corrections without revealing the full answer.
  let hintBudget = Math.min(24, expected.length - 1);
  return phrases.map(([first, last]) => {
    const [refStart, textStart] = path[first];
    const [refEnd, textEnd] = path[last];
    const start = textSpans[textStart]?.[0] ?? textSpans.at(-1)?.[1] ?? 0;
    const end = textStart === textEnd ? start : textSpans[textEnd - 1][1];
    const length = refEnd - refStart;
    let correct = null;
    if (length === 0) correct = '';
    else if (length <= hintBudget) {
      correct = reference.slice(referenceSpans[refStart][0], referenceSpans[refEnd - 1][1]);
      hintBudget -= length;
    }
    return { start, end, correct };
  });
}
