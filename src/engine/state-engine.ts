/**
 * TRU-NEXUS Continuous State Engine
 * ═══════════════════════════════════════════════════════════════════════════
 * Replaces the legacy discrete point-tallying (buy/sell score 0-100) with a
 * CONTINUOUS state score from -1.0 (max bearish) to +1.0 (max bullish).
 *
 * Why continuous? The old scorer had cliff edges: adding one indicator
 * component could jump confidence by 15 points regardless of magnitude.
 * A continuous score reflects STRENGTH: an RSI of 28 is more bearish than
 * an RSI of 32 — the old scorer treated them identically (both "oversold").
 *
 * Component weights (each ±0.25, summing to ±1.0):
 *   RSI deviation   — how far RSI has moved from the neutral 50 line
 *   MACD histogram  — ATR-normalised histogram magnitude (momentum)
 *   BB position     — where price sits within the Bollinger Band channel
 *   MACD crossover  — ATR-normalised MACD line vs signal gap (trend alignment)
 *
 * All components are clamped to [-1, +1] before weighting so a single
 * extreme reading can't overwhelm the others.
 */

import type { IndicatorSnapshot } from './types.js';

// ─── Public Types ─────────────────────────────────────────────────────────────

export type StateLabel = 'STRONG_BULL' | 'BULL' | 'NEUTRAL' | 'BEAR' | 'STRONG_BEAR';
export type TradeDirection = 'LONG' | 'SHORT' | null;

export interface StateResult {
  /** Continuous score −1.0 (max bear) → +1.0 (max bull) */
  score: number;
  label: StateLabel;
  /** |score| — used as the raw confidence seed in meta-confidence */
  absScore: number;
  /** Trade direction implied by the score, null when NEUTRAL */
  direction: TradeDirection;
  /**
   * Probability that the state reverses before the trade plays out.
   * Higher transitionRisk → smaller confidence contribution.
   * STRONG states = low risk (0.15), NEUTRAL = high risk (0.50).
   */
  transitionRisk: number;
  components: {
    rsi: number;
    macdHist: number;
    bbPosition: number;
    macdCross: number;
  };
}

// ─── Core Computation ─────────────────────────────────────────────────────────

export function computeStateScore(ind: IndicatorSnapshot, close: number): StateResult {
  let score = 0;

  // ── Component 1: RSI deviation from neutral ──────────────────────────────
  // Only contributes when RSI has moved meaningfully from 50 (>25% deviation).
  // rsiDev is -1 (RSI=0) to +1 (RSI=100); at RSI=30 it's -0.40.
  const rsiDev = (ind.rsi_14 - 50) / 50;
  let rsiComponent = 0;
  if (Math.abs(rsiDev) > 0.25) {
    rsiComponent = 0.25 * rsiDev;
    score += rsiComponent;
  }

  // ── Component 2: MACD histogram (momentum) ───────────────────────────────
  // Normalised by ATR so it's instrument-agnostic.  Capped at ±1 when the
  // histogram is ≥50% of ATR in either direction.
  let macdHistComponent = 0;
  if (ind.atr_14 > 0 && !isNaN(ind.macd_histogram)) {
    const macdNorm = ind.macd_histogram / ind.atr_14;
    macdHistComponent = 0.25 * Math.max(-1, Math.min(1, macdNorm / 0.5));
    score += macdHistComponent;
  }

  // ── Component 3: Bollinger Band position ─────────────────────────────────
  // Continuous position from -0.25 (at lower band) to +0.25 (at upper band).
  // bbPos = 0 at lower band, 0.5 at middle, 1.0 at upper band.
  const bbRange = (ind.bollinger_upper - ind.bollinger_lower) || 1;
  const bbPos = (close - ind.bollinger_lower) / bbRange;
  const bbComponent = 0.25 * (bbPos * 2 - 1);
  score += bbComponent;

  // ── Component 4: MACD line vs signal (crossover strength) ────────────────
  // Normalised by ATR.  Positive when MACD line is above signal line.
  // Capped at ±1 when the gap exceeds 30% of ATR.
  let macdCrossComponent = 0;
  if (ind.atr_14 > 0 && !isNaN(ind.macd_value) && !isNaN(ind.macd_signal)) {
    const crossDiff = (ind.macd_value - ind.macd_signal) / ind.atr_14;
    macdCrossComponent = 0.25 * Math.max(-1, Math.min(1, crossDiff / 0.3));
    score += macdCrossComponent;
  }

  // ── Clamp and label ───────────────────────────────────────────────────────
  score = Math.max(-1, Math.min(1, score));
  const absScore = Math.abs(score);

  let label: StateLabel;
  let transitionRisk: number;

  if (absScore > 0.6) {
    label = score > 0 ? 'STRONG_BULL' : 'STRONG_BEAR';
    transitionRisk = 0.15;
  } else if (absScore > 0.3) {
    label = score > 0 ? 'BULL' : 'BEAR';
    transitionRisk = 0.30;
  } else {
    label          = 'NEUTRAL';
    transitionRisk = 0.50;
  }

  const direction: TradeDirection =
    score > 0.1 ? 'LONG' : score < -0.1 ? 'SHORT' : null;

  return {
    score,
    label,
    absScore,
    direction,
    transitionRisk,
    components: {
      rsi:        parseFloat(rsiComponent.toFixed(4)),
      macdHist:   parseFloat(macdHistComponent.toFixed(4)),
      bbPosition: parseFloat(bbComponent.toFixed(4)),
      macdCross:  parseFloat(macdCrossComponent.toFixed(4)),
    },
  };
}
