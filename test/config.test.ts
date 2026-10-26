import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const validEnv = {
  PUBLIC_URL: 'https://geminipro.onrender.com',
  TELEGRAM_BOT_TOKEN: '123456789:AAEexampleexampleexampleexample_ab',
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(32),
  ADMIN_TELEGRAM_IDS: '111, 222',
  PAYSTACK_SECRET_KEY: 'sk_test_abc123',
  RESELLER_API_KEY: 'reseller-key',
  RESELLER_PRODUCT_ID: '1',
  GROQ_API_KEY: 'gsk_example',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db?sslmode=require',
  NTFY_TOPIC: 'samkiel-alerts',
};

function configError(env: Record<string, string>): string {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).message;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('applies defaults for optional values', () => {
    const config = loadConfig(validEnv);
    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
    expect(config.UNIT_PRICE_NGN).toBe(3500);
    expect(config.MAX_QTY_PER_ORDER).toBe(10);
    expect(config.LOW_BALANCE_ORDERS).toBe(5);
    expect(config.GROSS_UP).toBe(true);
    expect(config.FEE_PCT).toBe(0.015);
    expect(config.FEE_FLAT).toBe(100);
    expect(config.RESELLER_MOCK).toBe(false);
    expect(config.RESELLER_BASE_URL).toBe('https://api-geminipro.ignorelist.com/api/reseller/v1');
    expect(config.GROQ_MODEL).toBe('openai/gpt-oss-120b');
    expect(config.GROQ_FALLBACK_MODELS).toEqual([]);
    expect(config.SUPPORT_WHATSAPP).toBe('08087357158');
    expect(config.SALES_CUTOFF).toBeUndefined();
    expect(config.RESEND_API_KEY).toBeUndefined();
  });

  it('parses lists, booleans and dates', () => {
    const config = loadConfig({
      ...validEnv,
      GROSS_UP: 'false',
      RESELLER_MOCK: 'true',
      GROQ_FALLBACK_MODELS: 'a, b ,,c',
      SALES_CUTOFF: '2026-10-29T19:30:00+01:00',
    });
    expect(config.ADMIN_TELEGRAM_IDS).toEqual([111, 222]);
    expect(config.GROSS_UP).toBe(false);
    expect(config.RESELLER_MOCK).toBe(true);
    expect(config.GROQ_FALLBACK_MODELS).toEqual(['a', 'b', 'c']);
    expect(config.SALES_CUTOFF?.toISOString()).toBe('2026-10-29T18:30:00.000Z');
  });

  it('treats blank values as unset', () => {
    const config = loadConfig({ ...validEnv, SALES_CUTOFF: '', RESEND_API_KEY: '  ', PORT: '' });
    expect(config.SALES_CUTOFF).toBeUndefined();
    expect(config.RESEND_API_KEY).toBeUndefined();
    expect(config.PORT).toBe(3000);
  });

  it('lists every missing required variable', () => {
    const message = configError({});
    for (const key of Object.keys(validEnv)) {
      expect(message).toContain(`${key}: is required but not set`);
    }
  });

  it('explains invalid values without echoing them', () => {
    const message = configError({
      ...validEnv,
      PAYSTACK_SECRET_KEY: 'pk_test_publickey',
      GROSS_UP: 'yes',
      ADMIN_TELEGRAM_IDS: 'abc',
    });
    expect(message).toContain('PAYSTACK_SECRET_KEY: expected a secret key');
    expect(message).toContain('GROSS_UP: expected true or false');
    expect(message).toContain('ADMIN_TELEGRAM_IDS');
    expect(message).not.toContain('pk_test_publickey');
  });
});
