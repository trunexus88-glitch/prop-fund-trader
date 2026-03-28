/**
 * TRU-NEXUS Asset Cluster Map & Regime Gate
 * ═══════════════════════════════════════════════════════════════════════════
 * Groups forex/CFD instruments into four macro-correlated clusters.
 * Each cluster has directional veto rules per macro regime.
 *
 * Two consumer functions:
 *   isDirectionBlocked()           — hard veto (do not trade at all)
 *   getRegimeConfidenceAdjustment()— soft adjustment (±10 confidence points)
 *
 * Rules are intentionally conservative — only veto when the macro alignment
 * is unambiguously opposed to the signal direction.  NEUTRAL regime never
 * blocks anything; FLAT EMA trends produce NEUTRAL → no blocks.
 */

import type { MacroRegimeState } from './macro-regime-classifier.js';
import type { OrderSide } from '../engine/types.js';

// ─── Cluster Types ───────────────────────────────────────────────────────────

/**
 * Asset cluster labels used by the correlation limiter (one trade per cluster)
 * and the regime gate (directional veto per cluster).
 */
export type AssetCluster =
  | 'RISK_ASSETS'      // EUR/GBP/AUD/NZD vs USD — fall in risk-off
  | 'SAFE_HAVENS_USD'  // USDCHF, USDCAD, USDJPY — USD bid in risk-off
  | 'JPY_CROSSES'      // EURJPY, GBPJPY — carry trade; fall in risk-off
  | 'COMMODITIES'      // XAUUSD, XAGUSD, USOIL — fall in deflation
  | 'CRYPTO'           // BTCUSD, ETHUSD — not macro-correlated
  | 'INDICES'          // US30, NAS100, SPX500 — fall in risk-off
  | 'UNKNOWN';

// ─── Cluster Mapping ─────────────────────────────────────────────────────────

/**
 * Map an instrument ticker to its asset cluster.
 * Tickers are normalised to uppercase before matching.
 */
export function getCluster(instrument: string): AssetCluster {
  const sym = instrument.toUpperCase();

  if (/^(EURUSD|GBPUSD|AUDUSD|NZDUSD)$/.test(sym)) return 'RISK_ASSETS';
  if (/^(USDCHF|USDCAD|USDJPY)$/.test(sym))         return 'SAFE_HAVENS_USD';
  if (/^(EURJPY|GBPJPY|AUDJPY|CADJPY)$/.test(sym))  return 'JPY_CROSSES';
  if (/^(XAUUSD|XAGUSD|USOIL)$/.test(sym))          return 'COMMODITIES';
  if (/^(BTCUSD|ETHUSD)$/.test(sym))                return 'CRYPTO';
  if (/^(US30|NAS100|SPX500)$/.test(sym))            return 'INDICES';

  return 'UNKNOWN';
}

// ─── Regime Gate ─────────────────────────────────────────────────────────────

/**
 * Returns true if the macro regime makes this trade direction inadvisable.
 *
 * Hard block — the signal should be discarded, not just penalised.
 * The logic reflects textbook macro/FX relationships:
 *
 * RISK_OFF_STRONG_USD:
 *   • RISK_ASSETS   — don't BUY EUR/GBP (USD is bid)
 *   • SAFE_HAVENS_USD — don't SELL USDCHF/USDJPY (USD is bid)
 *   • JPY_CROSSES   — don't BUY EURJPY/GBPJPY (JPY safe-haven bid)
 *   • COMMODITIES   — don't BUY oil/silver (risk-off = commodity selling)
 *                     Gold exception: XAU is itself a safe-haven, allow BUYs
 *   • INDICES       — don't BUY (equity risk-off selloff)
 *
 * RISK_ON_WEAK_USD:
 *   • RISK_ASSETS   — don't SELL EUR/GBP (USD is weak)
 *   • SAFE_HAVENS_USD — don't BUY USDCHF/USDJPY (USD is weak)
 *   • JPY_CROSSES   — don't SELL EURJPY (carry trade in favour)
 *
 * INFLATIONARY_SHOCK:
 *   • INDICES       — don't BUY (margins squeezed by input costs)
 *
 * DEFLATIONARY_FEAR:
 *   • RISK_ASSETS   — don't BUY (demand destruction → EUR/GBP weak)
 *   • COMMODITIES   — don't BUY (deflation = commodity weakness)
 *   • INDICES       — don't BUY (deflation = earnings contraction)
 *   • JPY_CROSSES   — don't BUY (JPY safe-haven bid in deflation)
 *
 * NEUTRAL: nothing is blocked.
 */
