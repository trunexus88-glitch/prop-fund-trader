/**
 * TRU-NEXUS Intermarket Macro Regime Classifier
 * ═══════════════════════════════════════════════════════════════════════════
 * Maps the DXY/yields/oil macro state to one of five named macro regimes.
 *
 * This is intentionally distinct from the candle-based RegimeClassifier
 * (regime-classifier.ts), which detects trending/ranging/volatile conditions
 * on a single instrument's price series.  That classifier answers "is EURUSD
 * trending on the 5-min chart?" — this one answers "is the global macro
 * environment risk-on or risk-off?"  Both filters run in the signal pipeline,
 * but they operate on completely different inputs.
 *
 * Classification is DETERMINISTIC — zero AI inference.  The rules are
 * deliberately simple (three boolean trend directions → five regimes) so
 * they're auditable and never produce random results.
 */

import type { MacroSnapshot } from '../core/lib/macro-provider.js';
import { signalLogger } from '../utils/logger.js';

// ─── Public Types ────────────────────────────────────────────────────────────

/**
 * Five named macro regimes covering the dominant cross-asset themes.
 *
 * RISK_OFF_STRONG_USD  — Dollar bid, yields rising, commodities falling.
 *                        Safe-haven flows; avoid EUR/GBP longs.
 * RISK_ON_WEAK_USD     — Dollar sold, growth assets & commodities bid.
 *                        Classic growth regime; favour EUR/GBP longs.
 * INFLATIONARY_SHOCK   — Energy/commodity prices surging alongside yields.
 *                        Supply-side shock; careful with equity longs.
 * DEFLATIONARY_FEAR    — Falling yields + falling oil + dollar bid.
 *                        Recession/deflation scare; avoid commodity longs.
 * NEUTRAL              — No dominant macro signal; all directions allowed.
 */
export type MacroRegimeState =
  | 'RISK_OFF_STRONG_USD'
  | 'RISK_ON_WEAK_USD'
  | 'INFLATIONARY_SHOCK'
  | 'DEFLATIONARY_FEAR'
  | 'NEUTRAL';

// ─── Classification Logic ────────────────────────────────────────────────────

/**
 * Classify the macro regime from a MacroSnapshot.
 *
 * Priority ordering (most specific → most general):
 *   1. RISK_OFF_STRONG_USD  — all three drivers agree (most reliable signal)
 *   2. DEFLATIONARY_FEAR    — USD + rates + commodities all pointing deflationary
 *   3. INFLATIONARY_SHOCK   — oil AND yields both rising (supply shock signal)
 *   4. RISK_ON_WEAK_USD     — USD falling + oil rising (growth regime)
 *   5. NEUTRAL              — catch-all
 */
export function classifyMacroRegime(macro: MacroSnapshot): MacroRegimeState {
  const { dxy, yields, oil } = macro;

  const dxyUp     = dxy.trend    === 'UP';
  const dxyDown   = dxy.trend    === 'DOWN';
  const yieldUp   = yields.trend === 'UP';
  const yieldDown = yields.trend === 'DOWN';
  const oilUp     = oil.trend    === 'UP';
  const oilDown   = oil.trend    === 'DOWN';

  // ── 1. RISK_OFF_STRONG_USD ───────────────────────────────────────────────
  // Classic dollar-bid, flight-to-safety environment:
  // USD strengthening + real yields rising + risk assets (oil) selling off
  if (dxyUp && yieldUp && oilDown) {
    return 'RISK_OFF_STRONG_USD';
  }

  // ── 2. DEFLATIONARY_FEAR ─────────────────────────────────────────────────
  // Dollar bid (cash preference) + falling yields (rate cuts priced in)
  // + falling commodity prices → deflation / recession narrative
  if (dxyUp && yieldDown && oilDown) {
    return 'DEFLATIONARY_FEAR';
  }

  // ── 3. INFLATIONARY_SHOCK ─────────────────────────────────────────────────
  // Oil AND yields both surging → supply-side inflation shock.
  // DXY direction is secondary (oil producers' currencies can move either way).
  if (oilUp && yieldUp) {
    return 'INFLATIONARY_SHOCK';
  }

  // ── 4. RISK_ON_WEAK_USD ───────────────────────────────────────────────────
  // Dollar sold + commodities bid → growth optimism / risk-on sentiment.
  // Don't require yields to be up (they may be flat or declining on growth expectations).
  if (dxyDown && oilUp) {
    return 'RISK_ON_WEAK_USD';
  }

  // ── 5. NEUTRAL ───────────────────────────────────────────────────────────
  // No dominant macro narrative — indicators are mixed or flat.
  return 'NEUTRAL';
}

/**
 * Human-readable label for dashboard display.
 */
export function macroRegimeLabel(regime: MacroRegimeState): string {
  switch (regime) {
    case 'RISK_OFF_STRONG_USD':  return 'Risk-Off / Strong USD';
    case 'RISK_ON_WEAK_USD':     return 'Risk-On / Weak USD';
    case 'INFLATIONARY_SHOCK':   return 'Inflationary Shock';
    case 'DEFLATIONARY_FEAR':    return 'Deflationary Fear';
    case 'NEUTRAL':              return 'Neutral';
  }
}

/**
 * Hex colour code for dashboard badge display.
 */
export function macroRegimeColor(regime: MacroRegimeState): string {
  switch (regime) {
    case 'RISK_OFF_STRONG_USD':  return '#ef4444';  // red
    case 'RISK_ON_WEAK_USD':     return '#22c55e';  // green
    case 'INFLATIONARY_SHOCK':   return '#f97316';  // orange
    case 'DEFLATIONARY_FEAR':    return '#6366f1';  // indigo
    case 'NEUTRAL':              return '#94a3b8';  // slate
  }
}

/**
 * Log the active macro regime with DXY/yields/oil drivers for audit trail.
 */
export function logMacroRegime(regime: MacroRegimeState, macro: MacroSnapshot): void {
  signalLogger.info(`[macro-regime] ${regime}`, {
    label:      macroRegimeLabel(regime),
    dxy:        `${macro.dxy.price.toFixed(4)} EMA20=${macro.dxy.ema20.toFixed(4)} trend=${macro.dxy.trend}`,
    yields:     `${macro.yields.price.toFixed(2)}% EMA20=${macro.yields.ema20.toFixed(2)} trend=${macro.yields.trend}`,
    oil:        `$${macro.oil.price.toFixed(2)} EMA20=${macro.oil.ema20.toFixed(2)} trend=${macro.oil.trend}`,
    is_fallback: macro.is_fallback,
  });
}
