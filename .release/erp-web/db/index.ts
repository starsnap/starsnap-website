import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import * as schema from './schema';

export function getDb(client: PoolClient) {
  return drizzle(client, { schema });
}
