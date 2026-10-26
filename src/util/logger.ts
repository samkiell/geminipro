import { pino, type Logger } from 'pino';
import { REDACT_PATHS, REDACTED } from './redact.js';

export type { Logger };

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
}

export function createLogger({ level = 'info', pretty = false }: LoggerOptions = {}): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    ...(pretty && {
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
      },
    }),
  });
}
