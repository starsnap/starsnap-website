'use client';

import { Eye, EyeOff, KeyRound, Mail, ShieldCheck } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react';
import type { AuthSession } from '../lib/auth-types';
import { StarSnapBrandIcon } from './starsnap-brand-icon';
import {
  normalizeEmail,
  parseCompanyName,
  parsePassword,
  parseUsername,
} from '../lib/auth-validation';
import { NoticeModal } from './notice-modal';

type AuthMode = 'login' | 'signup';
type PendingAction = 'login' | 'signup' | 'username' | 'send-code' | 'verify-code' | null;
type FieldName = 'username' | 'password' | 'passwordConfirmation' | 'email' | 'emailCode' | 'companyName';
type FieldErrors = Partial<Record<FieldName, string>>;

interface AuthScreenProps {
  initialNotice?: string | null;
  onAuthenticated: (session: AuthSession) => void;
}

interface UsernameCheckState {
  normalizedUsername: string | null;
  status: 'idle' | 'available' | 'unavailable';
  message: string;
}

interface EmailChallenge {
  challengeId: string;
  email: string;
  expiresAt: string;
  localInboxUrl?: string;
}

interface VerifiedEmail {
  email: string;
  verificationToken: string;
}

interface NoticeState {
  title: string;
  message: string;
  tone: 'success' | 'error' | 'info';
}

class ApiResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'ApiResponseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAuthenticatedSession(value: unknown): AuthSession | null {
  if (!isRecord(value) || value.authenticated !== true || !isRecord(value.user)) return null;
  if (
    typeof value.user.id !== 'string'
    || typeof value.user.username !== 'string'
    || typeof value.user.email !== 'string'
    || typeof value.expiresAt !== 'string'
    || !Array.isArray(value.memberships)
    || value.memberships.length === 0
  ) return null;

  const validMemberships = value.memberships.every((membership) => (
    isRecord(membership)
    && ['viewer', 'operator', 'admin'].includes(String(membership.role))
    && isRecord(membership.tenant)
    && typeof membership.tenant.id === 'string'
    && typeof membership.tenant.code === 'string'
    && typeof membership.tenant.name === 'string'
    && typeof membership.tenant.brandColor === 'string'
    && ['BRAND', 'DEALER', 'BIDDER'].includes(String(membership.tenant.organizationType))
  ));
  return validMemberships ? value as unknown as AuthSession : null;
}

async function decodeResponse(response: Response) {
  const decoded: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isRecord(decoded) && typeof decoded.message === 'string'
      ? decoded.message
      : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
    const code = isRecord(decoded) && typeof decoded.code === 'string' ? decoded.code : null;
    throw new ApiResponseError(message, response.status, code);
  }
  if (!isRecord(decoded)) throw new Error('서버 응답 형식이 올바르지 않습니다.');
  return decoded;
}

async function postJson(path: string, body: Record<string, unknown>) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return decodeResponse(response);
}

