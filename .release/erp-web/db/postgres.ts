import { env } from 'cloudflare:workers';
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';

interface DatabaseBindings {
  DATABASE_URL?: string;
  PGPOOL_MAX?: string;
  PGSSL?: string;
  PGSSL_CA?: string;
}

export type SqlExecutor = Pick<Pool | PoolClient, 'query'>;

function bindings(): DatabaseBindings {
  return env as unknown as DatabaseBindings;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function poolConfig(): PoolConfig {
  const current = bindings();
  const connectionString = current.DATABASE_URL;
  if (!connectionString) {
    throw new Error('PostgreSQL 연결 문자열이 없습니다. DATABASE_URL 환경 변수를 설정해 주세요.');
  }

  return {
    connectionString,
    max: positiveInteger(current.PGPOOL_MAX, 1),
    // Cloudflare Worker TCP sockets belong to the request that opened them.
    // Retire a checked-out client on release so a later request never reuses
    // another request's socket. Transactions still keep one client for their
    // complete lifetime, while PostgreSQL/Hyperdrive performs upstream pooling.
    maxUses: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    ssl: current.PGSSL === 'require'
      ? { rejectUnauthorized: true, ca: current.PGSSL_CA?.replaceAll('\\n', '\n') }
      : current.PGSSL === 'insecure'
        ? { rejectUnauthorized: false }
        : undefined,
  };
}

export function getPool() {
  const pool = new Pool(poolConfig());
  pool.on('error', (error) => console.error('PostgreSQL idle client error', error));
  return pool;
}

export async function queryAll<T extends QueryResultRow>(
  sql: string,
  values: readonly unknown[] = [],
  executor?: SqlExecutor,
) {
  const ownedPool = executor ? undefined : getPool();
  try {
    const result = await (executor ?? ownedPool!).query<T>(sql, [...values]);
    return result.rows;
  } finally {
    if (ownedPool) await ownedPool.end();
  }
}

export async function queryOne<T extends QueryResultRow>(
  sql: string,
  values: readonly unknown[] = [],
  executor?: SqlExecutor,
) {
  const ownedPool = executor ? undefined : getPool();
  try {
    const result = await (executor ?? ownedPool!).query<T>(sql, [...values]);
    return result.rows[0];
  } finally {
    if (ownedPool) await ownedPool.end();
  }
}

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
  isolation: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' = 'READ COMMITTED',
) {
  const transactionPool = getPool();
  let client: PoolClient | undefined;
  try {
    client = await transactionPool.connect();
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('PostgreSQL rollback failed', rollbackError);
      }
    }
    throw error;
  } finally {
    client?.release();
    await transactionPool.end();
  }
}

export async function withAdvisoryLock<T>(
  lockKey: string,
  callback: () => Promise<T>,
) {
  const lockPool = getPool();
  let client: PoolClient | undefined;
  let locked = false;
  try {
    client = await lockPool.connect();
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    locked = true;
    return await callback();
  } finally {
    if (client && locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
      } catch (unlockError) {
        console.error('PostgreSQL advisory unlock failed', unlockError);
      }
    }
    client?.release();
    await lockPool.end();
  }
}
