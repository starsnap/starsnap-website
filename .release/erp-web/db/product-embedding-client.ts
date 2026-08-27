import { env } from 'cloudflare:workers';

export const PRODUCT_EMBEDDING_RUNTIME_MODEL = 'bge-m3:567m-fp16';
export const PRODUCT_EMBEDDING_MODEL_DIGEST_PREFIX = '790764642607';
export const PRODUCT_SEARCH_MODEL = `ollama/${PRODUCT_EMBEDDING_RUNTIME_MODEL}@${PRODUCT_EMBEDDING_MODEL_DIGEST_PREFIX}`;
export const PRODUCT_SEARCH_DIMENSION = 1024;

const DEFAULT_BASE_URL = 'http://ollama:11434';
const DEFAULT_BATCH_SIZE = 128;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_KEEP_ALIVE = '30m';

interface EmbeddingBindings {
  ERP_EMBEDDING_BASE_URL?: string;
  ERP_EMBEDDING_BATCH_SIZE?: string;
  ERP_EMBEDDING_TIMEOUT_MS?: string;
  ERP_EMBEDDING_KEEP_ALIVE?: string;
}

interface OllamaTag {
  name?: string;
  model?: string;
  digest?: string;
}

interface OllamaEmbedResponse {
  model?: string;
  embeddings?: unknown;
}

export interface ProductEmbeddingRuntimeStatus {
  provider: 'ollama';
  model: string;
  digest: string;
  dimension: number;
}

export class ProductEmbeddingUnavailableError extends Error {
  readonly code = 'PRODUCT_EMBEDDING_UNAVAILABLE';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProductEmbeddingUnavailableError';
  }
}

