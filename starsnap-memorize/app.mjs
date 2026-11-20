import { curriculum, gradeMajorTopic, gradeQuestion, loadProgress, normalize, resetSeriesProgress, saveProgress, storageKey } from './memorize.mjs?v=15';

const byId = (id) => document.getElementById(id);
const fields = {
  topic: byId('topic-answer'),
  book: byId('book-answer'),
  chapter: byId('chapter-answer'),
  startVerse: byId('verse-start-answer'),
  endVerse: byId('verse-end-answer'),
  text: byId('answer'),
};
const fieldLabels = { topic: '소주제', reference: '장절', text: '암송 내용' };
const majorForm = byId('major-topic-form');
const majorInput = byId('major-topic');
const majorStatus = byId('major-topic-status');
const result = byId('result');
const mistakeReview = byId('mistake-review');
const showMistakes = byId('show-mistakes');
const reviewAnswer = byId('review-answer');
const retry = byId('retry');
const submit = byId('submit');
const resetProgressButtons = document.querySelectorAll('[data-reset-scope]');
const resetProgressDialog = byId('reset-progress-dialog');
const storageError = byId('storage-error');
const allEntries = Object.values(curriculum).flatMap((groups) => groups.flatMap(({ entries }) => entries));
const emptyProgress = { completed: false, attempts: 0 };
let progress = { entries: [], completedSeries: [] };
let majorMessage = '';
let selectedIndex = 0;
let resetScope = 'all';

function showStorageError(message) {
  storageError.textContent = message;
  storageError.hidden = !message;
}

function readProgress() {
  try {
    progress = loadProgress(localStorage);
    return true;
  } catch {
    showStorageError('완료 기록을 읽을 수 없습니다. 브라우저 저장 공간을 확인해 주세요.');
    return false;
  }
}

function record(id) {
  return progress.entries.find((entry) => entry.id === id) ?? emptyProgress;
}

function hasMajorTopic(series) {
  return progress.completedSeries.includes(series);
}

function isComplete(entry) {
  return hasMajorTopic(entry.series) && record(entry.id).completed;
}

function persist(update) {
  return readProgress() && storeProgress(update(progress));
}

function storeProgress(next) {
  try {
    saveProgress(localStorage, next);
    progress = next;
    showStorageError('');
    return true;
  } catch {
    showStorageError('변경을 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.');
    return false;
  }
}

function resetAnswer() {
  for (const field of Object.values(fields)) field.value = '';
  result.replaceChildren();
  clearMistakeReview();
  retry.hidden = true;
}

function select(index) {
  if (allEntries[index].series !== allEntries[selectedIndex].series) {
    majorInput.value = '';
    majorMessage = '';
  }
  selectedIndex = index;
  resetAnswer();
  render();
  byId('question').focus();
}

function render() {
  const passed = allEntries.filter(isComplete).length;
  byId('total').textContent = allEntries.length;
  byId('passed').textContent = passed;
  byId('pending').textContent = allEntries.length - passed;

  for (const series of Object.keys(curriculum)) {
    const buttons = allEntries.flatMap((entry, index) => entry.series === series ? [renderQuestion(entry, index)] : []);
    byId(`passages-${series}`).replaceChildren(...buttons);
  }

  const verse = allEntries[selectedIndex];
  const saved = record(verse.id);
  byId('question').textContent = verse.id;
  byId('attempts').textContent = saved.attempts ? `입력 연습 ${saved.attempts}회` : '';
  const majorComplete = hasMajorTopic(verse.series);
  majorForm.hidden = majorComplete;
  majorStatus.textContent = majorComplete ? '대주제 확인 완료' : majorMessage;
}

function renderQuestion(entry, index) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  const done = isComplete(entry);
  button.type = 'button';
  button.className = 'passage';
  button.textContent = entry.id;
  button.setAttribute('aria-label', done ? `${entry.id}, 암송 완료` : entry.id);
  if (index === selectedIndex) button.setAttribute('aria-current', 'true');
  if (done) {
    const mark = document.createElement('span');
    mark.className = 'completion-mark';
    mark.textContent = '✓';
    mark.setAttribute('aria-hidden', 'true');
    button.append(mark);
  }
  button.addEventListener('click', () => select(index));
  item.append(button);
  return item;
}

function clearMistakeReview() {
  showMistakes.onchange = null;
  showMistakes.checked = false;
  reviewAnswer.hidden = true;
  reviewAnswer.replaceChildren();
  mistakeReview.hidden = true;
}

function renderMistakes(text, corrections) {
  const heading = document.createElement('p');
  heading.className = 'review-heading';
  heading.textContent = '입력한 표현 → 고칠 표현';
  const comparisons = document.createElement('ul');
  comparisons.className = 'review-comparisons';
  const preview = document.createElement('p');
  preview.className = 'review-input';
  let offset = 0;
  for (const { start, end, correct } of corrections) {
    const row = document.createElement('li');
    const written = document.createElement('span');
    const arrow = document.createElement('span');
    const suggestion = document.createElement('strong');
    written.textContent = text.slice(start, end) || '입력에서 빠짐';
    arrow.textContent = '→';
    suggestion.textContent = correct === '' ? '지우기' : correct ?? '본문 다시 확인';
    row.append(written, arrow, suggestion);
    comparisons.append(row);

    if (end > offset && end > start) {
      const from = Math.max(offset, start);
      const mark = document.createElement('mark');
      mark.textContent = text.slice(from, end);
      preview.append(text.slice(offset, from), mark);
      offset = end;
    }
  }
  preview.append(text.slice(offset));
  reviewAnswer.replaceChildren(heading, comparisons, preview);
}

