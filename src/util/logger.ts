import { pino, type DestinationStream, type Logger } from 'pino';
import { REDACT_PATHS, REDACTED } from './redact.js';

export type { Logger };

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
  /** Where log lines go. Defaults to stdout. */
  destination?: DestinationStream;
  /** Also receives every line at error level and above, already redacted (production alerts). */
  errorStream?: DestinationStream;
}

export function createLogger({ level = 'info', pretty = false, destination, errorStream }: LoggerOptions = {}): Logger {
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
  if (errorStream && !pretty) {
    return pino(
      options,
      pino.multistream([
        { level, stream: destination ?? pino.destination(1) },
        { level: 'error', stream: errorStream },
      ]),
    );
  }
  return destination ? pino(options, destination) : pino(options);
}
