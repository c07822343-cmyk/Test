import { createPool, type Db } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://apexweb:apexweb_dev@127.0.0.1:5432/apexweb_test';

/** Fresh schema per test file. Tests never touch a non-test database. */
export async function freshDb(): Promise<Db> {
  if (!/test/.test(TEST_DATABASE_URL)) throw new Error('Refusing to reset a database whose name does not contain "test"');
  const db = createPool(TEST_DATABASE_URL, 30);
  await db.query('DROP SCHEMA IF EXISTS public CASCADE');
  await db.query('CREATE SCHEMA public');
  await migrate(db);
  return db;
}
