import { curriculum, grade, loadProgress, normalize, saveProgress, storageKey } from './memorize.mjs';

const byId = (id) => document.getElementById(id);
const answer = byId('answer');
const result = byId('result');
const retry = byId('retry');
const submit = byId('submit');
const storageError = byId('storage-error');
const seriesButtons = {};
const allEntries = Object.values(curriculum).flatMap((groups) => groups.flatMap(({ entries }) => entries));
const emptyProgress = { completed: false, attempts: 0 };
let progress = [];
let series = 'A';
let selected = allEntries[0];

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
  return progress.find((entry) => entry.id === id) ?? emptyProgress;
}

function persist(id, update) {
  if (!readProgress()) return false;
  const entry = { ...update(record(id)), id };
  const next = [...progress.filter((item) => item.id !== id), entry];
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
  answer.value = '';
  result.replaceChildren();
  retry.hidden = true;
}

function select(entry, focus = false) {
  selected = entry;
  resetAnswer();
  render();
  if (focus) byId('reference').focus();
}

function render() {
  const passed = progress.filter((entry) => entry.completed).length;
  byId('total').textContent = allEntries.length;
  byId('passed').textContent = passed;
  byId('pending').textContent = allEntries.length - passed;

  for (const [label, button] of Object.entries(seriesButtons)) {
    const seriesProgress = progress.filter((entry) => entry.completed && entry.id.startsWith(`${label}-`)).length;
    button.textContent = `${label} 시리즈 · ${seriesProgress}/12`;
    button.setAttribute('aria-pressed', String(label === series));
  }
  byId('passages').replaceChildren(...curriculum[series].map(renderTopic));

  const saved = record(selected.id);
  byId('topic').textContent = `${selected.id} · ${selected.topic}`;
  byId('reference').textContent = selected.reference;
  byId('attempts').textContent = saved.attempts ? `입력 연습 ${saved.attempts}회` : '';
}

function renderTopic({ topic, entries }) {
  const group = document.createElement('section');
  group.className = 'verse-group';
  const title = document.createElement('h3');
  title.textContent = topic;
  const list = document.createElement('ul');
  list.className = 'passages';
  for (const entry of entries) {
    const item = document.createElement('li');
    item.className = 'passage-row';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'passage';
    if (entry.id === selected.id) button.setAttribute('aria-current', 'true');
    const done = record(entry.id).completed;
    button.setAttribute('aria-label', `${entry.id} ${entry.reference}${done ? ', 암송 완료' : ''}`);
    const number = document.createElement('span');
    number.className = 'verse-number';
    number.textContent = entry.id;
    const reference = document.createElement('span');
    reference.className = 'passage-title';
    reference.textContent = entry.reference;
    const mark = document.createElement('span');
    mark.className = 'verse-mark';
    mark.textContent = done ? '✓' : '';
    mark.setAttribute('aria-hidden', 'true');
    item.classList.toggle('selected', entry.id === selected.id);
    button.append(number, reference, mark);
    button.addEventListener('click', () => select(entry, true));
    item.append(button);
    list.append(item);
  }
  group.append(title, list);
  return group;
}

for (const [label, groups] of Object.entries(curriculum)) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'series-button';
  button.addEventListener('click', () => {
    if (series === label) return;
    series = label;
    select(groups[0].entries[0]);
  });
  seriesButtons[label] = button;
  byId('series').append(button);
}

function showResult(title, detail, correct) {
  const heading = document.createElement('strong');
  const message = document.createElement('p');
  heading.textContent = title;
  message.textContent = detail;
  result.className = `result ${correct ? 'success' : 'retry'}`;
  result.replaceChildren(heading, message);
}

byId('practice-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  const verse = selected;
  const submitted = answer.value;
  if (!normalize(submitted)) {
    showResult('암송 내용을 입력해 주세요.', '입력한 내용에 채점할 글자가 없습니다.', false);
    return;
  }
  submit.disabled = true;
  try {
    const correct = await grade(verse.reference, submitted);
    const saved = persist(verse.id, (entry) => ({
      attempts: entry.attempts + 1,
      completed: entry.completed || correct,
    }));
    render();
    if (verse !== selected || submitted !== answer.value) return;
    const detail = correct ? '개역한글판 본문과 일치합니다.' : '개역한글판 본문과 다른 부분이 있습니다.';
    showResult(correct ? '암송 성공' : '다시 연습해 보세요', saved ? detail : `${detail} 결과를 저장하지 못했습니다.`, correct);
    retry.hidden = false;
  } catch {
    if (verse === selected) showResult('채점할 수 없습니다.', '페이지를 새로고침한 뒤 다시 시도해 주세요.', false);
  } finally {
    submit.disabled = false;
  }
});

retry.addEventListener('click', () => {
  resetAnswer();
  answer.focus();
});
window.addEventListener('storage', (event) => {
  if (event.key === storageKey || event.key === null) {
    if (readProgress()) showStorageError('');
    render();
  }
});

readProgress();
render();
