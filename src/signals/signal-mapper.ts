/**
 * TRU-NEXUS Signal Mapper
 * ═══════════════════════════════════════════════════════════════════════════
 * Converts a ParsedSignal (from the Telegram parser) into a TradeSignal
 * (the format the AccountManager.routeSignal() expects).
 *
 * The key challenge: our internal TradeSignal has rich indicator_values
 * (RSI, EMAs, ATR, MACD, Bollinger) computed by the signal generator.
 * External signals carry none of that. We fill indicator_values with
 * neutral sentinel values that won't trip indicator-based filters, and
 * derive ATR from the SL distance (which IS available in external signals).
 *
 * ATR proxy: SL distance ÷ PROP_FUND_SL_ATR_MULT (0.5) = implied ATR.
 * This keeps the position sizer consistent with internally generated signals.
 */

import type { TradeSignal, MarketRegime, IndicatorSnapshot } from '../engine/types.js';
import type { ParsedSignal } from './signal-parser.js';

// ─── ATR multiplier used in prop fund mode (must match index.ts) ─────────────
const SL_ATR_MULT = 0.5;

// ─── Pip sizes for instruments we trade ─────────────────────────────────────
const PIP_SIZES: Record<string, number> = {
  EURUSD: 0.0001, GBPUSD: 0.0001, USDJPY: 0.01, USDCHF: 0.0001,
  AUDUSD: 0.0001, NZDUSD: 0.0001, USDCAD: 0.0001,
  GBPJPY: 0.01,   EURJPY: 0.01,   EURGBP: 0.0001,
  XAUUSD: 0.10,   XAGUSD: 0.01,   BTCUSD: 1.00, ETHUSD: 0.10,
  US30: 1.0, NAS100: 0.25, SPX500: 0.25, USOIL: 0.01,
};

// ─── Confidence scoring ──────────────────────────────────────────────────────

/**
 * Assign a confidence score (0-100) to an external signal.
 *
 * Rules:
 * - Base: 60 (external signals from a paid service start with benefit-of-the-doubt)
 * - +10 if R:R ≥ 2.0 (TP is at least 2× the SL distance)
 * - +10 if R:R ≥ 3.0
 * - -10 if entry is a range (less precise)
 * - -10 if R:R < 1.5 (marginal trade)
 * - Clamp to [30, 85] — external signals never get max confidence (100)
 *   because we can't verify indicator alignment
 */
function scoreExternalSignal(parsed: ParsedSignal, rrRatio: number): number {
  let score = 60;
  if (rrRatio >= 3.0) score += 10;
  else if (rrRatio >= 2.0) score += 5;
  else if (rrRatio < 1.5) score -= 10;
  if (parsed.isRangeEntry) score -= 5;
  if (parsed.allTakeProfits.length >= 3) score += 5; // Multi-TP signals are more considered
  return Math.min(85, Math.max(30, score));
}

// ─── Neutral indicator snapshot ──────────────────────────────────────────────

/**
 * Build an IndicatorSnapshot with neutral / non-triggering values.
 * RSI=50 (no overbought/oversold), EMAs priced at entry (no trend signal),
 * ATR derived from SL distance so position sizing stays accurate.
 */
function neutralIndicators(entry: number, atr: number): IndicatorSnapshot {
  return {
    rsi_14: 50,
    ema_9: entry,
    ema_21: entry,
    ema_50: entry,
    ema_200: entry,
    atr_14: atr,
    macd_value: 0,
    macd_signal: 0,
    macd_histogram: 0,
    bollinger_upper: entry + atr * 2,
    bollinger_middle: entry,
    bollinger_lower: entry - atr * 2,
    volume: 500,           // median-ish value — not used for external signals
    support_levels: [entry - atr * 2, entry - atr * 4],
    resistance_levels: [entry + atr * 2, entry + atr * 4],
  };
}

// ─── Regime inference ────────────────────────────────────────────────────────

/**
 * Infer a market regime from the signal's R:R ratio.
 * - High R:R (≥3) usually implies trending market (providers target breakouts)
 * - Low R:R (<2) often implies ranging / mean-reversion setups
 */
function inferRegime(rrRatio: number): MarketRegime {
  if (rrRatio >= 3.0) return 'trending_up'; // Direction is encoded in side, regime is coarse
  if (rrRatio >= 2.0) return 'trending_up';
  return 'ranging';
}

// ─── Main mapper ─────────────────────────────────────────────────────────────

/**
 * Convert a ParsedSignal to a TradeSignal.
 *
 * @param parsed      The signal from the parser
 * @param currentBid  Live bid price (required when parsed.entry === 0 = market)
 * @returns           A fully-populated TradeSignal ready for AccountManager.routeSignal()
 */
export function mapToTradeSignal(
  parsed: ParsedSignal,
  currentBid: number
): TradeSignal {
  // ── Entry price ──────────────────────────────────────────────────────────
  const entry = parsed.entry > 0 ? parsed.entry : currentBid;

  // ── SL / TP ───────────────────────────────────────────────────────────────
  const sl = parsed.stopLoss;
  const tp = parsed.takeProfit;

  // ── ATR proxy ─────────────────────────────────────────────────────────────
  // SL distance ÷ SL_ATR_MULT gives us the implied 1×ATR the provider used
  const slDistance = Math.abs(entry - sl);
  const atrProxy   = slDistance / SL_ATR_MULT;

  // ── R:R ratio ─────────────────────────────────────────────────────────────
  const tpDistance  = Math.abs(tp - entry);
  const rrRatio     = slDistance > 0 ? tpDistance / slDistance : 1;

  // ── Confidence ────────────────────────────────────────────────────────────
  const confidence  = scoreExternalSignal(parsed, rrRatio);

  return {
    id: `ext_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: parsed.receivedAt,
    instrument: parsed.instrument,
    side: parsed.side,
    confidence,
    regime: inferRegime(rrRatio),
    entry_price: entry,
    stop_loss: sl,
    take_profit: tp,
    risk_reward_ratio: parseFloat(rrRatio.toFixed(2)),
    confluence_factors: [
      `External signal (1000pip Builder VIP)`,
      `R:R ${rrRatio.toFixed(1)}:1`,
      parsed.isRangeEntry ? `Range entry (mid: ${entry.toFixed(5)})` : `Exact entry: ${entry.toFixed(5)}`,
      parsed.allTakeProfits.length > 1
        ? `${parsed.allTakeProfits.length} TP levels (using TP1: ${tp})`
        : `Single TP: ${tp}`,
    ],
    indicator_values: neutralIndicators(entry, atrProxy),
    acted_upon: false,
  };
}
