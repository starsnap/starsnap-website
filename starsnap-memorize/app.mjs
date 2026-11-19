import { curriculum, grade, loadProgress, normalize, saveProgress, storageKey } from './memorize.mjs';

const byId = (id) => document.getElementById(id);
const answer = byId('answer');
const result = byId('result');
const retry = byId('retry');
const submit = byId('submit');
const storageError = byId('storage-error');
const allEntries = Object.values(curriculum).flatMap((groups) => groups.flatMap(({ entries }) => entries));
const emptyProgress = { completed: false, attempts: 0 };
let progress = [];
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

function select(index) {
  selectedIndex = index;
  resetAnswer();
  render();
  byId('question').focus();
}

function render() {
  const passed = progress.filter((entry) => entry.completed).length;
  byId('total').textContent = allEntries.length;
  byId('passed').textContent = passed;
  byId('pending').textContent = allEntries.length - passed;

  byId('passages').replaceChildren(...allEntries.map(renderQuestion));

  const saved = record(allEntries[selectedIndex].id);
  byId('question').textContent = `문제 ${selectedIndex + 1}`;
  byId('attempts').textContent = saved.attempts ? `입력 연습 ${saved.attempts}회` : '';
}

function renderQuestion(entry, index) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  const number = index + 1;
  const done = record(entry.id).completed;
  button.type = 'button';
  button.className = 'passage';
  button.textContent = number;
  button.setAttribute('aria-label', `문제 ${number}${done ? ', 암송 완료' : ''}`);
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

byId('practice-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  const questionIndex = selectedIndex;
  const verse = allEntries[questionIndex];
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
    if (questionIndex !== selectedIndex || submitted !== answer.value) return;
    const detail = correct ? '개역한글판 본문과 일치합니다.' : '개역한글판 본문과 다른 부분이 있습니다.';
    showResult(correct ? '암송 성공' : '다시 연습해 보세요', saved ? detail : `${detail} 결과를 저장하지 못했습니다.`, correct);
    retry.hidden = false;
  } catch {
    if (questionIndex === selectedIndex) showResult('채점할 수 없습니다.', '페이지를 새로고침한 뒤 다시 시도해 주세요.', false);
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
