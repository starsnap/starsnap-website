import { curriculum, gradeMajorTopic, gradeQuestion, loadProgress, normalize, saveProgress, storageKey } from './memorize.mjs';

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
const retry = byId('retry');
const submit = byId('submit');
const storageError = byId('storage-error');
const allEntries = Object.values(curriculum).flatMap((groups) => groups.flatMap(({ entries }) => entries));
const emptyProgress = { completed: false, attempts: 0 };
let progress = { entries: [], completedSeries: [] };
let majorMessage = '';
let selectedIndex = 0;

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
  if (!readProgress()) return false;
  const next = update(progress);
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

function showResult(title, detail, correct) {
  const heading = document.createElement('strong');
  const message = document.createElement('p');
  heading.textContent = title;
  message.textContent = detail;
  result.className = `result ${correct ? 'success' : 'retry'}`;
  result.replaceChildren(heading, message);
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
    showResult(correct ? title : '다시 연습해 보세요', saved ? detail : `${detail} 결과를 저장하지 못했습니다.`, correct);
    retry.hidden = false;
  } catch {
    if (questionIndex === selectedIndex) showResult('채점할 수 없습니다.', '페이지를 새로고침한 뒤 다시 시도해 주세요.', false);
  } finally {
    submit.disabled = false;
  }
});

retry.addEventListener('click', () => {
  resetAnswer();
  fields.topic.focus();
});
window.addEventListener('storage', (event) => {
  if (event.key === storageKey || event.key === null) {
    if (readProgress()) showStorageError('');
    render();
  }
});

readProgress();
render();
