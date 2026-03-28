/**
 * TRU-NEXUS Volatility Engine
 * ═══════════════════════════════════════════════════════════════════════════
 * Computes a multi-timeframe volatility surface that drives ADAPTIVE stop-loss
 * and take-profit multipliers.  Pure function — no state, no I/O.
 *
 * Why multi-timeframe? The 1H ATR tells you how noisy the current candle is.
 * The 4H and daily ATRs anchor that noise against the broader range.
 * The ratio between them reveals whether volatility is expanding, contracting,
 * or accelerating into the current session.
 *
 * Stop/TP multipliers are applied in generateSignalsV2() in place of the
 * hard-coded PROP_FUND_SL_ATR_MULT / PROP_FUND_TP_ATR_MULT constants.
 */

import type { Candle } from './types.js';
import { atr } from '../strategy/indicators.js';

// ─── Public Types ─────────────────────────────────────────────────────────────

export type VolatilityState = 'EXPANDING' | 'CONTRACTING' | 'ACCELERATING' | 'NORMAL';

export interface VolatilitySurface {
  state: VolatilityState;
  /** ATR-14 of the primary (1H) candle series */
  atr1h: number;
  /** ATR-14 of the 4H candle series (estimated as 2×1H if unavailable) */
  atr4h: number;
  /** ATR-14 of the daily candle series (estimated as 6×1H if unavailable) */
  atr1d: number;
  /** Adaptive stop-loss multiplier (ATR units) */
  stopMult: number;
  /** Adaptive take-profit multiplier (ATR units) */
  tpMult: number;
  /**
   * Noise band — price moves within this distance of entry are noise, not signal.
   * Useful for filtering micro-entries that would be immediately stopped.
   */
  noiseBand: number;
}

// ─── Core Computation ─────────────────────────────────────────────────────────

/**
 * Compute the volatility surface from up to three timeframes.
 *
 * Graceful degradation: if 4H or daily candles are absent (provider doesn't
 * support those timeframes), we estimate from 1H ATR using typical scaling
 * ratios (×2 for 4H, ×6 for daily).  The signal still fires; stop distances
 * will be slightly less precise but not dangerously wrong.
 */
export function computeVolatilitySurface(
  candles1h: Candle[],
  candles4h?: Candle[],
  candles1d?: Candle[]
): VolatilitySurface {
  const MIN_CANDLES = 15; // Need at least 15 candles for a meaningful ATR-14

  const atr1h = atr(candles1h, 14);
  const atr4h =
    candles4h && candles4h.length >= MIN_CANDLES ? atr(candles4h, 14) : atr1h * 2;
  const atr1d =
    candles1d && candles1d.length >= MIN_CANDLES ? atr(candles1d, 14) : atr1h * 6;

  // Ratio of intraday noise to daily range
  const ratio = atr1d > 0 ? atr1h / atr1d : 0.5;

  let state: VolatilityState;
  let stopMult: number;
  let tpMult: number;

  if (ratio > 1.5) {
    // Current session is more volatile than usual on a daily basis — widen stops
    state    = 'EXPANDING';    stopMult = 1.5; tpMult = 4.5;
  } else if (ratio < 0.5) {
    // Very quiet / tight market — tighter stops, tighter targets
    state    = 'CONTRACTING';  stopMult = 0.7; tpMult = 2.1;
  } else if (atr1h > atr4h && atr4h > atr1d) {
    // Each shorter timeframe is MORE volatile than the longer one — momentum building
    state    = 'ACCELERATING'; stopMult = 2.0; tpMult = 6.0;
  } else {
    state    = 'NORMAL';       stopMult = 1.0; tpMult = 3.0;
  }

  return {
    state,
    atr1h,
    atr4h,
    atr1d,
    stopMult,
    tpMult,
    noiseBand: atr1h * 0.3,
  };
}
