/**
 * TRU-NEXUS Configuration
 * Loads and validates system configuration from environment.
 */
import { config as dotenvConfig } from 'dotenv';
import type { TradingMode } from '../engine/types.js';

dotenvConfig();

export interface SystemConfig {
  mode: TradingMode;
  anthropicApiKey: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  dashboardPort: number;
  dashboardSecret: string;
  maxRiskPerTradePct: number;
  killSwitchThresholdPct: number;
  logLevel: string;
  logDir: string;
}

export function loadConfig(): SystemConfig {
  return {
    mode: (process.env.TRADING_MODE as TradingMode) || 'paper',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.1:7b',
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3456', 10),
    dashboardSecret: process.env.DASHBOARD_SECRET || 'change-me',
    maxRiskPerTradePct: parseFloat(process.env.MAX_RISK_PER_TRADE_PCT || '0.5') / 100,
    killSwitchThresholdPct: parseFloat(process.env.KILL_SWITCH_THRESHOLD_PCT || '5') / 100,
    logLevel: process.env.LOG_LEVEL || 'info',
    logDir: process.env.LOG_DIR || './data/logs'
  };
}

export const config = loadConfig();
