/**
 * pino redaction paths. Secrets, signatures and activation links must never reach logs.
 * `*.x` matches one level deep, so log objects like { order: { links } } are covered too.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-bachs-signature"]',
  'req.headers["x-bachs-signature-v2"]',
  'req.headers["x-telegram-bot-api-secret-token"]',
  'headers.authorization',
  'headers["x-api-key"]',
  'headers["X-API-Key"]',
  'apiKey',
  'secretKey',
  'token',
  'activationLink',
  'activation_link',
  'link',
  'links',
  'order.value',
  '*.apiKey',
  '*.secretKey',
  '*.token',
  '*.activationLink',
  '*.activation_link',
  '*.link',
  '*.links',
];

export const REDACTED = '[redacted]';
