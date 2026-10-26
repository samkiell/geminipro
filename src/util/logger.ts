import { pino, type DestinationStream, type Logger } from 'pino';
import { REDACT_PATHS, REDACTED } from './redact.js';

export type { Logger };

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
  /** Where log lines go. Defaults to stdout. */
  destination?: DestinationStream;
}

export function createLogger({ level = 'info', pretty = false, destination }: LoggerOptions = {}): Logger {
  const options = {
    level,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    ...(pretty && {
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
      },
    }),
  };
  return destination ? pino(options, destination) : pino(options);
}