function showMistakeReview({ id, text }) {
  mistakeReview.hidden = false;
  let request;
  const toggle = async () => {
    reviewAnswer.hidden = !showMistakes.checked;
    if (reviewAnswer.hidden) return;
    reviewAnswer.textContent = '틀린 부분을 확인하는 중입니다.';
    try {
      request ??= fetch('/practice-review?v=2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, text }),
      }).then(response => {
        if (!response.ok) throw new Error('Review unavailable');
        return response.json();
      });
      const corrections = await request;
      if (showMistakes.onchange !== toggle || !showMistakes.checked) return;
      renderMistakes(text, corrections);
    } catch {
      request = undefined;
      if (showMistakes.onchange !== toggle || !showMistakes.checked) return;
      reviewAnswer.textContent = '틀린 부분을 불러오지 못했습니다. 체크를 해제한 뒤 다시 선택해 주세요.';
    }
    mistakeReview.scrollIntoView({ block: 'start' });
  };
  showMistakes.onchange = toggle;
}

function showResult(title, detail, correct, mistake) {
  const heading = document.createElement('strong');
  const message = document.createElement('p');
  heading.textContent = title;
  message.textContent = detail;
  result.className = `result ${correct ? 'success' : 'retry'}`;
  result.replaceChildren(heading, message);
  clearMistakeReview();
  if (mistake) showMistakeReview(mistake);
  (mistake ? mistakeReview : result).scrollIntoView({ block: 'nearest' });
}

majorForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const { series } = allEntries[selectedIndex];
  if (!gradeMajorTopic(series, majorInput.value)) {
    majorMessage = '대주제를 다시 확인해 주세요.';
    render();
    return;
  }

  const saved = persist(current => ({
    ...current,
    completedSeries: [...new Set([...current.completedSeries, series])],
  }));
  majorMessage = saved ? '' : '대주제는 맞았지만 완료 상태를 저장하지 못했습니다.';
  if (saved) majorInput.value = '';
  render();
  if (saved) fields.topic.focus();
});

for (const field of [fields.chapter, fields.startVerse, fields.endVerse]) {
  field.addEventListener('input', () => {
    const digits = field.value.normalize('NFKC').replace(/[^0-9]/g, '');
    if (field.value !== digits) field.value = digits;
  });
}

fields.text.addEventListener('input', clearMistakeReview);

byId('practice-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  const questionIndex = selectedIndex;
  const verse = allEntries[questionIndex];
  const submitted = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]));
  if (Object.entries(fields).some(([key, field]) => field.required && !normalize(submitted[key]))) {
    showResult('세 항목을 모두 입력해 주세요.', '소주제, 장절, 암송 내용을 채점합니다.', false);
    return;
  }
  submit.disabled = true;
  for (const button of resetProgressButtons) button.disabled = true;
  try {
    const scores = await gradeQuestion(verse, submitted);
    const correct = Object.values(scores).every(Boolean);
    const saved = persist(current => {
      const previous = record(verse.id);
      const entry = { id: verse.id, attempts: previous.attempts + 1, completed: previous.completed || correct };
      return { ...current, entries: [...current.entries.filter(item => item.id !== verse.id), entry] };
    });
    render();
    if (questionIndex !== selectedIndex || Object.keys(fields).some(key => fields[key].value !== submitted[key])) return;
    const detail = Object.entries(scores).map(([key, match]) => `${fieldLabels[key]} ${match ? '일치' : '다시 확인'}`).join(' · ');
    const title = correct && hasMajorTopic(verse.series) ? '암송 성공' : '구절 채점 완료';
    retry.hidden = false;
    showResult(correct ? title : '다시 연습해 보세요', saved ? detail : `${detail} 결과를 저장하지 못했습니다.`, correct,
      scores.text ? undefined : { id: verse.id, text: submitted.text });
  } catch {
    if (questionIndex === selectedIndex) showResult('채점할 수 없습니다.', '페이지를 새로고침한 뒤 다시 시도해 주세요.', false);
  } finally {
    submit.disabled = false;
    for (const button of resetProgressButtons) button.disabled = false;
  }
});

retry.addEventListener('click', () => {
  resetAnswer();
  fields.topic.focus();
});
for (const button of resetProgressButtons) {
  button.addEventListener('click', () => {
    resetScope = button.dataset.resetScope;
    const label = resetScope === 'all' ? '전체' : `${resetScope} 시리즈`;
    byId('reset-progress-title').textContent = `${label} 기록을 초기화할까요?`;
    byId('reset-progress-description').textContent = `이 브라우저의 ${label} 대주제 확인, 구절 완료 표시, 연습 횟수를 지웁니다.`;
    resetProgressDialog.returnValue = '';
    resetProgressDialog.showModal();
  });
}
resetProgressDialog.addEventListener('close', () => {
  if (resetProgressDialog.returnValue !== 'reset') return;
  const all = resetScope === 'all';
  const saved = all
    ? storeProgress({ entries: [], completedSeries: [] })
    : persist(current => resetSeriesProgress(current, resetScope));
  if (!saved) return;
  if (!all && allEntries[selectedIndex].series !== resetScope) {
    render();
    return;
  }
  majorInput.value = '';
  majorMessage = '';
  select(all ? 0 : allEntries.findIndex(entry => entry.series === resetScope));
});
window.addEventListener('storage', (event) => {
  if (event.key === storageKey || event.key === null) {
    if (readProgress()) showStorageError('');
    render();
  }
});

readProgress();
render();
