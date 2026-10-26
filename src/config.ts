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
  // Without the @. The bot's public link is https://t.me/<username>.
  TELEGRAM_BOT_USERNAME: z
    .string()
    .transform((s) => s.replace(/^@/, ''))
    .pipe(z.string().regex(/^[A-Za-z0-9_]{5,32}$/, 'expected a bot username like geminiprosamkiel_bot'))
    .default('geminiprosamkiel_bot'),
  // Telegram only allows A-Z, a-z, 0-9, _ and - in secret_token.
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,256}$/, 'expected 16 to 256 chars of A-Z, a-z, 0-9, _ or -'),
  ADMIN_TELEGRAM_IDS: csv().pipe(
    z
      .array(z.string().regex(/^\d+$/, 'expected numeric Telegram user ids').transform(Number))
      .min(1, 'expected at least one admin Telegram user id'),
  ),

  // sk_sandbox_ keys talk to sandbox-api.bachs.io, sk_live_ keys to api.bachs.io.
  BACHS_SECRET_KEY: z
    .string()
    .regex(/^sk_(sandbox|live)_[A-Za-z0-9_-]+$/, 'expected a secret key starting with sk_sandbox_ or sk_live_'),
  // Signing secret of the webhook endpoint (developer portal, or printed by `bachs listen`).
  // Unset: the app still runs, but answers webhooks with 503 so Bachs retries them later.
  BACHS_WEBHOOK_SECRET: z.string().optional(),
  // Unset: picked from the key (sk_sandbox_ -> sandbox-api.bachs.io, sk_live_ -> api.bachs.io).
  BACHS_BASE_URL: z.url().optional(),
  // false: the Bachs account's fee_preference is customer_pays, so Bachs adds the fee at checkout.
  // true: the account absorbs fees (org_pays) and the bot adds FEE_PCT/FEE_FLAT to the total itself.
  GROSS_UP: bool(false),
  FEE_PCT: z.coerce.number().min(0).lt(1, 'expected a fraction like 0.02').default(0.02),
  FEE_FLAT: int().min(0).default(0),

  RESELLER_BASE_URL: z.url().default('https://api-geminipro.ignorelist.com/api/reseller/v1'),
  RESELLER_API_KEY: z.string(),
  RESELLER_PRODUCT_ID: int().positive(),
  RESELLER_MOCK: bool(false),
  // Used instead of RESELLER_BASE_URL when RESELLER_MOCK=true (npm run mock:reseller).
  RESELLER_MOCK_URL: z.url().default('http://127.0.0.1:4010/api/reseller/v1'),

  GROQ_API_KEY: z.string(),
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  GROQ_FALLBACK_MODELS: csv().default([]),

  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'expected a postgres:// connection string'),

  UNIT_PRICE_NGN: int().positive().default(3500),
  MAX_QTY_PER_ORDER: int().positive().default(10),
  LOW_BALANCE_ORDERS: int().min(0).default(5),
  // International format without +, for wa.me links. Buyers see the local form (08087357158).
  SUPPORT_WHATSAPP_INTL: z
    .string()
    .regex(/^[1-9]\d{9,14}$/, 'expected digits in international format, like 2348087357158')
    .default('2348087357158'),
  // Minutes after delivery before the one "did you activate your link?" reminder.
  REMINDER_DELAY_MINUTES: int().min(1).default(180),

  ALERT_EMAIL: z.email().default('hello@samkiel.dev'),
  RESEND_API_KEY: z.string().optional(),
  NTFY_TOPIC: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'expected an ntfy topic name (letters, digits, _ or -)'),

  // ISO time with an explicit offset, e.g. 2026-10-29T19:30:00+01:00. Unset means no cutoff.
  SALES_CUTOFF: z.iso
    .datetime({ offset: true, error: 'expected an ISO time with offset like 2026-10-29T19:30:00+01:00' })
    .transform((s) => new Date(s))
    .optional(),
}).superRefine((env, ctx) => {
  // Sandbox payments must never buy real links, and real payments must never get mock links.
  const livePayments = env.BACHS_SECRET_KEY.startsWith('sk_live_');
  if (livePayments && env.RESELLER_MOCK) {
    ctx.addIssue({
      code: 'custom',
      path: ['RESELLER_MOCK'],
      message: 'must be false with a live Bachs key, or buyers pay real money for mock links',
    });
  }
  if (!livePayments && !env.RESELLER_MOCK) {
    ctx.addIssue({
      code: 'custom',
      path: ['RESELLER_MOCK'],
      message: 'must be true with a Bachs sandbox key, or sandbox payments spend the real reseller balance',
    });
  }
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
    const missing = issue.code === 'invalid_type' && !(key in present);
    const detail = missing ? 'is required but not set' : issue.message;
    return `  - ${key}: ${detail}`;
  });
  throw new ConfigError(
    `Invalid environment configuration:\n${problems.join('\n')}\nSee .env.example for every variable.`,
  );
}

export function botLink(config: Pick<Config, 'TELEGRAM_BOT_USERNAME'>): string {
  return `https://t.me/${config.TELEGRAM_BOT_USERNAME}`;
}

/** 2348087357158 -> 08087357158, the form Nigerian buyers recognise. */
export function localPhone(intl: string): string {
  return intl.startsWith('234') ? `0${intl.slice(3)}` : `+${intl}`;
}

/** Loads .env into process.env if the file exists. Real environment variables win. */
export function loadDotEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
