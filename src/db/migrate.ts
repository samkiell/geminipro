import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { loadDotEnv } from '../config.js';
import { createLogger } from '../util/logger.js';

// Resolves from both src/db (tsx) and dist/db (compiled): each is two levels below the repo root.
const MIGRATIONS_DIR = fileURLToPath(new URL('../../src/db/migrations', import.meta.url));

loadDotEnv();
const logger = createLogger();

// Only DATABASE_URL is needed here, so migrations can run before the rest of the env is filled in.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !/^postgres(ql)?:\/\//.test(databaseUrl)) {
  logger.fatal('DATABASE_URL is missing or not a postgres:// connection string');
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
try {
  await migrate(drizzle({ client: sql }), { migrationsFolder: MIGRATIONS_DIR });
  logger.info('migrations applied');
} catch (err) {
  logger.fatal({ err }, 'migration failed');
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