export function isDirectionBlocked(
  instrument: string,
  direction: OrderSide,
  regime: MacroRegimeState,
): boolean {
  if (regime === 'NEUTRAL') return false;

  const cluster = getCluster(instrument);
  const sym = instrument.toUpperCase();

  switch (cluster) {
    // ── RISK_ASSETS (EUR/GBP/AUD/NZD vs USD) ───────────────────────────────
    case 'RISK_ASSETS':
      if (regime === 'RISK_OFF_STRONG_USD' && direction === 'buy')  return true;
      if (regime === 'DEFLATIONARY_FEAR'   && direction === 'buy')  return true;
      if (regime === 'RISK_ON_WEAK_USD'    && direction === 'sell') return true;
      break;

    // ── SAFE_HAVENS_USD (USDCHF, USDCAD, USDJPY) ───────────────────────────
    case 'SAFE_HAVENS_USD':
      if (regime === 'RISK_OFF_STRONG_USD' && direction === 'sell') return true;
      if (regime === 'DEFLATIONARY_FEAR'   && direction === 'sell') return true;
      if (regime === 'RISK_ON_WEAK_USD'    && direction === 'buy')  return true;
      break;

    // ── JPY_CROSSES (EURJPY, GBPJPY — carry trade) ──────────────────────────
    case 'JPY_CROSSES':
      if (regime === 'RISK_OFF_STRONG_USD' && direction === 'buy')  return true;
      if (regime === 'DEFLATIONARY_FEAR'   && direction === 'buy')  return true;
      if (regime === 'RISK_ON_WEAK_USD'    && direction === 'sell') return true;
      break;

    // ── COMMODITIES (XAUUSD, XAGUSD, USOIL) ────────────────────────────────
    case 'COMMODITIES':
      // Gold (XAUUSD) is also a safe-haven — allow buying in risk-off
      if (regime === 'RISK_OFF_STRONG_USD' && direction === 'buy' && sym !== 'XAUUSD') {
        return true;
      }
      if (regime === 'DEFLATIONARY_FEAR'   && direction === 'buy')  return true;
      break;

    // ── INDICES (US30, NAS100, SPX500) ──────────────────────────────────────
    case 'INDICES':
      if (regime === 'RISK_OFF_STRONG_USD' && direction === 'buy')  return true;
      if (regime === 'DEFLATIONARY_FEAR'   && direction === 'buy')  return true;
      if (regime === 'INFLATIONARY_SHOCK'  && direction === 'buy')  return true;
      break;

    // ── CRYPTO, UNKNOWN ─────────────────────────────────────────────────────
    case 'CRYPTO':
    case 'UNKNOWN':
      // Crypto is not reliably macro-correlated; unknowns pass through
      break;
  }

  return false;
}

// ─── Confidence Adjustment ───────────────────────────────────────────────────

/**
 * Returns a confidence adjustment in points (−10, 0, or +10).
 *
 *  +10 — signal direction is regime-aligned (macro tailwind)
 *    0 — regime is NEUTRAL, or direction is neither helped nor hurt
 *  −10 — signal direction is contra-regime (macro headwind; will also be
 *         filtered by isDirectionBlocked, so this mainly fires for edge cases)
 */
export function getRegimeConfidenceAdjustment(
  instrument: string,
  direction: OrderSide,
  regime: MacroRegimeState,
): number {
  if (regime === 'NEUTRAL') return 0;

  // Blocked direction = headwind penalty
  if (isDirectionBlocked(instrument, direction, regime)) return -10;

  // If the OPPOSITE direction would be blocked, our direction is regime-aligned
  const opposite: OrderSide = direction === 'buy' ? 'sell' : 'buy';
  if (isDirectionBlocked(instrument, opposite, regime)) return +10;

  return 0;
}
