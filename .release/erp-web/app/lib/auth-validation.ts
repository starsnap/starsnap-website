export interface AuthValidationResult<T> {
  ok: true;
  value: T;
}

export interface AuthValidationFailure {
  ok: false;
  message: string;
}

export type AuthParseResult<T> = AuthValidationResult<T> | AuthValidationFailure;

const usernamePattern = /^[A-Za-z0-9]{4,12}$/;
const passwordPattern = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[~\u2024!@#$%^&*()_\-+=|\\;:\u2018\u201C<>,.?/]).{8,50}$/;
const emailPattern = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;
const controlCharacterPattern = /[\u0000-\u001F\u007F]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : '';
}

export function normalizeUsername(value: unknown) {
  const username = typeof value === 'string' ? value : '';
  return usernamePattern.test(username) ? username.toLowerCase() : null;
}

export function parseUsername(value: unknown): AuthParseResult<{ username: string; normalizedUsername: string }> {
  const username = typeof value === 'string' ? value : '';
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) {
    return { ok: false, message: '아이디는 4~12자의 영문과 숫자만 사용할 수 있습니다.' };
  }
  return { ok: true, value: { username, normalizedUsername } };
}

export function normalizeEmail(value: unknown) {
  const email = text(value).toLowerCase();
  return email.length <= 254
    && !email.startsWith('.')
    && !email.includes('..')
    && !controlCharacterPattern.test(email)
    && emailPattern.test(email)
    ? email
    : null;
}

export function parsePassword(value: unknown): AuthParseResult<string> {
  if (typeof value !== 'string' || !passwordPattern.test(value)) {
    return { ok: false, message: '영문 대소문자, 숫자, 특수문자를 포함하여 8~50자로 입력해 주세요.' };
  }
  return { ok: true, value };
}

export function parseCompanyName(value: unknown): AuthParseResult<string> {
  const companyName = text(value).replace(/\s+/g, ' ');
  if (companyName.length < 2 || companyName.length > 80 || controlCharacterPattern.test(companyName)) {
    return { ok: false, message: '업체명은 2~80자로 입력해 주세요.' };
  }
  return { ok: true, value: companyName };
}

export function parseUsernameCheck(value: unknown) {
  if (!isRecord(value)) return { ok: false, message: '요청 형식이 올바르지 않습니다.' } satisfies AuthValidationFailure;
  return parseUsername(value.username);
}

export function parseEmailRequest(value: unknown): AuthParseResult<{ email: string }> {
  if (!isRecord(value)) return { ok: false, message: '요청 형식이 올바르지 않습니다.' };
  const email = normalizeEmail(value.email);
  return email
    ? { ok: true, value: { email } }
    : { ok: false, message: '올바른 이메일 주소를 입력해 주세요.' };
}

export function parseEmailCodeRequest(value: unknown): AuthParseResult<{
  challengeId: string;
  email: string;
  code: string;
}> {
  if (!isRecord(value)) return { ok: false, message: '요청 형식이 올바르지 않습니다.' };
  const email = normalizeEmail(value.email);
  const challengeId = text(value.challengeId);
  const code = text(value.code);
  if (!email || !/^[0-9]{6}$/.test(code) || !/^[0-9a-f-]{36}$/i.test(challengeId)) {
    return { ok: false, message: '이메일과 6자리 인증코드를 확인해 주세요.' };
  }
  return { ok: true, value: { challengeId, email, code } };
}

export function parseLoginRequest(value: unknown): AuthParseResult<{
  username: string;
  normalizedUsername: string;
  password: string;
}> {
  if (!isRecord(value)) return { ok: false, message: '요청 형식이 올바르지 않습니다.' };
  const username = parseUsername(value.username);
  if (!username.ok) return username;
  if (typeof value.password !== 'string' || value.password.length < 1 || value.password.length > 72) {
    return { ok: false, message: '아이디 또는 비밀번호를 확인해 주세요.' };
  }
  return { ok: true, value: { ...username.value, password: value.password } };
}

export function parseSignupRequest(value: unknown): AuthParseResult<{
  username: string;
  normalizedUsername: string;
  password: string;
  email: string;
  companyName: string;
  verificationToken: string;
}> {
  if (!isRecord(value)) return { ok: false, message: '요청 형식이 올바르지 않습니다.' };
  const username = parseUsername(value.username);
  if (!username.ok) return username;
  const password = parsePassword(value.password);
  if (!password.ok) return password;
  const email = normalizeEmail(value.email);
  if (!email) return { ok: false, message: '올바른 이메일 주소를 입력해 주세요.' };
  const companyName = parseCompanyName(value.companyName);
  if (!companyName.ok) return companyName;
  const verificationToken = text(value.verificationToken);
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(verificationToken)) {
    return { ok: false, message: '이메일 인증을 먼저 완료해 주세요.' };
  }
  return {
    ok: true,
    value: {
      ...username.value,
      password: password.value,
      email,
      companyName: companyName.value,
      verificationToken,
    },
  };
}
