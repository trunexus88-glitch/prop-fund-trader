/**
 * TRU-NEXUS External Signal Parser
 * ═══════════════════════════════════════════════════════════════════════════
 * Parses raw Telegram messages from 1000pip Builder VIP into structured
 * ParsedSignal objects. Handles the multiple message formats the channel
 * uses: compact one-liner, multi-line with labels, range entries, etc.
 *
 * Design philosophy: be lenient on input, strict on output.
 * If a required field (pair, direction, SL, TP) cannot be extracted,
 * the parse returns null and the monitor discards the message silently.
 */

import type { OrderSide } from '../engine/types.js';

// ─── Parsed Signal (pre-TradeSignal) ────────────────────────────────────────

export interface ParsedSignal {
  /** Normalised symbol, e.g. "EURUSD" */
  instrument: string;
  side: OrderSide;
  /** Mid-point of range entries, or exact entry */
  entry: number;
  stopLoss: number;
  /** First take-profit level — we use TP1 (closest) */
  takeProfit: number;
  /** All TP levels found, for reference */
  allTakeProfits: number[];
  /** True if entry was a range (e.g. "1.0850 - 1.0870") */
  isRangeEntry: boolean;
  /** Raw message text, for logging */
  rawText: string;
  /** Source: "telegram" | "manual" */
  source: 'telegram' | 'manual';
  /** UTC ISO timestamp the message was received */
  receivedAt: string;
}

// ─── Instrument normalisation ────────────────────────────────────────────────

/**
 * Maps common broker/channel symbol variants to normalised 6-char form.
 * 1000pip Builder uses "EUR/USD", "EUR-USD", "EURUSD" interchangeably.
 */
const SYMBOL_MAP: Record<string, string> = {
  'EUR/USD': 'EURUSD', 'EUR-USD': 'EURUSD', 'EURUSD': 'EURUSD',
  'GBP/USD': 'GBPUSD', 'GBP-USD': 'GBPUSD', 'GBPUSD': 'GBPUSD',
  'USD/JPY': 'USDJPY', 'USD-JPY': 'USDJPY', 'USDJPY': 'USDJPY',
  'USD/CHF': 'USDCHF', 'USD-CHF': 'USDCHF', 'USDCHF': 'USDCHF',
  'AUD/USD': 'AUDUSD', 'AUD-USD': 'AUDUSD', 'AUDUSD': 'AUDUSD',
  'NZD/USD': 'NZDUSD', 'NZD-USD': 'NZDUSD', 'NZDUSD': 'NZDUSD',
  'USD/CAD': 'USDCAD', 'USD-CAD': 'USDCAD', 'USDCAD': 'USDCAD',
  'GBP/JPY': 'GBPJPY', 'GBP-JPY': 'GBPJPY', 'GBPJPY': 'GBPJPY',
  'EUR/JPY': 'EURJPY', 'EUR-JPY': 'EURJPY', 'EURJPY': 'EURJPY',
  'EUR/GBP': 'EURGBP', 'EUR-GBP': 'EURGBP', 'EURGBP': 'EURGBP',
  'XAU/USD': 'XAUUSD', 'XAU-USD': 'XAUUSD', 'XAUUSD': 'XAUUSD', 'GOLD': 'XAUUSD',
  'XAG/USD': 'XAGUSD', 'XAG-USD': 'XAGUSD', 'XAGUSD': 'XAGUSD', 'SILVER': 'XAGUSD',
  'BTC/USD': 'BTCUSD', 'BTC-USD': 'BTCUSD', 'BTCUSD': 'BTCUSD', 'BITCOIN': 'BTCUSD',
  'ETH/USD': 'ETHUSD', 'ETH-USD': 'ETHUSD', 'ETHUSD': 'ETHUSD',
  'US30': 'US30', 'DOW': 'US30', 'DJ30': 'US30',
  'NAS100': 'NAS100', 'NASDAQ': 'NAS100', 'NDX': 'NAS100',
  'SPX500': 'SPX500', 'SP500': 'SPX500', 'S&P500': 'SPX500',
  'US OIL': 'USOIL', 'USOIL': 'USOIL', 'WTI': 'USOIL', 'OIL': 'USOIL',
};

