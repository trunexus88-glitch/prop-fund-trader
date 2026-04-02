/**
 * TRU-NEXUS MTF Confluence Gate — Layer B
 * ═══════════════════════════════════════════════════════════════════════════
 * Checks whether the proposed trade direction is supported across multiple
 * timeframes (1H primary, 4H intermediate, 1D macro).  Uses a fast EMA-20
 * trend proxy to determine the direction on each timeframe.
 *
 * Results drive two outcomes in generateSignalsV2():
 *   CONFLICT      → hard reject (return [])
 *   PARTIAL_ALIGN → soft penalty in meta-confidence (-0.05 confidence pts)
 *   FULL_ALIGN    → bonus in meta-confidence (+0.08 confidence pts)
 *
 * The gate is explicitly additive — it never overrides the state engine's
 * primary scoring, it only weights it up or down based on timeframe consensus.
 */

import type { Candle, OrderSide } from './types.js';

// ─── Public Types ─────────────────────────────────────────────────────────────

export type MTFAlignment = 'FULL_ALIGN' | 'PARTIAL_ALIGN' | 'CONFLICT';

export interface MTFConfluenceResult {
  /** Final alignment verdict */
  alignment: MTFAlignment;
  /**
   * Meta-confidence delta to ADD to the base confidence.
   *   FULL_ALIGN    → +0.08
   *   PARTIAL_ALIGN →  0.00
   *   CONFLICT      → -0.10
   */
  confidenceDelta: number;
  alignedTimeframes:   number;    // out of the available count (1–3)
  conflictTimeframes:  number;
  availableTimeframes: number;
  /** Human-readable per-TF summary */
  details: string[];
}

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIDENCE_DELTAS: Record<MTFAlignment, number> = {
  FULL_ALIGN:    0.08,
  PARTIAL_ALIGN: 0.00,
  CONFLICT:     -0.10,
};

// ─── EMA Helper ───────────────────────────────────────────────────────────────

/**
 * Compute a simple EMA from a candle array (uses closing prices).
 * Returns NaN if there are fewer candles than the period.
 */
function ema(candles: Candle[], period: number): number {
  if (candles.length < period) return NaN;

  const k = 2 / (period + 1);
  let value = candles[0].close;

  for (let i = 1; i < candles.length; i++) {
    value = candles[i].close * k + value * (1 - k);
  }

  return value;
}

/**
 * Determine the dominant trend direction for a set of candles.
 * Returns 'LONG' if close > EMA-20, 'SHORT' if close < EMA-20, null if
 * insufficient candles.
 */
function trendDirection(candles: Candle[]): 'LONG' | 'SHORT' | null {
  if (candles.length < 5) return null;   // absolute minimum

  const period = Math.min(20, candles.length);
  const ema20  = ema(candles, period);

  if (isNaN(ema20)) return null;

  const lastClose = candles[candles.length - 1].close;
  return lastClose > ema20 ? 'LONG' : 'SHORT';
}

// ─── Core Computation ─────────────────────────────────────────────────────────

/**
 * Evaluate multi-timeframe confluence for a proposed trade direction.
 *
 * @param side       'buy' (LONG) or 'sell' (SHORT) proposed by the Analyst
 * @param candles1h  1H candle array (primary timeframe, required)
 * @param candles4h  4H candle array (intermediate, optional)
 * @param candles1d  1D candle array (macro, optional)
 */
export function computeMTFConfluence(
  side: OrderSide,
  candles1h: Candle[],
  candles4h?: Candle[],
  candles1d?: Candle[]
): MTFConfluenceResult {
  const proposedDir: 'LONG' | 'SHORT' = side === 'buy' ? 'LONG' : 'SHORT';
  const details: string[] = [];

  let available  = 0;
  let aligned    = 0;
  let conflicting = 0;

  // ── 1H (primary) ─────────────────────────────────────────────────────────
  const dir1h = trendDirection(candles1h);
  if (dir1h !== null) {
    available++;
    if (dir1h === proposedDir) {
      aligned++;
      details.push(`1H: ${dir1h} ✓`);
    } else {
      conflicting++;
      details.push(`1H: ${dir1h} ✗`);
    }
  } else {
    details.push('1H: insufficient data');
  }

  // ── 4H (intermediate) ────────────────────────────────────────────────────
  if (candles4h && candles4h.length >= 5) {
    const dir4h = trendDirection(candles4h);
    if (dir4h !== null) {
      available++;
      if (dir4h === proposedDir) {
        aligned++;
        details.push(`4H: ${dir4h} ✓`);
      } else {
        conflicting++;
        details.push(`4H: ${dir4h} ✗`);
      }
    } else {
      details.push('4H: insufficient data');
    }
  } else {
    details.push('4H: not available (skipped)');
  }

  // ── 1D (macro) ────────────────────────────────────────────────────────────
  if (candles1d && candles1d.length >= 5) {
    const dir1d = trendDirection(candles1d);
    if (dir1d !== null) {
      available++;
      if (dir1d === proposedDir) {
        aligned++;
        details.push(`1D: ${dir1d} ✓`);
      } else {
        conflicting++;
        details.push(`1D: ${dir1d} ✗`);
      }
    } else {
      details.push('1D: insufficient data');
    }
  } else {
    details.push('1D: not available (skipped)');
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  // Only possible when the primary 1H TF is available.
  // CONFLICT  = majority (>50%) of available TFs oppose the direction.
  // FULL_ALIGN = all available TFs agree.
  // PARTIAL_ALIGN = partial agreement.
  let alignment: MTFAlignment;

  if (available === 0) {
    // No data at all — neutral, no penalty
    alignment = 'PARTIAL_ALIGN';
  } else if (conflicting > aligned) {
    alignment = 'CONFLICT';
  } else if (aligned === available) {
    alignment = 'FULL_ALIGN';
  } else {
    alignment = 'PARTIAL_ALIGN';
  }

  return {
    alignment,
    confidenceDelta:     CONFIDENCE_DELTAS[alignment],
    alignedTimeframes:   aligned,
    conflictTimeframes:  conflicting,
    availableTimeframes: available,
    details,
  };
}
