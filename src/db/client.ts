import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

/** Any Drizzle Postgres database or transaction over our schema (postgres.js in the app, PGlite in tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDb(databaseUrl: string) {
  const sql = postgres(databaseUrl, {
    max: 5,
    connect_timeout: 10,
    idle_timeout: 20,
    // Neon's pooled endpoint runs PgBouncer in transaction mode.
    prepare: false,
    onnotice: () => {},
  });
  const db = drizzle({ client: sql, schema });

  return {
    db,
    ping: async (): Promise<void> => {
      await sql`select 1`;
    },
    close: (): Promise<void> => sql.end({ timeout: 5 }),
  };
}
