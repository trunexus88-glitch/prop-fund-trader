/**
 * TRU-NEXUS Technical Indicators Library
 * ═══════════════════════════════════════════════════════════════════════════
 * Pure mathematical implementations of technical analysis indicators.
 * No external TA libraries — full control over calculations.
 */

import type { Candle, IndicatorSnapshot } from '../engine/types.js';

/**
 * Simple Moving Average
 */
export function sma(data: number[], period: number): number {
  if (data.length < period) return NaN;
  const slice = data.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

/**
 * Exponential Moving Average
 */
export function ema(data: number[], period: number): number {
  if (data.length < period) return NaN;
  const k = 2 / (period + 1);
  let emaValue = sma(data.slice(0, period), period);
  
  for (let i = period; i < data.length; i++) {
    emaValue = data[i] * k + emaValue * (1 - k);
  }
  
  return emaValue;
}

/**
 * EMA series — returns full EMA array for lookback analysis.
 */
export function emaSeries(data: number[], period: number): number[] {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  
  let emaValue = sma(data.slice(0, period), period);
  result.push(emaValue);
  
  for (let i = period; i < data.length; i++) {
    emaValue = data[i] * k + emaValue * (1 - k);
    result.push(emaValue);
  }
  
  return result;
}

/**
 * Relative Strength Index (RSI)
 */
export function rsi(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return NaN;

  let gains = 0;
  let losses = 0;

  // Initial average gain/loss
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smooth subsequent values
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Average True Range (ATR)
 */
export function atr(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return NaN;

  const trueRanges: number[] = [];
  
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  // Use RMA (Wilder's smoothing) for ATR
  let atrValue = sma(trueRanges.slice(0, period), period);
  
  for (let i = period; i < trueRanges.length; i++) {
    atrValue = (atrValue * (period - 1) + trueRanges[i]) / period;
  }

  return atrValue;
}

/**
 * MACD (Moving Average Convergence Divergence)
 * Returns: { value, signal, histogram }
 */
export function macd(
  closes: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): { value: number; signal: number; histogram: number } {
  if (closes.length < slowPeriod + signalPeriod) {
    return { value: NaN, signal: NaN, histogram: NaN };
  }

  const fastEma = emaSeries(closes, fastPeriod);
  const slowEma = emaSeries(closes, slowPeriod);

  // Align arrays — MACD line starts when both EMAs are available
  const offset = slowPeriod - fastPeriod;
  const macdLine: number[] = [];
  
  for (let i = 0; i < slowEma.length; i++) {
    macdLine.push(fastEma[i + offset] - slowEma[i]);
  }

  if (macdLine.length < signalPeriod) {
    return { value: NaN, signal: NaN, histogram: NaN };
  }

  const signalLine = ema(macdLine, signalPeriod);
  const currentMacd = macdLine[macdLine.length - 1];

  return {
    value: currentMacd,
    signal: signalLine,
    histogram: currentMacd - signalLine
  };
}

/**
 * Bollinger Bands
 * Returns: { upper, middle, lower }
 */
export function bollingerBands(
  closes: number[],
  period: number = 20,
  stdDevMultiplier: number = 2
): { upper: number; middle: number; lower: number } {
  if (closes.length < period) {
    return { upper: NaN, middle: NaN, lower: NaN };
  }

  const middle = sma(closes, period);
  const slice = closes.slice(-period);
  
  // Standard deviation
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - middle, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    upper: middle + stdDev * stdDevMultiplier,
    middle,
    lower: middle - stdDev * stdDevMultiplier
  };
}

/**
 * Support and Resistance levels using pivot points.
 * Identifies significant price levels from recent price action.
 */
export function findSupportResistance(
  candles: Candle[],
  lookback: number = 50,
  tolerance: number = 0.001
): { support: number[]; resistance: number[] } {
  const recent = candles.slice(-lookback);
  const currentPrice = recent[recent.length - 1].close;
  const levels: { price: number; touches: number }[] = [];

  // Find swing highs and lows
  for (let i = 2; i < recent.length - 2; i++) {
    const c = recent[i];
    
    // Swing high
    if (c.high > recent[i - 1].high && c.high > recent[i - 2].high &&
        c.high > recent[i + 1].high && c.high > recent[i + 2].high) {
      addLevel(levels, c.high, tolerance);
    }
    
    // Swing low
    if (c.low < recent[i - 1].low && c.low < recent[i - 2].low &&
        c.low < recent[i + 1].low && c.low < recent[i + 2].low) {
      addLevel(levels, c.low, tolerance);
    }
  }

  // Sort by number of touches (more touches = stronger level)
  levels.sort((a, b) => b.touches - a.touches);

  // Separate into support (below price) and resistance (above price)
  const support = levels
    .filter(l => l.price < currentPrice)
    .slice(0, 3)
    .map(l => l.price);

  const resistance = levels
    .filter(l => l.price > currentPrice)
    .slice(0, 3)
    .map(l => l.price);

  return { support, resistance };
}

function addLevel(
  levels: { price: number; touches: number }[],
  price: number,
  tolerance: number
): void {
  const existing = levels.find(l => Math.abs(l.price - price) / price < tolerance);
  if (existing) {
    existing.touches++;
    existing.price = (existing.price + price) / 2; // Average the level
  } else {
    levels.push({ price, touches: 1 });
  }
}

/**
 * Generate a complete indicator snapshot for the current market state.
 */
export function generateIndicatorSnapshot(candles: Candle[]): IndicatorSnapshot {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  
  const macdResult = macd(closes);
  const bbands = bollingerBands(closes);
  const sr = findSupportResistance(candles);

  return {
    rsi_14: rsi(closes, 14),
    ema_9: ema(closes, 9),
    ema_21: ema(closes, 21),
    ema_50: ema(closes, 50),
    ema_200: ema(closes, 200),
    atr_14: atr(candles, 14),
    macd_value: macdResult.value,
    macd_signal: macdResult.signal,
    macd_histogram: macdResult.histogram,
    bollinger_upper: bbands.upper,
    bollinger_middle: bbands.middle,
    bollinger_lower: bbands.lower,
    volume: volumes.length > 0 ? volumes[volumes.length - 1] : 0,
    support_levels: sr.support,
    resistance_levels: sr.resistance
  };
}
