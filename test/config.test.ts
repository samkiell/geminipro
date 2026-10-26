import { describe, expect, it } from 'vitest';
import { botLink, ConfigError, loadConfig, localPhone } from '../src/config.js';

const requiredEnv = {
  PUBLIC_URL: 'https://geminipro.onrender.com',
  TELEGRAM_BOT_TOKEN: '123456789:AAEexampleexampleexampleexample_ab',
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(32),
  ADMIN_TELEGRAM_IDS: '111, 222',
  BACHS_SECRET_KEY: 'sk_sandbox_abc_123',
  RESELLER_API_KEY: 'reseller-key',
  RESELLER_PRODUCT_ID: '1',
  GROQ_API_KEY: 'gsk_example',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db?sslmode=require',
  NTFY_TOPIC: 'samkiel-alerts',
};

// A Bachs sandbox key must be paired with the mock reseller.
const validEnv = { ...requiredEnv, RESELLER_MOCK: 'true' };

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
    expect(config.GROSS_UP).toBe(false);
    expect(config.FEE_PCT).toBe(0.02);
    expect(config.FEE_FLAT).toBe(0);
    expect(config.RESELLER_BASE_URL).toBe('https://api-geminipro.ignorelist.com/api/reseller/v1');
    expect(config.RESELLER_MOCK_URL).toBe('http://127.0.0.1:4010/api/reseller/v1');
    expect(config.GROQ_MODELS).toEqual(['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
    expect(config.LLM_CONCURRENCY).toBe(6);
    expect(config.SUPPORT_WHATSAPP_INTL).toBe('2348087357158');
    expect(localPhone(config.SUPPORT_WHATSAPP_INTL)).toBe('08087357158');
    expect(config.REMINDER_DELAY_MINUTES).toBe(180);
    expect(config.SALES_CUTOFF).toBeUndefined();
    expect(config.RESEND_API_KEY).toBeUndefined();
    expect(config.BACHS_WEBHOOK_SECRET).toBeUndefined();
    expect(config.TELEGRAM_BOT_USERNAME).toBe('geminiprosamkiel_bot');
    expect(botLink(config)).toBe('https://t.me/geminiprosamkiel_bot');
    expect(config.GATE_CHANNEL).toBe('@samkieldevtg');
    expect(config.GATE_CHANNEL_URL).toBe('https://t.me/samkieldevtg');
    expect(config.MESSAGE_EFFECT_CONFETTI).toBe('5046509860389126442');
    expect(config.REFERRAL_THRESHOLD).toBe(3);
    expect(config.REFERRAL_MAX_REWARDS).toBe(3);
    expect(config.BACHS_SESSION_TTL_MINUTES).toBe(15);
  });

  it('accepts a bot username with or without the @', () => {
    expect(loadConfig({ ...validEnv, TELEGRAM_BOT_USERNAME: '@some_other_bot' }).TELEGRAM_BOT_USERNAME).toBe(
      'some_other_bot',
    );
    expect(configError({ ...validEnv, TELEGRAM_BOT_USERNAME: 'no spaces allowed' })).toContain(
      'TELEGRAM_BOT_USERNAME: expected a bot username',
    );
  });

  it('parses lists, booleans and dates', () => {
    const config = loadConfig({
      ...validEnv,
      GROSS_UP: 'true',
      GROQ_MODELS: 'a, b ,,c',
      SALES_CUTOFF: '2026-10-29T19:30:00+01:00',
    });
    expect(config.ADMIN_TELEGRAM_IDS).toEqual([111, 222]);
    expect(config.GROSS_UP).toBe(true);
    expect(config.RESELLER_MOCK).toBe(true);
    expect(config.GROQ_MODELS).toEqual(['a', 'b', 'c']);
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
    for (const key of Object.keys(requiredEnv)) {
      expect(message).toContain(`${key}: is required but not set`);
    }
  });

  it('explains invalid values without echoing them', () => {
    const message = configError({
      ...validEnv,
      BACHS_SECRET_KEY: 'pk_sandbox_publickey',
      GROSS_UP: 'yes',
      ADMIN_TELEGRAM_IDS: 'abc',
    });
    expect(message).toContain('BACHS_SECRET_KEY: expected a secret key');
    expect(message).toContain('GROSS_UP: expected true or false');
    expect(message).toContain('ADMIN_TELEGRAM_IDS');
    expect(message).not.toContain('pk_sandbox_publickey');
  });

  it('refuses a Bachs sandbox key with the real reseller', () => {
    const message = configError({ ...requiredEnv, RESELLER_MOCK: 'false' });
    expect(message).toContain('RESELLER_MOCK: must be true with a Bachs sandbox key');
    expect(configError(requiredEnv)).toContain('RESELLER_MOCK: must be true');
  });

  it('refuses a live Bachs key with the mock reseller', () => {
    const live = { ...requiredEnv, BACHS_SECRET_KEY: 'sk_live_abc_123' };
    expect(configError({ ...live, RESELLER_MOCK: 'true' })).toContain(
      'RESELLER_MOCK: must be false with a live Bachs key',
    );
    expect(loadConfig(live).RESELLER_MOCK).toBe(false);
  });
});
