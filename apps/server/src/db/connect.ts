// 本番の Postgres につなぐ（Railway）。起きる時に移行を当てる（drizzle/ の SQL。同じ物は二度当てない）。
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import type { Db } from './store';

export const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function connect(url: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const pool = new Pool({ connectionString: url, max: 5 });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, close: () => pool.end() };
}
