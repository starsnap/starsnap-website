const passwordAlgorithm = 'PBKDF2-SHA256';
const passwordIterations = 600_000;
const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string) {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function randomBytes(length: number) {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function sha256Bytes(value: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const saltBuffer = new Uint8Array(salt).buffer;
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: saltBuffer,
    iterations,
  }, key, 256);
  return new Uint8Array(bits);
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const digest = await derivePassword(password, salt, passwordIterations);
  return `${passwordAlgorithm}$${passwordIterations}$${bytesToHex(salt)}$${bytesToHex(digest)}`;
}

export async function verifyPassword(password: string, encodedHash: string) {
  const [algorithm, iterationValue, saltValue, digestValue] = encodedHash.split('$');
  const iterations = Number(iterationValue);
  const salt = hexToBytes(saltValue ?? '');
  const expected = hexToBytes(digestValue ?? '');
  if (
    algorithm !== passwordAlgorithm
    || !Number.isInteger(iterations)
    || iterations < 100_000
    || iterations > 1_000_000
    || !salt
    || salt.length < 16
    || !expected
    || expected.length !== 32
  ) return false;
  const actual = await derivePassword(password, salt, iterations);
  return constantTimeEqual(actual, expected);
}

export async function burnPasswordVerification(password: string) {
  const salt = encoder.encode('starsnap-auth-dummy-salt-v1').slice(0, 16);
  await derivePassword(password, salt, passwordIterations);
}

export function createSessionToken() {
  return base64Url(randomBytes(32));
}

export function createVerificationToken() {
  return base64Url(randomBytes(32));
}

export function createEmailCode() {
  const ceiling = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const values = new Uint32Array(1);
  do crypto.getRandomValues(values); while ((values[0] ?? ceiling) >= ceiling);
  return String((values[0] ?? 0) % 1_000_000).padStart(6, '0');
}

export async function hashOpaqueToken(token: string) {
  return bytesToHex(await sha256Bytes(token));
}

export async function hashRateLimitScope(scope: string) {
  return bytesToHex(await sha256Bytes(`starsnap-auth-rate-v1:${scope}`));
}

export async function hashEmailCode(
  secret: string,
  challengeId: string,
  email: string,
  code: string,
) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${challengeId}\n${email}\n${code}`),
  );
  return bytesToHex(new Uint8Array(signature));
}
