import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../src/db/migrations', import.meta.url));

/** In-memory Postgres with the real migrations applied. */
export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return {
    db: db as unknown as Db,
    reset: async () => {
      await db.execute(sql`truncate events, order_items, orders, messages, settings, users restart identity cascade`);
    },
    close: () => client.close(),
  };
}