function bindings() {
  return env as unknown as EmbeddingBindings;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function embeddingBaseUrl() {
  const configured = bindings().ERP_EMBEDDING_BASE_URL?.trim() || DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch (error) {
    throw new ProductEmbeddingUnavailableError('상품 임베딩 서비스 URL이 올바르지 않습니다.', { cause: error });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ProductEmbeddingUnavailableError('상품 임베딩 서비스 URL은 인증정보가 없는 HTTP(S) URL이어야 합니다.');
  }
  return parsed.toString().replace(/\/$/, '');
}

function productEmbeddingConfig() {
  const current = bindings();
  return {
    baseUrl: embeddingBaseUrl(),
    batchSize: boundedInteger(current.ERP_EMBEDDING_BATCH_SIZE, DEFAULT_BATCH_SIZE, 1, 512),
    timeoutMs: boundedInteger(current.ERP_EMBEDDING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 600_000),
    keepAlive: current.ERP_EMBEDDING_KEEP_ALIVE?.trim() || DEFAULT_KEEP_ALIVE,
  };
}

async function ollamaRequest(path: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${embeddingBaseUrl()}${path}`, { ...init, signal: controller.signal });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new ProductEmbeddingUnavailableError(
        `Ollama 요청이 실패했습니다. (${response.status}${detail ? `: ${detail}` : ''})`,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof ProductEmbeddingUnavailableError) throw error;
    const message = error instanceof Error && error.name === 'AbortError'
      ? `Ollama 응답 시간이 ${timeoutMs}ms를 초과했습니다.`
      : 'Ollama 상품 임베딩 서비스에 연결할 수 없습니다.';
    throw new ProductEmbeddingUnavailableError(message, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

async function readOllamaJson(response: Response, context: string) {
  try {
    const payload = await response.json() as unknown;
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('response body is not an object');
    }
    return payload;
  } catch (error) {
    throw new ProductEmbeddingUnavailableError(`Ollama ${context} 응답 JSON이 올바르지 않습니다.`, { cause: error });
  }
}

function isOllamaTag(value: unknown): value is OllamaTag {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (typeof candidate.name === 'string' || typeof candidate.model === 'string')
    && (candidate.digest === undefined || typeof candidate.digest === 'string');
}

async function inspectRuntime(timeoutOverrideMs?: number): Promise<ProductEmbeddingRuntimeStatus> {
  const config = productEmbeddingConfig();
  const timeoutMs = timeoutOverrideMs && Number.isInteger(timeoutOverrideMs)
    ? Math.max(250, Math.min(config.timeoutMs, timeoutOverrideMs))
    : config.timeoutMs;
  const response = await ollamaRequest('/api/tags', { headers: { Accept: 'application/json' } }, timeoutMs);
  const payload = await readOllamaJson(response, '모델 목록') as Record<string, unknown>;
  if (!Array.isArray(payload.models) || !payload.models.every(isOllamaTag)) {
    throw new ProductEmbeddingUnavailableError('Ollama 모델 목록 응답 형식이 올바르지 않습니다.');
  }
  const installed = payload.models.find((candidate) =>
    candidate.name === PRODUCT_EMBEDDING_RUNTIME_MODEL
    || candidate.model === PRODUCT_EMBEDDING_RUNTIME_MODEL);
  if (!installed) {
    throw new ProductEmbeddingUnavailableError(
      `Ollama에 ${PRODUCT_EMBEDDING_RUNTIME_MODEL} 모델이 설치되어 있지 않습니다.`,
    );
  }
  const digest = installed.digest?.toLowerCase() ?? '';
  if (!digest.startsWith(PRODUCT_EMBEDDING_MODEL_DIGEST_PREFIX)) {
    throw new ProductEmbeddingUnavailableError(
      `Ollama 모델 digest가 고정된 버전과 다릅니다. (${digest.slice(0, 12) || 'unknown'})`,
    );
  }
  return {
    provider: 'ollama',
    model: PRODUCT_EMBEDDING_RUNTIME_MODEL,
    digest,
    dimension: PRODUCT_SEARCH_DIMENSION,
  };
}

/** One-shot runtime diagnostic with a caller-specific timeout. */
export function probeProductEmbeddingRuntimeStatus(timeoutMs: number) {
  return inspectRuntime(timeoutMs);
}

export async function getProductEmbeddingRuntimeStatus(
  options: { refresh?: boolean; timeoutMs?: number } = {},
) {
  // Ollama tags are mutable and Worker I/O is request-scoped. A cheap tags
  // check per search/drain prevents cross-request Promise sharing and ensures
  // the pinned digest is still active immediately before inference.
  return inspectRuntime(options.timeoutMs);
}

function validateEmbeddingBatch(value: unknown, expectedCount: number) {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new ProductEmbeddingUnavailableError(
      `Ollama 임베딩 개수가 요청과 다릅니다. (expected=${expectedCount}, actual=${Array.isArray(value) ? value.length : 'invalid'})`,
    );
  }
  return value.map((candidate, rowIndex) => {
    if (!Array.isArray(candidate) || candidate.length !== PRODUCT_SEARCH_DIMENSION) {
      throw new ProductEmbeddingUnavailableError(
        `Ollama 임베딩 ${rowIndex + 1}행의 차원이 ${PRODUCT_SEARCH_DIMENSION}이 아닙니다.`,
      );
    }
    const vector = candidate.map(Number);
    if (vector.some((entry) => !Number.isFinite(entry))) {
      throw new ProductEmbeddingUnavailableError(`Ollama 임베딩 ${rowIndex + 1}행에 유효하지 않은 값이 있습니다.`);
    }
    return vector;
  });
}

async function embedBatch(input: readonly string[], timeoutMs: number, keepAlive: string) {
  const maximumAttempts = 3;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const response = await ollamaRequest('/api/embed', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: PRODUCT_EMBEDDING_RUNTIME_MODEL,
          input,
          truncate: false,
          keep_alive: keepAlive,
        }),
      }, timeoutMs);
      const payload = await readOllamaJson(response, '임베딩') as OllamaEmbedResponse;
      return validateEmbeddingBatch(payload.embeddings, input.length);
    } catch (error) {
      if (attempt === maximumAttempts) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw new ProductEmbeddingUnavailableError('Ollama 임베딩 재시도 루프가 예기치 않게 종료되었습니다.');
}

export async function createProductEmbeddings(input: readonly string[]) {
  if (input.length === 0) return [];
  await getProductEmbeddingRuntimeStatus();
  const config = productEmbeddingConfig();
  const embeddings: number[][] = [];
  for (let offset = 0; offset < input.length; offset += config.batchSize) {
    embeddings.push(...await embedBatch(
      input.slice(offset, offset + config.batchSize),
      config.timeoutMs,
      config.keepAlive,
    ));
  }
  return embeddings;
}

export async function createProductQueryEmbedding(query: string) {
  const [embedding] = await createProductEmbeddings([query]);
  if (!embedding) throw new ProductEmbeddingUnavailableError('Ollama가 검색어 임베딩을 반환하지 않았습니다.');
  return embedding;
}
