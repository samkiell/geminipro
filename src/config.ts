import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'], { error: 'expected true or false' })
    .transform((v) => v === 'true' || v === '1')
    .default(fallback);

const int = () => z.coerce.number({ error: 'expected a number' }).int('expected a whole number');

const csv = () =>
  z.string().transform((s) =>
    s
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.url({ error: 'expected a full URL like https://geminipro.onrender.com' }),

  TELEGRAM_BOT_TOKEN: z
    .string()
    .regex(/^\d+:[A-Za-z0-9_-]+$/, 'expected a BotFather token like 123456789:AAE...'),
  // Telegram only allows A-Z, a-z, 0-9, _ and - in secret_token.
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,256}$/, 'expected 16 to 256 chars of A-Z, a-z, 0-9, _ or -'),
  ADMIN_TELEGRAM_IDS: csv().pipe(
    z
      .array(z.string().regex(/^\d+$/, 'expected numeric Telegram user ids').transform(Number))
      .min(1, 'expected at least one admin Telegram user id'),
  ),

  PAYSTACK_SECRET_KEY: z
    .string()
    .regex(/^sk_(test|live)_[A-Za-z0-9]+$/, 'expected a secret key starting with sk_test_ or sk_live_'),
  GROSS_UP: bool(true),
  FEE_PCT: z.coerce.number().min(0).lt(1, 'expected a fraction like 0.015').default(0.015),
  FEE_FLAT: int().min(0).default(100),

  RESELLER_BASE_URL: z.url().default('https://api-geminipro.ignorelist.com/api/reseller/v1'),
  RESELLER_API_KEY: z.string(),
  RESELLER_PRODUCT_ID: int().positive(),
  RESELLER_MOCK: bool(false),

  GROQ_API_KEY: z.string(),
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  GROQ_FALLBACK_MODELS: csv().default([]),

  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'expected a postgres:// connection string'),

  UNIT_PRICE_NGN: int().positive().default(3500),
  MAX_QTY_PER_ORDER: int().positive().default(10),
  LOW_BALANCE_ORDERS: int().min(0).default(5),
  SUPPORT_WHATSAPP: z.string().default('08087357158'),

  ALERT_EMAIL: z.email().default('hello@samkiel.dev'),
  RESEND_API_KEY: z.string().optional(),
  NTFY_TOPIC: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'expected an ntfy topic name (letters, digits, _ or -)'),

  // ISO time with an explicit offset, e.g. 2026-10-29T19:30:00+01:00. Unset means no cutoff.
  SALES_CUTOFF: z.iso
    .datetime({ offset: true, error: 'expected an ISO time with offset like 2026-10-29T19:30:00+01:00' })
    .transform((s) => new Date(s))
    .optional(),
});

export type Config = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Validates the environment. Throws ConfigError listing every bad variable (never their values). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat blank values (KEY= in .env or the Render dashboard) as unset so defaults apply.
  const present = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const result = envSchema.safeParse(present);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const key = String(issue.path[0] ?? '(env)');
    const detail = key in present ? issue.message : 'is required but not set';
    return `  - ${key}: ${detail}`;
  });
  throw new ConfigError(
    `Invalid environment configuration:\n${problems.join('\n')}\nSee .env.example for every variable.`,
  );
}

/** Loads .env into process.env if the file exists. Real environment variables win. */
export function loadDotEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