function formatExpiry(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '잠시 후';
  return new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function safeInboxUrl(value: string | undefined) {
  if (!value) return null;
  if (value.startsWith('/') || /^https?:\/\//i.test(value)) return value;
  return null;
}

const idleUsernameCheck: UsernameCheckState = {
  normalizedUsername: null,
  status: 'idle',
  message: '',
};

export function AuthScreen({ initialNotice = null, onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showPasswordConfirmation, setShowPasswordConfirmation] = useState(false);
  const [email, setEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [usernameCheck, setUsernameCheck] = useState<UsernameCheckState>(idleUsernameCheck);
  const [emailChallenge, setEmailChallenge] = useState<EmailChallenge | null>(null);
  const [verifiedEmail, setVerifiedEmail] = useState<VerifiedEmail | null>(null);
  const [emailStatus, setEmailStatus] = useState('');
  const [notice, setNotice] = useState<NoticeState | null>(initialNotice ? {
    title: '로그인 안내',
    message: initialNotice,
    tone: 'info',
  } : null);

  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const passwordConfirmationRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const emailCodeRef = useRef<HTMLInputElement>(null);
  const companyNameRef = useRef<HTMLInputElement>(null);
  const focusTakenEmailAfterRequestRef = useRef(false);

  useEffect(() => {
    if (pendingAction !== null || !focusTakenEmailAfterRequestRef.current) return;
    focusTakenEmailAfterRequestRef.current = false;
    emailRef.current?.focus();
  }, [pendingAction]);

  const busy = pendingAction !== null;
  const localInboxUrl = safeInboxUrl(emailChallenge?.localInboxUrl);
  const parsedSignupUsername = parseUsername(username);
  const parsedSignupPassword = parsePassword(password);
  const normalizedSignupEmail = normalizeEmail(email);
  const parsedSignupCompanyName = parseCompanyName(companyName);
  const signupReady = parsedSignupUsername.ok
    && usernameCheck.status === 'available'
    && usernameCheck.normalizedUsername === parsedSignupUsername.value.normalizedUsername
    && parsedSignupPassword.ok
    && passwordConfirmation.length > 0
    && password === passwordConfirmation
    && Boolean(normalizedSignupEmail)
    && verifiedEmail?.email === normalizedSignupEmail
    && Boolean(verifiedEmail?.verificationToken)
    && parsedSignupCompanyName.ok;

  const clearFieldError = (field: FieldName) => {
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  };

  const focusFirstError = (errors: FieldErrors) => {
    const refs: Array<[FieldName, RefObject<HTMLInputElement | null>]> = [
      ['username', usernameRef],
      ['password', passwordRef],
      ['passwordConfirmation', passwordConfirmationRef],
      ['email', emailRef],
      ['emailCode', emailCodeRef],
      ['companyName', companyNameRef],
    ];
    const target = refs.find(([field]) => Boolean(errors[field]))?.[1];
    window.requestAnimationFrame(() => target?.current?.focus());
  };

  const applyFieldErrors = (errors: FieldErrors) => {
    setFieldErrors(errors);
    focusFirstError(errors);
  };

  const changeMode = (nextMode: AuthMode) => {
    if (busy || nextMode === mode) return;
    setMode(nextMode);
    setPassword('');
    setPasswordConfirmation('');
    setShowPassword(false);
    setShowPasswordConfirmation(false);
    setFieldErrors({});
    setNotice(null);
    window.requestAnimationFrame(() => usernameRef.current?.focus());
  };

  const handleUsernameChange = (value: string) => {
    setUsername(value);
    setUsernameCheck(idleUsernameCheck);
    clearFieldError('username');
  };

  const handleEmailChange = (value: string) => {
    setEmail(value);
    setEmailCode('');
    setEmailChallenge(null);
    setVerifiedEmail(null);
    setEmailStatus('');
    clearFieldError('email');
    clearFieldError('emailCode');
  };

  const handleTakenEmail = (message: string) => {
    setEmailCode('');
    setEmailChallenge(null);
    setVerifiedEmail(null);
    setEmailStatus('');
    setFieldErrors((current) => ({ ...current, email: message, emailCode: undefined }));
    focusTakenEmailAfterRequestRef.current = true;
  };

  const checkUsername = async () => {
    const parsed = parseUsername(username);
    if (!parsed.ok) {
      setUsernameCheck({ normalizedUsername: null, status: 'unavailable', message: parsed.message });
      applyFieldErrors({ ...fieldErrors, username: parsed.message });
      return;
    }

    setPendingAction('username');
    setFieldErrors((current) => ({ ...current, username: undefined }));
    setUsernameCheck({
      normalizedUsername: parsed.value.normalizedUsername,
      status: 'idle',
      message: '아이디 중복을 확인하고 있습니다.',
    });
    try {
      const result = await postJson('/api/auth/username/check', { username: parsed.value.username });
      if (typeof result.available !== 'boolean') throw new Error('아이디 확인 응답이 올바르지 않습니다.');
      const available = result.available;
      setUsernameCheck({
        normalizedUsername: parsed.value.normalizedUsername,
        status: available ? 'available' : 'unavailable',
        message: typeof result.message === 'string'
          ? result.message
          : available ? '사용할 수 있는 아이디입니다.' : '이미 사용 중인 아이디입니다.',
      });
      if (!available) {
        setFieldErrors((current) => ({ ...current, username: '다른 아이디를 입력해 주세요.' }));
        window.requestAnimationFrame(() => usernameRef.current?.focus());
      }
    } catch (error) {
      setUsernameCheck(idleUsernameCheck);
      setNotice({
        title: '아이디 확인 실패',
        message: error instanceof Error ? error.message : '아이디 중복을 확인하지 못했습니다.',
        tone: 'error',
      });
    } finally {
      setPendingAction(null);
    }
  };

  const sendEmailCode = async () => {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      applyFieldErrors({ ...fieldErrors, email: '올바른 이메일 주소를 입력해 주세요.' });
      return;
    }

    setPendingAction('send-code');
    setFieldErrors((current) => ({ ...current, email: undefined, emailCode: undefined }));
    setEmailStatus('이메일 중복 확인 후 인증코드를 보내고 있습니다.');
    try {
      const result = await postJson('/api/auth/email/send-code', { email: normalizedEmail });
      if (typeof result.challengeId !== 'string' || typeof result.expiresAt !== 'string') {
        throw new Error('이메일 인증 응답이 올바르지 않습니다.');
      }
      setEmailChallenge({
        challengeId: result.challengeId,
        email: normalizedEmail,
        expiresAt: result.expiresAt,
        localInboxUrl: typeof result.localInboxUrl === 'string' ? result.localInboxUrl : undefined,
      });
      setVerifiedEmail(null);
      setEmailCode('');
      const deliveryMessage = typeof result.message === 'string'
        ? result.message
        : '인증코드를 보냈습니다.';
      setEmailStatus(`${deliveryMessage} ${formatExpiry(result.expiresAt)}까지 입력해 주세요.`);
      window.requestAnimationFrame(() => emailCodeRef.current?.focus());
    } catch (error) {
      if (error instanceof ApiResponseError && error.code === 'EMAIL_TAKEN') {
        handleTakenEmail(error.message);
        return;
      }
      setEmailStatus('');
      setNotice({
        title: '인증코드 전송 실패',
        message: error instanceof Error ? error.message : '인증코드를 보내지 못했습니다.',
        tone: 'error',
      });
    } finally {
      setPendingAction(null);
    }
  };

  const verifyEmailCode = async () => {
    const normalizedEmail = normalizeEmail(email);
    if (!emailChallenge || !normalizedEmail || emailChallenge.email !== normalizedEmail) {
      applyFieldErrors({ ...fieldErrors, email: '현재 이메일로 인증코드를 다시 받아 주세요.' });
      return;
    }
    if (!/^[0-9]{6}$/.test(emailCode)) {
      applyFieldErrors({ ...fieldErrors, emailCode: '6자리 인증코드를 입력해 주세요.' });
      return;
    }

    setPendingAction('verify-code');
    setFieldErrors((current) => ({ ...current, emailCode: undefined }));
    setEmailStatus('인증코드를 확인하고 있습니다.');
    try {
      const result = await postJson('/api/auth/email/verify-code', {
        challengeId: emailChallenge.challengeId,
        email: normalizedEmail,
        code: emailCode,
      });
      if (typeof result.verificationToken !== 'string') throw new Error('이메일 인증 응답이 올바르지 않습니다.');
      setVerifiedEmail({ email: normalizedEmail, verificationToken: result.verificationToken });
      setEmailStatus('이메일 인증이 완료되었습니다.');
    } catch (error) {
      setEmailStatus('');
      setNotice({
        title: '이메일 인증 실패',
        message: error instanceof Error ? error.message : '인증코드를 확인하지 못했습니다.',
        tone: 'error',
      });
    } finally {
      setPendingAction(null);
    }
  };

  const submitLogin = async () => {
    const parsedUsername = parseUsername(username);
    const errors: FieldErrors = {};
    if (!parsedUsername.ok) errors.username = parsedUsername.message;
    if (!password) errors.password = '비밀번호를 입력해 주세요.';
    if (Object.keys(errors).length > 0) {
      applyFieldErrors(errors);
      return;
    }

    setPendingAction('login');
    setFieldErrors({});
    try {
      const result = await postJson('/api/auth/login', { username, password });
      const session = parseAuthenticatedSession(result);
      if (!session) throw new Error('로그인 세션 응답이 올바르지 않습니다.');
      onAuthenticated(session);
    } catch (error) {
      setNotice({
        title: '로그인 실패',
        message: error instanceof Error ? error.message : '로그인하지 못했습니다.',
        tone: 'error',
      });
    } finally {
      setPendingAction(null);
    }
  };

  const submitSignup = async () => {
    const parsedUsername = parseUsername(username);
    const parsedPassword = parsePassword(password);
    const normalizedEmail = normalizeEmail(email);
    const parsedCompanyName = parseCompanyName(companyName);
    const errors: FieldErrors = {};

    if (!parsedUsername.ok) errors.username = parsedUsername.message;
    else if (
      usernameCheck.status !== 'available'
      || usernameCheck.normalizedUsername !== parsedUsername.value.normalizedUsername
    ) errors.username = '아이디 중복 확인을 완료해 주세요.';
    if (!parsedPassword.ok) errors.password = parsedPassword.message;
    if (!passwordConfirmation) errors.passwordConfirmation = '비밀번호 확인을 입력해 주세요.';
    else if (password !== passwordConfirmation) errors.passwordConfirmation = '비밀번호가 일치하지 않습니다.';
    if (!normalizedEmail) errors.email = '올바른 이메일 주소를 입력해 주세요.';
    else if (!verifiedEmail || verifiedEmail.email !== normalizedEmail) errors.emailCode = '이메일 인증을 완료해 주세요.';
    if (!parsedCompanyName.ok) errors.companyName = parsedCompanyName.message;

    if (Object.keys(errors).length > 0) {
      applyFieldErrors(errors);
      return;
    }

    setPendingAction('signup');
    setFieldErrors({});
    try {
      const result = await postJson('/api/auth/signup', {
        username,
        password,
        email: normalizedEmail,
        companyName: parsedCompanyName.ok ? parsedCompanyName.value : companyName,
        verificationToken: verifiedEmail?.verificationToken,
      });
      const session = parseAuthenticatedSession(result);
      if (!session) throw new Error('회원가입 세션 응답이 올바르지 않습니다.');
      onAuthenticated(session);
    } catch (error) {
      if (error instanceof ApiResponseError && error.code === 'EMAIL_TAKEN') {
        handleTakenEmail(error.message);
        return;
      }
      setNotice({
        title: '회원가입 실패',
        message: error instanceof Error ? error.message : '회원가입을 완료하지 못했습니다.',
        tone: 'error',
      });
    } finally {
      setPendingAction(null);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (mode === 'login') void submitLogin();
    else void submitSignup();
  };

  const usernameFeedback = fieldErrors.username ?? usernameCheck.message;
  const usernameFeedbackTone = fieldErrors.username || usernameCheck.status === 'unavailable'
    ? 'text-[var(--ss-danger)]'
    : usernameCheck.status === 'available'
      ? 'text-[var(--ss-success)]'
      : 'text-[var(--ss-text-muted)]';
  const emailFeedbackTone = fieldErrors.email || fieldErrors.emailCode
    ? 'text-[var(--ss-danger)]'
    : verifiedEmail
      ? 'text-[var(--ss-success)]'
      : 'text-[var(--ss-text-muted)]';
  const loginUsernameError = mode === 'login' ? fieldErrors.username : undefined;

  return (
    <main
      id="auth-main-content"
      tabIndex={-1}
      className={`grid min-h-[100svh] place-items-center px-4 sm:px-6 ${mode === 'login' ? 'py-1 sm:py-8' : 'py-8'}`}
    >
      <div className="w-full max-w-[480px]">
        <div className="mb-6 flex items-center justify-center gap-3">
          <StarSnapBrandIcon />
          <div>
            <p className="text-[11px] font-bold tracking-[0.18em] text-[var(--ss-text-muted)]">STARSNAP ERP</p>
            <p className="text-base font-semibold tracking-tight text-[var(--ss-text)]">모든 업무를 위한 ERP</p>
          </div>
        </div>

        <section aria-labelledby="auth-title" className="overflow-hidden rounded-[var(--ss-radius-lg)] border border-[var(--ss-border)] bg-[var(--ss-surface)] shadow-[var(--ss-shadow-lg)]">
          <div className="border-b border-[var(--ss-border)] px-5 py-6 sm:px-8 sm:py-7">
            <div className="flex items-start gap-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--ss-radius-md)] bg-[var(--ss-brand-soft)] text-[var(--ss-on-brand)]">
                {mode === 'login' ? <KeyRound aria-hidden="true" size={21} /> : <ShieldCheck aria-hidden="true" size={21} />}
              </span>
              <div>
                <h1 id="auth-title" className="text-xl font-bold tracking-tight sm:text-2xl">
                  {mode === 'login' ? 'ERP 로그인' : 'ERP 회원가입'}
                </h1>
                <p className="mt-1 text-sm leading-6 text-[var(--ss-text-subtle)]">
                  {mode === 'login'
                    ? '아이디로 소속 업체의 ERP에 안전하게 접속하세요.'
                    : '필수 정보만 입력하면 우리 업체의 통합 ERP가 생성됩니다.'}
                </p>
              </div>
            </div>
          </div>

          <form
            noValidate
            onSubmit={handleSubmit}
            aria-busy={busy || undefined}
            className={`${mode === 'login' ? 'space-y-4 py-6' : 'space-y-3 py-5'} px-5 sm:px-8`}
          >
            <div>
              <label htmlFor="auth-username" className="mb-2 block text-sm font-semibold text-[var(--ss-text-soft)]">아이디</label>
              <div className={mode === 'signup' ? 'grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]' : ''}>
                <input
                  ref={usernameRef}
                  id="auth-username"
                  name="username"
                  type="text"
                  value={username}
                  disabled={busy}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={12}
                  aria-invalid={Boolean(fieldErrors.username) || undefined}
                  aria-describedby={mode === 'signup'
                    ? 'auth-username-help auth-username-feedback'
                    : 'auth-username-help'}
                  onChange={(event) => handleUsernameChange(event.target.value)}
                  className="star-control w-full px-3 text-sm"
                  placeholder="영문·숫자 4~12자"
                />
                {mode === 'signup' ? (
                  <button
                    type="button"
                    disabled={busy || username.trim().length === 0}
                    aria-controls="auth-username-feedback"
                    onClick={() => void checkUsername()}
                    className="star-secondary-button whitespace-nowrap px-4 text-sm"
                  >
                    {pendingAction === 'username' ? '확인 중…' : '중복 확인'}
                  </button>
                ) : null}
              </div>
              <p
                id="auth-username-help"
                role={loginUsernameError ? 'alert' : undefined}
                className={`mt-2 text-xs leading-5 ${loginUsernameError ? 'font-medium text-[var(--ss-danger)]' : 'text-[var(--ss-text-muted)]'}`}
              >
                {loginUsernameError ?? '4~12자의 영문과 숫자만 사용할 수 있습니다.'}
              </p>
              {mode === 'signup' ? (
                <p id="auth-username-feedback" role="status" aria-live="polite" className={`${usernameFeedback ? 'mt-1' : ''} text-xs font-medium ${usernameFeedbackTone}`}>
                  {usernameFeedback}
                </p>
              ) : null}
            </div>

            <div>
              <label htmlFor="auth-password" className="mb-2 block text-sm font-semibold text-[var(--ss-text-soft)]">비밀번호</label>
              <div className="relative">
                <input
                  ref={passwordRef}
                  id="auth-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  disabled={busy}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  maxLength={mode === 'login' ? 72 : 50}
                  aria-invalid={Boolean(fieldErrors.password) || undefined}
                  aria-describedby={mode === 'signup'
                    ? fieldErrors.password ? 'auth-password-help auth-password-error' : 'auth-password-help'
                    : 'auth-password-error'}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    clearFieldError('password');
                    clearFieldError('passwordConfirmation');
                  }}
                  className="star-control w-full px-3 pr-12 text-sm"
                  placeholder="비밀번호 입력"
                />
                <button
                  type="button"
                  aria-label={showPassword ? '비밀번호 숨기기' : '비밀번호 보기'}
                  aria-pressed={showPassword}
                  disabled={busy}
                  onClick={() => setShowPassword((current) => !current)}
                  className="absolute right-0 top-0 grid h-11 w-11 place-items-center rounded-[var(--ss-control-radius)] text-[var(--ss-text-muted)] hover:text-[var(--ss-text)]"
                >
                  {showPassword ? <EyeOff aria-hidden="true" size={19} /> : <Eye aria-hidden="true" size={19} />}
                </button>
              </div>
              {mode === 'signup' ? <p id="auth-password-help" className="mt-2 text-xs leading-5 text-[var(--ss-text-muted)]">영문 대소문자, 숫자, 특수문자를 포함하여 8~50자로 입력해 주세요.</p> : null}
              <p
                id="auth-password-error"
                role={fieldErrors.password ? 'alert' : undefined}
                className={`${mode === 'login' || fieldErrors.password ? 'mt-1' : ''} ${mode === 'login' ? 'min-h-5' : ''} text-xs font-medium text-[var(--ss-danger)]`}
              >
                {fieldErrors.password}
              </p>
            </div>

            {mode === 'signup' ? (
              <>
                <div>
                  <label htmlFor="auth-password-confirmation" className="mb-2 block text-sm font-semibold text-[var(--ss-text-soft)]">비밀번호 확인</label>
                  <div className="relative">
                    <input
                      ref={passwordConfirmationRef}
                      id="auth-password-confirmation"
                      name="passwordConfirmation"
                      type={showPasswordConfirmation ? 'text' : 'password'}
                      value={passwordConfirmation}
                      disabled={busy}
                      autoComplete="new-password"
                      maxLength={50}
                      aria-invalid={Boolean(fieldErrors.passwordConfirmation) || undefined}
                      aria-describedby={fieldErrors.passwordConfirmation ? 'auth-password-confirmation-error' : undefined}
                      onChange={(event) => {
                        setPasswordConfirmation(event.target.value);
                        clearFieldError('passwordConfirmation');
                      }}
                      className="star-control w-full px-3 pr-12 text-sm"
                      placeholder="비밀번호 다시 입력"
                    />
                    <button
                      type="button"
                      aria-label={showPasswordConfirmation ? '비밀번호 확인 숨기기' : '비밀번호 확인 보기'}
                      aria-pressed={showPasswordConfirmation}
                      disabled={busy}
                      onClick={() => setShowPasswordConfirmation((current) => !current)}
                      className="absolute right-0 top-0 grid h-11 w-11 place-items-center rounded-[var(--ss-control-radius)] text-[var(--ss-text-muted)] hover:text-[var(--ss-text)]"
                    >
                      {showPasswordConfirmation ? <EyeOff aria-hidden="true" size={19} /> : <Eye aria-hidden="true" size={19} />}
                    </button>
                  </div>
                  <p id="auth-password-confirmation-error" role={fieldErrors.passwordConfirmation ? 'alert' : undefined} className={`${fieldErrors.passwordConfirmation ? 'mt-1' : ''} text-xs font-medium text-[var(--ss-danger)]`}>{fieldErrors.passwordConfirmation}</p>
                </div>

                <div>
                  <label htmlFor="auth-email" className="mb-2 block text-sm font-semibold text-[var(--ss-text-soft)]">이메일</label>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="relative">
                      <Mail aria-hidden="true" size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ss-text-muted)]" />
                      <input
                        ref={emailRef}
                        id="auth-email"
                        name="email"
                        type="email"
                        inputMode="email"
                        value={email}
                        disabled={busy}
                        autoComplete="email"
                        autoCapitalize="none"
                        spellCheck={false}
                        maxLength={254}
                        aria-invalid={Boolean(fieldErrors.email) || undefined}
                        aria-describedby="auth-email-feedback"
                        onChange={(event) => handleEmailChange(event.target.value)}
                        className="star-control w-full pl-10 pr-3 text-sm"
                        placeholder="name@example.com"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={busy || email.trim().length === 0 || Boolean(verifiedEmail)}
                      aria-controls="auth-email-feedback"
                      onClick={() => void sendEmailCode()}
                      className="star-secondary-button whitespace-nowrap px-4 text-sm"
                    >
                      {pendingAction === 'send-code' ? '확인·전송 중…' : emailChallenge ? '코드 다시 받기' : '인증코드 받기'}
                    </button>
                  </div>

                  {emailChallenge && !verifiedEmail ? (
                    <div className="mt-3">
                      <label htmlFor="auth-email-code" className="mb-2 block text-xs font-semibold text-[var(--ss-text-soft)]">이메일 인증코드</label>
                      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                        <input
                          ref={emailCodeRef}
                          id="auth-email-code"
                          name="emailCode"
                          type="text"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          pattern="[0-9]{6}"
                          maxLength={6}
                          value={emailCode}
                          disabled={busy}
                          aria-invalid={Boolean(fieldErrors.emailCode) || undefined}
                          aria-describedby="auth-email-feedback"
                          onChange={(event) => {
                            setEmailCode(event.target.value.replace(/\D/g, '').slice(0, 6));
                            clearFieldError('emailCode');
                          }}
                          className="star-control w-full px-3 font-mono tracking-[0.25em]"
                          placeholder="000000"
                        />
                        <button
                          type="button"
                          disabled={busy || emailCode.length !== 6}
                          aria-controls="auth-email-feedback"
                          onClick={() => void verifyEmailCode()}
                          className="star-secondary-button whitespace-nowrap px-4 text-sm"
                        >
                          {pendingAction === 'verify-code' ? '인증 중…' : '코드 인증'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <div id="auth-email-feedback" role="status" aria-live="polite" aria-atomic="true" className={`${fieldErrors.email || fieldErrors.emailCode || emailStatus || (localInboxUrl && !verifiedEmail) ? 'mt-2' : ''} text-xs font-medium ${emailFeedbackTone}`}>
                    {fieldErrors.email ?? fieldErrors.emailCode ?? emailStatus}
                    {localInboxUrl && !verifiedEmail ? (
                      <a href={localInboxUrl} target="_blank" rel="noreferrer" className="ml-2 underline underline-offset-2">개발용 인증함 열기</a>
                    ) : null}
                  </div>
                </div>

                <div>
                  <label htmlFor="auth-company-name" className="mb-2 block text-sm font-semibold text-[var(--ss-text-soft)]">업체명</label>
                  <input
                    ref={companyNameRef}
                    id="auth-company-name"
                    name="companyName"
                    type="text"
                    value={companyName}
                    disabled={busy}
                    autoComplete="organization"
                    maxLength={80}
                    aria-invalid={Boolean(fieldErrors.companyName) || undefined}
                    aria-describedby={fieldErrors.companyName ? 'auth-company-error' : undefined}
                    onChange={(event) => {
                      setCompanyName(event.target.value);
                      clearFieldError('companyName');
                    }}
                    className="star-control w-full px-3 text-sm"
                    placeholder="업체명을 입력해 주세요"
                  />
                  <p id="auth-company-error" role={fieldErrors.companyName ? 'alert' : undefined} className={`${fieldErrors.companyName ? 'mt-1' : ''} text-xs font-medium text-[var(--ss-danger)]`}>{fieldErrors.companyName}</p>
                </div>
              </>
            ) : null}

            <div className={mode === 'signup' ? 'pt-2' : ''}>
              <button type="submit" disabled={busy || (mode === 'signup' && !signupReady)} className="star-primary-button w-full text-sm">
                {pendingAction === 'login' ? '로그인 중…' : pendingAction === 'signup' ? '가입 처리 중…' : mode === 'login' ? '로그인' : '회원가입'}
              </button>
            </div>
          </form>

          <div className="flex min-h-16 items-center justify-center gap-2 border-t border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] px-5 py-3 text-sm text-[var(--ss-text-subtle)]">
            <span>{mode === 'login' ? '처음 이용하시나요?' : '이미 계정이 있나요?'}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => changeMode(mode === 'login' ? 'signup' : 'login')}
              className="min-h-11 rounded-[var(--ss-radius-sm)] px-2 font-bold text-[var(--ss-text)] underline decoration-[var(--ss-brand-active)] decoration-2 underline-offset-4"
            >
              {mode === 'login' ? '회원가입' : '로그인'}
            </button>
          </div>
        </section>
        <p className="mt-5 text-center text-xs leading-5 text-[var(--ss-text-muted)]">로그인하면 해당 계정에 연결된 업체 ERP만 표시됩니다.</p>
      </div>

      <NoticeModal
        notice={notice}
        onClose={() => setNotice(null)}
        fallbackFocusSelector="#auth-main-content"
      />
    </main>
  );
}
