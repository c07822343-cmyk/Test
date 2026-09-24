import pg from 'pg';
import { logger } from '../util/log.ts';

const log = logger('db');

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, max = 20): Db {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
  pool.on('error', (err) => log.error('idle client error', { error: err.message }));
  return pool;
}

export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
