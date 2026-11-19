export const storageKey = 'starsnap-memorize-v1';

const outline = {
  A: [
    ['중심되신 그리스도', '고린도후서 5:17', '갈라디아서 2:20'],
    ['그리스도께 순종', '로마서 12:1', '요한복음 14:21'],
    ['말씀', '디모데후서 3:16', '여호수아 1:8'],
    ['기도', '요한복음 15:7', '빌립보서 4:6–7'],
    ['교제', '마태복음 18:20', '히브리서 10:24–25'],
    ['증거', '마태복음 4:19', '로마서 1:16'],
  ],
  B: [
    ['모든 사람이 죄를 범함', '로마서 3:23', '이사야 53:6'],
    ['죄의 형벌', '로마서 6:23', '히브리서 9:27'],
    ['그리스도가 형벌을 받음', '로마서 5:8', '베드로전서 3:18'],
    ['선행으로 구원받지 못함', '에베소서 2:8–9', '디도서 3:5'],
    ['그리스도를 모셔야 함', '요한복음 1:12', '요한계시록 3:20'],
    ['구원의 확인', '요한일서 5:13', '요한복음 5:24'],
  ],
};

export const curriculum = Object.fromEntries(Object.entries(outline).map(([series, topics]) => [series,
  topics.map(([topic, ...references], index) => ({
    topic,
    entries: references.map((reference, offset) => ({
      id: `${series}-${index * 2 + offset + 1}`,
      reference,
      topic,
    })),
  })),
]));

const allowedIds = new Set(Object.values(curriculum).flat().flatMap(({ entries }) => entries.map(({ id }) => id)));

export function normalize(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

export function grade(text, answer) {
  const expected = Array.from(normalize(text));
  const submitted = Array.from(normalize(answer));
  const limit = Math.min(expected.length, submitted.length);
  let prefix = 0;
  while (prefix < limit && expected[prefix] === submitted[prefix]) prefix++;
  return {
    correct: expected.length === submitted.length && prefix === expected.length && prefix > 0,
    prefix,
    expectedLength: expected.length,
    submittedLength: submitted.length,
  };
}

export function loadProgress(storage) {
  const raw = storage.getItem(storageKey);
  if (raw === null) return [];
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries) || !entries.every((entry) =>
    entry && allowedIds.has(entry.id) && typeof entry.text === 'string' &&
    Number.isSafeInteger(entry.attempts) && entry.attempts >= 0 && typeof entry.completed === 'boolean'
  ) || new Set(entries.map(({ id }) => id)).size !== entries.length) throw new Error('Invalid memorization data');
  return entries;
}

export function saveProgress(storage, progress) {
  storage.setItem(storageKey, JSON.stringify(progress));
}
