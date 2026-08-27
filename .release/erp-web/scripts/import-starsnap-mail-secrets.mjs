import {
  chmodSync,
  chownSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const optionValue = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return '';
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
};
const source = optionValue('--source')
  || process.env.STARSNAP_BACKEND_APPLICATION_YML?.trim()
  || '/source/application.yml';
const usernameFile = process.env.SMTP_USERNAME_FILE?.trim()
  || '/run/starsnap-smtp-credentials/username';
const passwordFile = process.env.SMTP_PASSWORD_FILE?.trim()
  || '/run/starsnap-smtp-credentials/password';
const validateOnly = args.includes('--validate-only')
  || process.env.STARSNAP_MAIL_SECRET_VALIDATE_ONLY?.trim().toLowerCase() === 'true';
const runtimeUid = 1_000;
const runtimeGid = 1_000;

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('${')) throw new Error('Mail setting must be resolved by its original secret source.');
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed);
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed.replace(/\s+#.*$/, '').trim();
}

function readMailSettings() {
  const contents = readFileSync(source, 'utf8');
  const lines = contents.split(/\r?\n/);
  const start = lines.findIndex((line) => /^  mail:\s*(?:#.*)?$/.test(line));
  if (start < 0) throw new Error('spring.mail settings were not found.');
  const blockLines = [];
  for (const line of lines.slice(start + 1)) {
    if (/^(?:\S|  \S)/.test(line)) break;
    blockLines.push(line);
  }
  const block = blockLines.join('\n');
  const setting = (name) => {
    const value = block.match(new RegExp(`^\\s{4}${name}:\\s*(.+)$`, 'm'))?.[1];
    if (!value) throw new Error(`spring.mail.${name} is missing.`);
    return parseScalar(value);
  };
  return {
    host: setting('host'),
    port: setting('port'),
    username: setting('username'),
    password: setting('password'),
  };
}

function writeSecret(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  chownSync(dirname(path), runtimeUid, runtimeGid);
  chmodSync(dirname(path), 0o750);
  writeFileSync(path, `${value}\n`, { encoding: 'utf8', mode: 0o400 });
  chownSync(path, runtimeUid, runtimeGid);
  chmodSync(path, 0o400);
}

const settings = readMailSettings();
if (settings.host !== 'smtp.gmail.com' || settings.port !== '587') {
  throw new Error('The StarSnap backend is not configured for Gmail SMTP on port 587.');
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.username) || settings.password.length < 8) {
  throw new Error('The StarSnap SMTP credentials are invalid.');
}

if (!validateOnly) {
  writeSecret(usernameFile, settings.username);
  writeSecret(passwordFile, settings.password);
}
console.log(JSON.stringify({
  service: 'starsnap-mail-secret-import',
  status: validateOnly ? 'validated' : 'imported',
}));
