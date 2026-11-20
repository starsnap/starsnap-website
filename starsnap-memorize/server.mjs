import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { answerDigests } from './answer-digests.mjs';
import { curriculum, normalize } from './memorize.mjs';
import { reviewMistakes } from './verse-review.mjs';

const read = (name) => readFileSync(new URL(name, import.meta.url));
const reviewData = JSON.parse(read('review-data.json'));
const entries = Object.values(curriculum).flatMap(groups => groups.flatMap(group => group.entries));
const answers = new Map(entries.map(({ id, reference }) => {
  const text = reviewData[reference];
  if (typeof text !== 'string' || createHash('sha256').update(normalize(text)).digest('hex') !== answerDigests[reference]) {
    throw new Error(`Review data does not match grading for ${id}`);
  }
  return [id, text];
}));

const types = { html: 'text/html', css: 'text/css', mjs: 'text/javascript' };
const assets = new Map(['index.html', 'style.css', 'app.mjs', 'memorize.mjs', 'answer-digests.mjs'].map(name => [
  `/${name}`, { bytes: read(name), type: types[name.split('.').at(-1)] },
]));
assets.set('/', assets.get('/index.html'));
const maxAnswer = 2_000;
const maxBody = 13_000;

async function review(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    response.writeHead(415).end();
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBody) {
      response.writeHead(413).end();
      request.resume();
      return;
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (!answers.has(body?.id) || typeof body.text !== 'string' || body.text.length > maxAnswer) {
    response.writeHead(400).end();
    return;
  }
  const mistakes = reviewMistakes(answers.get(body.id), body.text);
  const result = request.url.endsWith('?v=2') ? mistakes : mistakes.map(({ start, end }) => [start, end]);
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(result));
}

createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (request, response) => {
  const path = request.url.split('?')[0];
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (path === '/practice-review' && request.method === 'POST') {
    review(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
    return;
  }
  const asset = assets.get(path);
  if (!asset || (request.method !== 'GET' && request.method !== 'HEAD')) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': `${asset.type}; charset=utf-8`,
    'Content-Length': asset.bytes.length,
    'Cache-Control': 'no-cache',
  });
  response.end(request.method === 'GET' ? asset.bytes : undefined);
}).listen(8080);
