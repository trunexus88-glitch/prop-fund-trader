/**
 * TRU-NEXUS Historical Confidence Enrichment — Layer C
 * ═══════════════════════════════════════════════════════════════════════════
 * Looks at the system's own paper-trade history to answer:
 * "Have similar setups on this instrument in this direction worked before?"
 *
 * Matching criteria:
 *   • Same instrument
 *   • Same direction (buy / sell)
 *   • Within the lookback window (default: last 50 closed trades)
 *
 * Adjustment applied to meta-confidence:
 *   • WR ≥ 60%  → +0.05 (historical edge confirmed)
 *   • WR 45–59% →  0.00 (neutral, insufficient edge)
 *   • WR < 45%  → -0.10 (historical warning)
 *   • < MIN_SAMPLE trades → 0.00 (not enough data to judge)
 *
 * This layer is intentionally conservative: it only penalises setups with a
 * clear negative history.  It does NOT block signals — the meta-confidence
 * tier system and the MTF gate handle suppression.
 */

import type { ClosedTrade, OrderSide } from './types.js';
import { signalLogger } from '../utils/logger.js';

// ─── Public Types ─────────────────────────────────────────────────────────────

export type HistoricalSignal = 'BOOST' | 'NEUTRAL' | 'PENALTY';

export interface HistoricalConfidenceResult {
  /** Confidence delta to ADD to the current meta-confidence value */
  confidenceDelta: number;
  signal:          HistoricalSignal;
  winRate:         number;          // 0–1 (0 if no data)
  sampleSize:      number;          // matched trade count
  avgRR:           number;          // average realised R:R (approx from SL/TP)
}

// ─── Thresholds ──────────────────────────────────────────────────────────────

const MIN_SAMPLE     = 5;    // need at least this many trades before adjusting
const WIN_RATE_BOOST  = 0.60;
const WIN_RATE_PENALTY = 0.45;

const DELTA_BOOST   =  0.05;
const DELTA_PENALTY = -0.10;

// ─── Core Computation ─────────────────────────────────────────────────────────

/**
 * Compute a historical confidence adjustment for the given instrument+side.
 *
 * @param instrument    e.g. 'EURUSD'
 * @param side          'buy' | 'sell'
 * @param allTrades     Full ClosedTrade array (from account state or persistence)
 * @param lookback      Max number of recent matched trades to consider
 */
export function computeHistoricalConfidence(
  instrument: string,
  side: OrderSide,
  allTrades: ClosedTrade[],
  lookback = 50
): HistoricalConfidenceResult {
  // Filter to matching instrument + direction, most recent first
  const matched = allTrades
    .filter(t => t.instrument === instrument && t.side === side)
    .sort((a, b) => new Date(b.closed_at).getTime() - new Date(a.closed_at).getTime())
    .slice(0, lookback);

  if (matched.length < MIN_SAMPLE) {
    return {
      confidenceDelta: 0,
      signal:          'NEUTRAL',
      winRate:         0,
      sampleSize:      matched.length,
      avgRR:           0,
    };
  }

  // ── Win rate ─────────────────────────────────────────────────────────────
  const wins = matched.filter(t => t.realized_pnl > 0).length;
  const winRate = wins / matched.length;

  // ── Approximate average R:R from actual P&L vs. stop distance ───────────
  // Use the ratio of average win size to average loss size as a proxy.
  const winPnLs  = matched.filter(t => t.realized_pnl > 0).map(t => t.realized_pnl);
  const lossPnLs = matched.filter(t => t.realized_pnl < 0).map(t => Math.abs(t.realized_pnl));

  const avgWin  = winPnLs.length  > 0 ? winPnLs.reduce((a, b) => a + b, 0)  / winPnLs.length  : 0;
  const avgLoss = lossPnLs.length > 0 ? lossPnLs.reduce((a, b) => a + b, 0) / lossPnLs.length : 1;
  const avgRR   = avgLoss > 0 ? parseFloat((avgWin / avgLoss).toFixed(2)) : 0;

  // ── Adjustment ─────────────────────────────────────────────────────────
  let signal: HistoricalSignal;
  let confidenceDelta: number;

  if (winRate >= WIN_RATE_BOOST) {
    signal          = 'BOOST';
    confidenceDelta = DELTA_BOOST;
  } else if (winRate < WIN_RATE_PENALTY) {
    signal          = 'PENALTY';
    confidenceDelta = DELTA_PENALTY;
  } else {
    signal          = 'NEUTRAL';
    confidenceDelta = 0;
  }

  signalLogger.debug('[hist-conf] Historical confidence computed', {
    instrument,
    side,
    sampleSize: matched.length,
    winRate:    (winRate * 100).toFixed(1) + '%',
    avgRR:      avgRR.toFixed(2),
    signal,
    delta:      confidenceDelta,
  });

  return {
    confidenceDelta,
    signal,
    winRate,
    sampleSize: matched.length,
    avgRR,
  };
}
