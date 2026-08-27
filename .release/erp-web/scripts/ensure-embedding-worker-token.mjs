import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const tokenFile = process.env.ERP_EMBEDDING_WORKER_TOKEN_FILE?.trim()
  || '/run/starsnap-secrets/embedding-worker-token';
const authSecretFile = process.env.AUTH_CODE_SECRET_FILE?.trim()
  || '/run/starsnap-secrets/auth-code-secret';
const mailerTokenFile = process.env.AUTH_SMTP_MAILER_TOKEN_FILE?.trim()
  || '/run/starsnap-mailer-secrets/token';
const rotateInternalSecrets = process.env.ROTATE_INTERNAL_SECRETS?.trim().toLowerCase() === 'true';
const runtimeUid = 1_000;
const runtimeGid = 1_000;

function ensureSecret(file, label) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o750 });
  chownSync(dirname(file), runtimeUid, runtimeGid);
  chmodSync(dirname(file), 0o750);

  let created = false;
  try {
    const descriptor = openSync(file, 'wx', 0o400);
    try {
      writeFileSync(descriptor, `${randomBytes(48).toString('base64url')}\n`, { encoding: 'utf8' });
    } finally {
      closeSync(descriptor);
    }
    created = true;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
  }

  const secret = readFileSync(file, 'utf8').trim();
  if (secret.length < 32) throw new Error(`Persisted ${label} is missing or too short.`);
  chownSync(file, runtimeUid, runtimeGid);
  chmodSync(file, 0o400);
  return { created, file };
}

function rotateSecret(file, label) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o750 });
  chownSync(dirname(file), runtimeUid, runtimeGid);
  chmodSync(dirname(file), 0o750);
  writeFileSync(file, `${randomBytes(48).toString('base64url')}\n`, { encoding: 'utf8', mode: 0o400 });
  const secret = readFileSync(file, 'utf8').trim();
  if (secret.length < 32) throw new Error(`Rotated ${label} is missing or too short.`);
  chownSync(file, runtimeUid, runtimeGid);
  chmodSync(file, 0o400);
  return { created: true, file };
}

const provision = rotateInternalSecrets ? rotateSecret : ensureSecret;
const workerToken = provision(tokenFile, 'embedding worker token');
const authSecret = provision(authSecretFile, 'authentication code secret');
const mailerToken = provision(mailerTokenFile, 'SMTP mailer service token');
console.log(JSON.stringify({
  service: 'starsnap-secret-initializer',
  mode: rotateInternalSecrets ? 'rotated' : 'ensured',
  embeddingWorkerToken: workerToken.created ? 'generated' : 'reused',
  authCodeSecret: authSecret.created ? 'generated' : 'reused',
  smtpMailerToken: mailerToken.created ? 'generated' : 'reused',
}));
