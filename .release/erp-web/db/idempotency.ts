import type { PoolClient } from 'pg';

export interface IdempotencyResult {
  status: number;
  body: unknown;
}

export type IdempotencyClaim =
  | { kind: 'acquired'; leaseToken: string }
  | { kind: 'result'; result: IdempotencyResult };

interface IdempotencyRow {
  requestHash: string;
  responseJson: string;
  leaseToken: string;
  leaseExpiresAt: string | null;
}

function replay(row: IdempotencyRow, requestHash: string): IdempotencyResult {
  if (row.requestHash !== requestHash) {
    return { status: 409, body: { ok: false, message: '같은 Idempotency-Key를 다른 요청에 다시 사용할 수 없습니다.' } };
  }
  if (!row.responseJson) {
    return { status: 425, body: { ok: false, message: '같은 요청이 이미 처리 중입니다. 잠시 후 다시 확인해 주세요.' } };
  }
  return { status: 200, body: JSON.parse(row.responseJson) as unknown };
}

export async function claimIdempotency(
  client: PoolClient,
  tenantId: string,
  key: string,
  requestHash: string,
  now: string,
  leaseMs: number,
): Promise<IdempotencyClaim> {
  // Completed responses are immutable, so replay them without contending on the
  // transaction lock. This also lets concurrent replays all return 200.
  const completed = await client.query<IdempotencyRow>(
    `SELECT request_hash AS "requestHash", response_json AS "responseJson",
       lease_token AS "leaseToken", lease_expires_at AS "leaseExpiresAt"
     FROM idempotency_keys
     WHERE tenant_id = $1 AND key = $2 AND response_json <> ''`,
    [tenantId, key],
  );
  if (completed.rows[0]) {
    return { kind: 'result', result: replay(completed.rows[0], requestHash) };
  }

  const transactionLock = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
    [`mealops:idempotency:${tenantId}:${key}`],
  );
  if (!transactionLock.rows[0]?.acquired) {
    return {
      kind: 'result',
      result: { status: 425, body: { ok: false, message: '같은 요청이 이미 처리 중입니다. 잠시 후 다시 확인해 주세요.' } },
    };
  }

  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
  const inserted = await client.query<{ leaseToken: string }>(
    `INSERT INTO idempotency_keys
       (tenant_id, key, request_hash, response_json, lease_token, lease_expires_at, created_at)
     VALUES ($1, $2, $3, '', $4, $5, $6)
     ON CONFLICT (tenant_id, key) DO NOTHING
     RETURNING lease_token AS "leaseToken"`,
    [tenantId, key, requestHash, leaseToken, leaseExpiresAt, now],
  );
  if (inserted.rowCount === 1) return { kind: 'acquired', leaseToken };

  const existing = await client.query<IdempotencyRow>(
    `SELECT request_hash AS "requestHash", response_json AS "responseJson",
       lease_token AS "leaseToken", lease_expires_at AS "leaseExpiresAt"
     FROM idempotency_keys
     WHERE tenant_id = $1 AND key = $2
     FOR UPDATE`,
    [tenantId, key],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new Error('멱등성 요청 상태를 확인할 수 없습니다.');
  }
  if (row.requestHash !== requestHash || row.responseJson) {
    return { kind: 'result', result: replay(row, requestHash) };
  }

  const leaseExpired = row.leaseExpiresAt === null || row.leaseExpiresAt <= now;
  if (!leaseExpired) return { kind: 'result', result: replay(row, requestHash) };

  const reclaimed = await client.query(
    `UPDATE idempotency_keys
     SET lease_token = $1, lease_expires_at = $2
     WHERE tenant_id = $3 AND key = $4 AND request_hash = $5 AND response_json = ''
     RETURNING key`,
    [leaseToken, leaseExpiresAt, tenantId, key, requestHash],
  );
  if (reclaimed.rowCount !== 1) {
    throw new Error('멱등성 요청 소유권을 확보하지 못했습니다.');
  }
  return { kind: 'acquired', leaseToken };
}

export async function releaseIdempotency(
  client: PoolClient,
  tenantId: string,
  key: string,
  requestHash: string,
  leaseToken: string,
) {
  await client.query(
    `DELETE FROM idempotency_keys
     WHERE tenant_id = $1 AND key = $2 AND request_hash = $3
       AND lease_token = $4 AND response_json = ''`,
    [tenantId, key, requestHash, leaseToken],
  );
}

export async function commitIdempotency(
  client: PoolClient,
  tenantId: string,
  key: string,
  requestHash: string,
  leaseToken: string,
  body: unknown,
) {
  const committed = await client.query(
    `UPDATE idempotency_keys
     SET response_json = $1, lease_token = '', lease_expires_at = NULL
     WHERE tenant_id = $2 AND key = $3 AND request_hash = $4
       AND lease_token = $5 AND response_json = ''
     RETURNING key`,
    [JSON.stringify(body), tenantId, key, requestHash, leaseToken],
  );
  if (committed.rowCount !== 1) {
    throw new Error('멱등성 응답을 확정하지 못했습니다.');
  }
}
