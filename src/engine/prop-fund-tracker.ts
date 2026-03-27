/**
 * TRU-NEXUS Prop Fund Daily Tracker
 * ═══════════════════════════════════════════════════════════════════════════
 * Persists daily summaries to data/prop-fund-tracker.json.
 * Used to determine "READY" status after the 2-week paper trading period.
 *
 * "READY" when ALL of the following are true after 10+ trading days:
 *   ✓ Net profitable (sum of all daily P&Ls > 0)
 *   ✓ Daily loss limit never breached
 *   ✓ Trailing drawdown limit never breached
 *   ✓ Consistency rule satisfied across all days
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import {
  PROP_FUND_RULES,
  checkConsistency,
  type PropFundRules,
} from './prop-fund-rules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DailyRecord {
  day: string;                   // ISO date "2026-03-27"
  startEquity: number;
  endEquity: number;
  dailyPnL: number;
  dailyPnLPct: number;
  peakEquity: number;
  drawdownFromPeakPct: number;
  tradesOpened: number;
  tradesClosed: number;
  wins: number;
  losses: number;
  dailyLossLimitBreached: boolean;
  drawdownLimitBreached: boolean;
  consistencyOk: boolean;
}

export type ReadinessStatus = 'READY' | 'NOT READY' | 'AT RISK';

export interface PropFundReadiness {
  daysTracked: number;
  totalPnL: number;
  netProfitable: boolean;
  peakEquity: number;
  currentEquity: number;
  drawdownFromPeakPct: number;
  todayPnL: number;
  todayPnLPct: number;
  dailyLimitUsedPct: number;        // 0-1
  drawdownUsedPct: number;          // 0-1
  dailyLimitBreachedEver: boolean;
  drawdownLimitBreachedEver: boolean;
  consistencyStatus: 'ok' | 'warning' | 'breach';
  status: ReadinessStatus;
  history: DailyRecord[];
}

// ─── Tracker ─────────────────────────────────────────────────────────────────

const TRACKER_PATH = join(__dirname, '../../data/prop-fund-tracker.json');
const MIN_DAYS_FOR_READY = 10;

export class PropFundTracker {
  private rules: PropFundRules;
  private history: DailyRecord[] = [];

  constructor(rules: PropFundRules = PROP_FUND_RULES) {
    this.rules = rules;
    this.load();
  }

  /**
   * Record end-of-day summary. Called during the daily 22:00 UTC review.
   */
  recordDay(record: DailyRecord): void {
    // Prevent duplicate entries for the same day
    const existingIdx = this.history.findIndex(r => r.day === record.day);
    if (existingIdx >= 0) {
      this.history[existingIdx] = record;
    } else {
      this.history.push(record);
    }

    // Sort chronologically
    this.history.sort((a, b) => a.day.localeCompare(b.day));
    this.save();

    logger.info(`[PropFundTracker] Day recorded: ${record.day}`, {
      pnl: record.dailyPnL.toFixed(2),
      drawdown: (record.drawdownFromPeakPct * 100).toFixed(2) + '%',
      dailyLimitBreached: record.dailyLossLimitBreached,
    });
  }

  /**
   * Get the full readiness assessment based on accumulated history.
   */
  getReadiness(
    currentEquity: number,
    todayPnL: number,
    peakEquity: number
  ): PropFundReadiness {
    const totalPnL = this.history.reduce((s, r) => s + r.dailyPnL, 0);
    const netProfitable = totalPnL > 0;

    const dailyLossDollars = this.rules.accountSize * this.rules.dailyLossLimit;
    const dailyLimitUsedPct = todayPnL < 0
      ? Math.min(1, -todayPnL / dailyLossDollars)
      : 0;

    const drawdownPct = peakEquity > 0
      ? Math.max(0, (peakEquity - currentEquity) / peakEquity)
      : 0;
    const drawdownUsedPct = Math.min(1, drawdownPct / this.rules.maxTrailingDrawdown);

    const dailyLimitBreachedEver = this.history.some(r => r.dailyLossLimitBreached);
    const drawdownLimitBreachedEver = this.history.some(r => r.drawdownLimitBreached);

    const allDailyPnLs = [...this.history.map(r => r.dailyPnL), todayPnL];
    const consistencyStatus = checkConsistency(allDailyPnLs, this.rules);

    const drawdownFromPeakPct = drawdownPct;

    // Determine status
    let status: ReadinessStatus = 'NOT READY';
    if (dailyLimitBreachedEver || drawdownLimitBreachedEver || consistencyStatus === 'breach') {
      status = 'AT RISK';
    } else if (
      this.history.length >= MIN_DAYS_FOR_READY &&
      netProfitable &&
      !dailyLimitBreachedEver &&
      !drawdownLimitBreachedEver
    ) {
      // At this point consistencyStatus is narrowed to 'ok' | 'warning' (not 'breach')
      status = 'READY';
    }

    return {
      daysTracked: this.history.length,
      totalPnL,
      netProfitable,
      peakEquity,
      currentEquity,
      drawdownFromPeakPct,
      todayPnL,
      todayPnLPct: todayPnL / this.rules.accountSize,
      dailyLimitUsedPct,
      drawdownUsedPct,
      dailyLimitBreachedEver,
      drawdownLimitBreachedEver,
      consistencyStatus,
      status,
      history: [...this.history],
    };
  }

  getHistory(): DailyRecord[] {
    return [...this.history];
  }

  // ─── Persistence ───────────────────────────────────────────────────────────

  private load(): void {
    try {
      if (existsSync(TRACKER_PATH)) {
        const raw = readFileSync(TRACKER_PATH, 'utf-8');
        this.history = JSON.parse(raw) as DailyRecord[];
        logger.info(`[PropFundTracker] Loaded ${this.history.length} day(s) of history`);
      }
    } catch (error) {
      logger.warn('[PropFundTracker] Could not load history, starting fresh', { error });
      this.history = [];
    }
  }

  private save(): void {
    try {
      const dir = dirname(TRACKER_PATH);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(TRACKER_PATH, JSON.stringify(this.history, null, 2), 'utf-8');
    } catch (error) {
      logger.error('[PropFundTracker] Failed to save history', { error });
    }
  }
}
