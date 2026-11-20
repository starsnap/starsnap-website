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

export function mistakeRanges(reference, text) {
  const expected = [...reference];
  const entered = [...normalize(text)];
  const spans = sourceSpans(text, entered);
  const rows = Array.from({ length: expected.length + 1 }, () => new Uint16Array(entered.length + 1));
  for (let i = expected.length; i >= 0; i--) {
    rows[i][entered.length] = expected.length - i;
    for (let j = entered.length - 1; j >= 0; j--) {
      if (i === expected.length) rows[i][j] = entered.length - j;
      else if (expected[i] === entered[j]) rows[i][j] = rows[i + 1][j + 1];
      else rows[i][j] = 1 + Math.min(rows[i + 1][j + 1], rows[i + 1][j], rows[i][j + 1]);
    }
  }

  const ranges = [];
  let i = 0;
  let j = 0;
  while (i < expected.length || j < entered.length) {
    if (i < expected.length && j < entered.length && expected[i] === entered[j]) {
      i++;
      j++;
      continue;
    }
    const distance = rows[i][j] - 1;
    // Prefer an omission or surplus when it aligns the next matching character.
    if (i < expected.length && rows[i + 1][j] === distance) {
      const offset = spans[j]?.[0] ?? spans.at(-1)?.[1] ?? 0;
      ranges.push([offset, offset]);
      i++;
    } else if (j < entered.length && rows[i][j + 1] === distance) {
      ranges.push(spans[j++]);
    } else {
      ranges.push(spans[j++]);
      i++;
    }
  }

  const merged = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else if (last && start === last[0] && end === last[1]) continue;
    else if (last && last[0] !== last[1] && start === last[1] && start !== end) last[1] = end;
    else merged.push([start, end]);
  }
  return merged;
}
