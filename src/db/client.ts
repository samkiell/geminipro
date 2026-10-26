import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

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

export type Db = ReturnType<typeof createDb>['db'];
