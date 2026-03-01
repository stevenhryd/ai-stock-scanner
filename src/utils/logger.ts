/**
 * Logger Utility
 * Simple console-based logger with timestamps and severity levels.
 */

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

function getTimestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: LogLevel, module: string, message: string): string {
  return `[${getTimestamp()}] [${level}] [${module}] ${message}`;
}

export const logger = {
  debug(module: string, message: string, ...args: unknown[]): void {
    console.debug(formatMessage(LogLevel.DEBUG, module, message), ...args);
  },

  info(module: string, message: string, ...args: unknown[]): void {
    console.log(formatMessage(LogLevel.INFO, module, message), ...args);
  },

  warn(module: string, message: string, ...args: unknown[]): void {
    console.warn(formatMessage(LogLevel.WARN, module, message), ...args);
  },

  error(module: string, message: string, ...args: unknown[]): void {
    console.error(formatMessage(LogLevel.ERROR, module, message), ...args);
  },
};

export default logger;
