/**
 * TRU-NEXUS Logger
 * Structured logging with Winston for trade audit trails.
 */
import { createLogger, format, transports } from 'winston';
import path from 'path';

const LOG_DIR = process.env.LOG_DIR || './data/logs';

export const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: 'tru-nexus' },
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message, service, ...meta }) => {
          const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [${service}] ${level}: ${message}${metaStr}`;
        })
      )
    }),
    new transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5
    }),
    new transports.File({
      filename: path.join(LOG_DIR, 'trades.log'),
      level: 'info',
      maxsize: 50 * 1024 * 1024,
      maxFiles: 10
    })
  ]
});

/** Specialized trade logger for audit trail */
export const tradeLogger = logger.child({ component: 'trade-engine' });

/** Specialized risk logger */
export const riskLogger = logger.child({ component: 'risk-engine' });

/** Specialized signal logger */
export const signalLogger = logger.child({ component: 'signal-layer' });
