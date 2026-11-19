import { curriculum, grade, loadProgress, normalize, saveProgress, storageKey } from './memorize.mjs';

const byId = (id) => document.getElementById(id);
const answer = byId('answer');
const original = byId('original');
const reveal = byId('reveal');
const editor = byId('editor');
const result = byId('result');
const retry = byId('retry');
const completed = byId('completed');
const storageError = byId('storage-error');
const seriesButtons = {};
const allEntries = Object.values(curriculum).flatMap((groups) => groups.flatMap(({ entries }) => entries));
const emptyProgress = { text: '', completed: false, attempts: 0 };
let progress = [];
let canWrite = true;
let series = 'A';
let selected = allEntries[0];

function showStorageError(message) {
  storageError.textContent = message;
  storageError.hidden = !message;
}

function readProgress() {
  try {
    progress = loadProgress(localStorage);
    canWrite = true;
    return true;
  } catch {
    canWrite = false;
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

function setOriginalVisible(visible) {
  original.hidden = !visible;
  reveal.textContent = visible ? '본문 숨기기' : '본문 보기';
  reveal.setAttribute('aria-expanded', String(visible));
}

function resetAnswer() {
  answer.value = '';
  result.replaceChildren();
  retry.hidden = true;
  setOriginalVisible(false);
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
  completed.checked = saved.completed;
  completed.disabled = !canWrite;
  byId('edit').disabled = !canWrite;
  byId('edit').textContent = saved.text ? '본문 수정' : '본문 등록';
  byId('written').hidden = !saved.text;
  byId('no-original').hidden = Boolean(saved.text);
  original.textContent = saved.text;
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
    const mark = document.createElement('input');
    mark.type = 'checkbox';
    mark.id = `check-${entry.id}`;
    mark.className = 'verse-mark';
    mark.checked = done;
    mark.disabled = !canWrite;
    mark.setAttribute('aria-label', `${entry.id} ${entry.reference} 암송 완료`);
    mark.addEventListener('change', () => {
      setCompleted(entry.id, mark.checked);
      byId(mark.id).focus({ preventScroll: true });
    });
    const markLabel = document.createElement('label');
    markLabel.className = 'verse-toggle';
    markLabel.append(mark);
    item.classList.toggle('selected', entry.id === selected.id);
    button.append(number, reference);
    button.addEventListener('click', () => select(entry, true));
    item.append(button, markLabel);
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

function setCompleted(id, checked) {
  persist(id, (entry) => ({ ...entry, completed: checked }));
  render();
}

completed.addEventListener('change', () => setCompleted(selected.id, completed.checked));

byId('edit').addEventListener('click', () => {
  const { text } = record(selected.id);
  byId('editor-title').textContent = text ? '본문 수정' : '본문 등록';
  byId('editor-reference').textContent = selected.reference;
  byId('edit-original').value = text;
  byId('editor-hint').hidden = !text;
  byId('editor-error').textContent = '';
  editor.showModal();
  byId('edit-original').focus();
});

byId('editor-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = byId('edit-original').value.trim();
  if ((text && !normalize(text)) || (!text && !record(selected.id).text)) {
    byId('editor-error').textContent = '외울 말씀을 입력해 주세요.';
    return;
  }
  if (!persist(selected.id, (entry) => ({ ...entry, text }))) {
    byId('editor-error').textContent = '본문을 저장하지 못했습니다.';
    return;
  }
  editor.close();
  resetAnswer();
  render();
  if (text) answer.focus();
});

function showResult(title, detail, correct) {
  const heading = document.createElement('strong');
  const message = document.createElement('p');
  heading.textContent = title;
  message.textContent = detail;
  result.className = `result ${correct ? 'success' : 'retry'}`;
  result.replaceChildren(heading, message);
}

byId('practice-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!readProgress()) return;
  const { text } = record(selected.id);
  if (!text) return render();
  const score = grade(text, answer.value);
  if (!score.submittedLength) {
    showResult('암송 내용을 입력해 주세요.', '입력한 내용에 채점할 글자가 없습니다.', false);
    return;
  }
  const saved = persist(selected.id, (entry) => ({
    ...entry, attempts: entry.attempts + 1, completed: entry.completed || score.correct,
  }));
  render();
  const detail = score.correct ? '등록한 말씀과 모두 일치합니다.' :
    `앞에서부터 ${score.prefix}글자가 일치합니다. 본문을 확인하거나 다시 입력해 보세요.`;
  showResult(score.correct ? '암송 성공' : '다시 연습해 보세요', saved ? detail : `${detail} 이 결과는 저장되지 않았습니다.`, score.correct);
  retry.hidden = false;
});

reveal.addEventListener('click', () => setOriginalVisible(original.hidden));
retry.addEventListener('click', () => {
  resetAnswer();
  answer.focus();
});
editor.querySelector('[data-close]').addEventListener('click', () => editor.close());
window.addEventListener('storage', (event) => {
  if (event.key === storageKey || event.key === null) {
    if (readProgress()) showStorageError('');
    render();
  }
});

readProgress();
render();