function normaliseInstrument(raw: string): string | null {
  const upper = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  // Direct lookup first
  if (SYMBOL_MAP[upper]) return SYMBOL_MAP[upper];
  // Try stripping common suffixes (.pro, m, .i, etc.)
  const stripped = upper.replace(/[.\-_](PRO|M|I|C|Z|ECN|STD|MINI|MICRO)$/i, '');
  if (SYMBOL_MAP[stripped]) return SYMBOL_MAP[stripped];
  // Try rebuilding from slash-free 6-char pair
  if (/^[A-Z]{6}$/.test(upper)) return upper;
  return null;
}

// ─── Direction detection ─────────────────────────────────────────────────────

function parseSide(text: string): OrderSide | null {
  const upper = text.toUpperCase();
  if (/\bSELL\b/.test(upper))  return 'sell';
  if (/\bBUY\b/.test(upper))   return 'buy';
  if (/\bSHORT\b/.test(upper)) return 'sell';
  if (/\bLONG\b/.test(upper))  return 'buy';
  return null;
}

// ─── Number extraction helpers ───────────────────────────────────────────────

/** Matches a decimal price like 1.08500 or 150.250 */
const PRICE_RE = /\d+(?:[.,]\d+)?/g;

function parsePrice(s: string): number | null {
  const m = s.replace(',', '.').match(/(\d+\.\d+|\d+)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return isNaN(n) ? null : n;
}

/**
 * Parse a range entry like "1.0850 - 1.0870" → midpoint.
 * Returns { price, isRange }.
 */
function parseEntryField(s: string): { price: number; isRange: boolean } | null {
  const rangeRe = /(\d+(?:[.,]\d+)?)\s*[-–—]\s*(\d+(?:[.,]\d+)?)/;
  const rangeM = s.match(rangeRe);
  if (rangeM) {
    const lo = parseFloat(rangeM[1].replace(',', '.'));
    const hi = parseFloat(rangeM[2].replace(',', '.'));
    if (!isNaN(lo) && !isNaN(hi)) {
      return { price: (lo + hi) / 2, isRange: true };
    }
  }
  const single = parsePrice(s);
  return single !== null ? { price: single, isRange: false } : null;
}

// ─── Main parser ─────────────────────────────────────────────────────────────

/**
 * Parse a raw Telegram message into a ParsedSignal.
 * Returns null if the message is not a recognisable trade signal.
 *
 * Handles formats observed in 1000pip Builder VIP:
 *
 *   Format A — compact header + labelled fields:
 *     EUR/USD BUY
 *     Entry: 1.08500
 *     SL: 1.08200
 *     TP1: 1.09100 TP2: 1.09500 TP3: 1.10000
 *
 *   Format B — single line:
 *     GBPUSD SELL NOW @ 1.2900 SL 1.2980 TP 1.2750
 *
 *   Format C — labelled with "Stop" / "Target":
 *     EUR/USD BUY NOW
 *     Entry 1.0850 - 1.0870
 *     Stop 1.0800
 *     Target 1.0950
 *
 *   Format D — numbered TPs only, no explicit entry (use current market):
 *     EURUSD BUY (Market)
 *     SL: 1.0810
 *     TP: 1.0920
 */
export function parseSignalMessage(rawText: string, receivedAt?: string): ParsedSignal | null {
  const text  = rawText.trim();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return null;

  // ── 1. Find instrument and direction ──────────────────────────────────────
  let instrument: string | null = null;
  let side: OrderSide | null = null;

  for (const line of lines.slice(0, 3)) {   // Pair + direction always in first 3 lines
    if (!instrument) {
      // Try to extract "EUR/USD", "EURUSD", "GOLD", etc.
      const symRe = /([A-Z]{2,3}[/\-_]?[A-Z]{2,3}|GOLD|SILVER|OIL|BITCOIN|US30|NAS100|SPX500|US\s?OIL)/i;
      const m = line.match(symRe);
      if (m) instrument = normaliseInstrument(m[1]);
    }
    if (!side) {
      side = parseSide(line);
    }
    if (instrument && side) break;
  }

  if (!instrument || !side) return null;

  // ── 2. Extract labelled fields ────────────────────────────────────────────
  // Build a key→value map from "Label: value" patterns across all lines
  const fieldMap: Record<string, string> = {};

  for (const line of lines) {
    // Match patterns like "SL: 1.2000", "Entry 1.2000 - 1.2020", "TP1: 1.2100"
    const kv = line.match(/^(Entry|Open|Enter|SL|Stop[\s-]?Loss|Stop|T[Pp][\d]?|Target[\d]?|Take\s?Profit[\d]?)[\s:]+(.+)/i);
    if (kv) {
      const key = kv[1].trim().toUpperCase()
        .replace(/\s+/g, '')
        .replace('STOPLOSS', 'SL')
        .replace('STOP', 'SL')
        .replace('OPEN', 'ENTRY')
        .replace('ENTER', 'ENTRY')
        .replace(/TAKEPROFIT(\d?)/, 'TP$1')
        .replace(/TARGET(\d?)/, 'TP$1');
      fieldMap[key] = kv[2].trim();
    }
  }

  // Also scan the entire text for inline "@ price" for entry
  if (!fieldMap['ENTRY']) {
    const atRe = /@\s*(\d+(?:[.,]\d+)?)/;
    const m = text.match(atRe);
    if (m) fieldMap['ENTRY'] = m[1];
  }

  // ── 3. Parse entry ────────────────────────────────────────────────────────
  const entryRaw = fieldMap['ENTRY'];
  let entry: number | null = null;
  let isRangeEntry = false;

  if (entryRaw) {
    const parsed = parseEntryField(entryRaw);
    if (parsed) {
      entry = parsed.price;
      isRangeEntry = parsed.isRange;
    }
  }

  // ── 4. Parse SL ───────────────────────────────────────────────────────────
  const sl = parsePrice(fieldMap['SL'] ?? '');

  // ── 5. Parse TPs (TP, TP1, TP2, TP3 …) ───────────────────────────────────
  const allTakeProfits: number[] = [];

  // Collect TP1, TP2, TP3 etc. in order
  for (let i = 1; i <= 5; i++) {
    const v = parsePrice(fieldMap[`TP${i}`] ?? '');
    if (v !== null) allTakeProfits.push(v);
  }
  // Also try bare "TP"
  const tpBare = parsePrice(fieldMap['TP'] ?? '');
  if (tpBare !== null && !allTakeProfits.includes(tpBare)) {
    allTakeProfits.unshift(tpBare);
  }

  // ── 6. Validate required fields ───────────────────────────────────────────
  // SL and at least one TP are mandatory; entry can be market (null → 0)
  if (sl === null || allTakeProfits.length === 0) return null;

  // Use TP1 (closest) as the primary take profit
  const takeProfit = allTakeProfits[0];

  // Sanity check: SL and TP must be on opposite sides of entry (if known)
  if (entry !== null) {
    const buyValid  = side === 'buy'  && sl < entry && takeProfit > entry;
    const sellValid = side === 'sell' && sl > entry && takeProfit < entry;
    if (!buyValid && !sellValid) {
      // Tolerate imprecision but bail on obvious garbage
      return null;
    }
  }

  return {
    instrument,
    side,
    entry: entry ?? 0,           // 0 = market price (resolved by mapper)
    stopLoss: sl,
    takeProfit,
    allTakeProfits,
    isRangeEntry,
    rawText,
    source: 'telegram',
    receivedAt: receivedAt ?? new Date().toISOString(),
  };
}
