/**
 * TRU-NEXUS Overnight Baseliner — Layer A
 * ═══════════════════════════════════════════════════════════════════════════
 * Evaluated once per day at 00:00 UTC.  For each instrument, looks at the
 * last 24 h of closed trades and decides whether that instrument should be
 * enabled or disabled for the next 24 h.
 *
 * Disable criteria (ANY one is sufficient):
 *   • Win rate  < 45%
 *   • Profit factor < 1.5
 *   • Net P&L < 0
 *
 * State is persisted per-instrument to data/baseline-{instrument}.json so it
 * survives process restarts.  A missing file means "enabled" (safe default).
 *
 * The baseliner only DISABLES — it never force-enables an instrument that was
 * disabled by external means (kill switch lockout, etc.).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ClosedTrade, OrderSide } from './types.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const DATA_DIR   = join(__dirname, '../../data');

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface BaselineState {
  instrument:     string;
  enabled:        boolean;
  evaluatedAt:    string;          // ISO timestamp of last evaluation
  wins:           number;
  losses:         number;
  winRate:        number;          // 0–1
  profitFactor:   number;          // gross wins / gross losses; Infinity if no losses
  netPnL:         number;          // sum of realized_pnl in the evaluation window
  tradeCount:     number;
  disableReason?: string;          // set when enabled = false
}

// ─── Thresholds ──────────────────────────────────────────────────────────────

const WIN_RATE_FLOOR    = 0.45;
const PROFIT_FACTOR_FLOOR = 1.5;

// ─── Core Computation ─────────────────────────────────────────────────────────

/**
 * Evaluate a single instrument against its recent closed trades.
 * Only trades whose `closed_at` falls within the last 24 h are counted.
 *
 * @param instrument  e.g. 'EURUSD'
 * @param trades      Full array of ClosedTrade — filtered here by recency
 * @param windowHours How far back to look (default 24 h)
 */
export function computeBaseline(
  instrument: string,
  trades: ClosedTrade[],
  windowHours = 24
): BaselineState {
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000;

  const recent = trades.filter(
    t => t.instrument === instrument && new Date(t.closed_at).getTime() >= cutoff
  );

  // Not enough data — keep enabled, nothing to act on
  if (recent.length === 0) {
    return {
      instrument,
      enabled:     true,
      evaluatedAt: new Date().toISOString(),
      wins:        0,
      losses:      0,
      winRate:     1,
      profitFactor: Infinity,
      netPnL:      0,
      tradeCount:  0,
    };
  }

  let wins = 0;
  let losses = 0;
  let grossWins = 0;
  let grossLosses = 0;
  let netPnL = 0;

  for (const t of recent) {
    netPnL += t.realized_pnl;
    if (t.realized_pnl > 0) {
      wins++;
      grossWins += t.realized_pnl;
    } else {
      losses++;
      grossLosses += Math.abs(t.realized_pnl);
    }
  }

  const winRate      = recent.length > 0 ? wins / recent.length : 1;
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : Infinity;

  // ── Disable criteria ────────────────────────────────────────────────────────
  const reasons: string[] = [];
  if (winRate < WIN_RATE_FLOOR)
    reasons.push(`WR ${(winRate * 100).toFixed(1)}% < ${WIN_RATE_FLOOR * 100}%`);
  if (profitFactor < PROFIT_FACTOR_FLOOR && profitFactor !== Infinity)
    reasons.push(`PF ${profitFactor.toFixed(2)} < ${PROFIT_FACTOR_FLOOR}`);
  if (netPnL < 0)
    reasons.push(`net P&L $${netPnL.toFixed(2)} < 0`);

  const enabled = reasons.length === 0;

  const state: BaselineState = {
    instrument,
    enabled,
    evaluatedAt: new Date().toISOString(),
    wins,
    losses,
    winRate,
    profitFactor,
    netPnL,
    tradeCount: recent.length,
    ...(enabled ? {} : { disableReason: reasons.join('; ') }),
  };

  if (!enabled) {
    logger.warn(`[baseliner] ${instrument} DISABLED for next 24h`, {
      winRate:      (winRate * 100).toFixed(1) + '%',
      profitFactor: profitFactor === Infinity ? '∞' : profitFactor.toFixed(2),
      netPnL:       netPnL.toFixed(2),
      reason:       state.disableReason,
    });
  } else {
    logger.debug(`[baseliner] ${instrument} ENABLED`, {
      trades: recent.length,
      winRate: (winRate * 100).toFixed(1) + '%',
    });
  }

  return state;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function baselinePath(instrument: string): string {
  return join(DATA_DIR, `baseline-${instrument}.json`);
}

export function loadBaseline(instrument: string): BaselineState | null {
  const path = baselinePath(instrument);
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BaselineState;
  } catch {
    logger.warn(`[baseliner] Failed to load ${path} — treating as enabled`);
    return null;
  }
}

export function saveBaseline(instrument: string, state: BaselineState): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(baselinePath(instrument), JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Quick read-only check — returns `true` if the instrument is allowed to trade.
 * Missing baseline file → enabled (safe default).
 */
export function isBaselineEnabled(instrument: string): boolean {
  const state = loadBaseline(instrument);
  if (!state) return true;

  // Stale baseline (>25h old) → treat as enabled so the system doesn't stay
  // locked indefinitely if the midnight runner missed a cycle.
  const ageHours = (Date.now() - new Date(state.evaluatedAt).getTime()) / 3_600_000;
  if (ageHours > 25) return true;

  return state.enabled;
}

/**
 * Run the full baseliner pass for a list of instruments.
 * Call this once at 00:00 UTC.
 */
export function runOvernightBaseliner(
  instruments: string[],
  allTrades: ClosedTrade[]
): Map<string, BaselineState> {
  const results = new Map<string, BaselineState>();

  for (const instrument of instruments) {
    const state = computeBaseline(instrument, allTrades);
    saveBaseline(instrument, state);
    results.set(instrument, state);
  }

  const enabledCount  = [...results.values()].filter(s => s.enabled).length;
  const disabledCount = instruments.length - enabledCount;

  logger.info(`[baseliner] Overnight pass complete`, {
    instruments: instruments.length,
    enabled:     enabledCount,
    disabled:    disabledCount,
  });

  return results;
}
