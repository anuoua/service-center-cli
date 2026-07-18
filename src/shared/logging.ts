import pino, { type Logger } from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export function createLogger(level?: LogLevel | string): Logger {
  return pino({ level: level ?? 'info' }, process.stderr);
}
