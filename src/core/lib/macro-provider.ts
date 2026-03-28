/**
 * TRU-NEXUS Macro Data Provider
 * ═══════════════════════════════════════════════════════════════════════════
 * Fetches macro indicators from free public APIs:
 *   - DXY proxy  : inverse of EUR/USD (1/EURUSD ≈ DXY direction)
 *   - US10Y proxy: 10-Year Treasury yield via Yahoo Finance (^TNX)
 *   - USOIL proxy: WTI Crude Futures via Yahoo Finance (CL=F)
 *
 * Results are cached for 15 minutes. Falls back to last-known cache or
 * static defaults if the APIs are unavailable — the macro filter is
 * additive in paper mode, so graceful degradation is acceptable.
 *
 * Intentional design choices:
 *   - This module lives in core/lib, NOT strategy/, so it has zero
 *     dependency on indicators, regime-classifier, or signal-generator.
 *   - EMA is computed inline (5-line function) to avoid importing from
 *     strategy/indicators.ts, which would create a cross-layer dependency.
 */

import { signalLogger } from '../../utils/logger.js';

// ─── Public Types ────────────────────────────────────────────────────────────

export interface MacroTrend {
  price:  number;
  ema20:  number;
  ema50:  number;
  trend:  'UP' | 'DOWN' | 'FLAT';
}

export interface MacroSnapshot {
  dxy:        MacroTrend;  // DXY proxy  — 1 / EURUSD (higher = stronger dollar)
  yields:     MacroTrend;  // US10Y yield in percent  (e.g. 4.50 = 4.50%)
  oil:        MacroTrend;  // WTI Crude in USD        (e.g. 72.00)
  fetchedAt:  string;      // ISO timestamp of last successful fetch
  is_fallback: boolean;    // true → using cached or default data, not live
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Exponential Moving Average.
 * Inline copy of indicators.ts ema() — avoids cross-layer import.
 */
function localEma(data: number[], period: number): number {
  if (data.length === 0) return NaN;
  if (data.length < period) return data[data.length - 1];
  const k = 2 / (period + 1);
  let v = data.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < data.length; i++) v = data[i] * k + v * (1 - k);
  return v;
}

/**
 * Convert EMA20 / EMA50 pair to a directional trend label.
 * 0.1% separation threshold — keeps FLAT when EMAs are clustered.
 */
function toTrend(ema20: number, ema50: number): 'UP' | 'DOWN' | 'FLAT' {
  if (!isFinite(ema20) || !isFinite(ema50) || ema50 === 0) return 'FLAT';
  const rel = (ema20 - ema50) / ema50;
  if (rel >  0.001) return 'UP';
  if (rel < -0.001) return 'DOWN';
  return 'FLAT';
}

/** Build a MacroTrend from a series of closing prices. */
function buildTrend(closes: number[]): MacroTrend {
  const price = closes.length > 0 ? closes[closes.length - 1] : 0;
  const ema20 = localEma(closes, 20);
  const ema50 = localEma(closes, 50);
  return { price, ema20, ema50, trend: toTrend(ema20, ema50) };
}

/**
 * Fetch up to `count` daily closing prices from Yahoo Finance v8 chart API.
 * Filters null values that appear on non-trading days.
 */
async function fetchYahooCloses(symbol: string, count: number = 65): Promise<number[]> {
  // Yahoo Finance v8 chart — undocumented but widely used; 3mo gives ~65 trading days
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=3mo`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; TRU-NEXUS/1.0)',
      'Accept':     'application/json',
    },
    signal: AbortSignal.timeout(8_000),
  });

  if (!res.ok) throw new Error(`Yahoo ${symbol} HTTP ${res.status}`);

  const json = await res.json() as {
    chart: {
      result: Array<{
        indicators: {
          quote: Array<{ close: (number | null)[] }>
        }
      }> | null;
      error: { code: string; description: string } | null;
    }
  };

  if (json.chart.error) {
    throw new Error(`Yahoo API error: ${json.chart.error.description}`);
  }

  const raw: (number | null)[] =
    json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];

  const valid = raw.filter((c): c is number => c !== null && isFinite(c));
  return valid.slice(-count);
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 15 * 60 * 1000;   // 15 minutes

let _cache: MacroSnapshot | null = null;
let _cacheTs = 0;

/**
 * Sensible paper-mode defaults, roughly correct for early-to-mid 2026.
 * These fire only when all API calls fail AND there is no prior cache.
 */
const HARDCODED_DEFAULTS: Omit<MacroSnapshot, 'fetchedAt' | 'is_fallback'> = {
  dxy:    { price: 103.5, ema20: 103.5, ema50: 103.0, trend: 'FLAT'  },
  yields: { price:   4.5, ema20:   4.5, ema50:  4.45, trend: 'FLAT'  },
  oil:    { price:  72.0, ema20:  72.0, ema50:  73.5, trend: 'DOWN'  },
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Return a MacroSnapshot, reading live data or cache.
 *
 * Cache policy:
 *   - Fresh (<15 min): return immediately, no network call.
 *   - Stale or empty: attempt live fetch from Yahoo Finance.
 *   - Fetch failure: return last-known cache (any age) or hardcoded defaults.
 */
export async function getMacroSnapshot(): Promise<MacroSnapshot> {
  // Serve from cache if fresh enough
  if (_cache && Date.now() - _cacheTs < CACHE_TTL_MS) {
    return _cache;
  }

  try {
    // Fetch all three series in parallel
    // Yahoo Finance symbols:
    //   EURUSD=X  → EUR/USD spot (DXY proxy = 1/EURUSD)
    //   %5ETNX    → ^TNX 10-Year Treasury yield
    //   CL%3DF    → CL=F WTI Crude futures
    const [eurusdCloses, tnxCloses, clCloses] = await Promise.all([
      fetchYahooCloses('EURUSD%3DX'),
      fetchYahooCloses('%5ETNX'),
      fetchYahooCloses('CL%3DF'),
    ]);

    if (eurusdCloses.length < 20) {
      throw new Error('Insufficient EURUSD data from Yahoo Finance');
    }

    // DXY proxy = 1 / EURUSD  (dollar strengthens as EURUSD falls)
    const dxyCloses = eurusdCloses.map(p => 1 / p);

    const snapshot: MacroSnapshot = {
      dxy:    buildTrend(dxyCloses),
      yields: buildTrend(tnxCloses.length >= 20 ? tnxCloses : []),
      oil:    buildTrend(clCloses.length >= 20   ? clCloses  : []),
      fetchedAt:   new Date().toISOString(),
      is_fallback: false,
    };

    // Fill in hardcoded defaults for any indicator that had insufficient data
    if (tnxCloses.length < 20) {
      snapshot.yields = { ...HARDCODED_DEFAULTS.yields };
      signalLogger.warn('[macro] TNX data insufficient — using default yield');
    }
    if (clCloses.length < 20) {
      snapshot.oil = { ...HARDCODED_DEFAULTS.oil };
      signalLogger.warn('[macro] CL=F data insufficient — using default oil price');
    }

    _cache   = snapshot;
    _cacheTs = Date.now();

    signalLogger.info('[macro] Snapshot refreshed', {
      dxy:    `${snapshot.dxy.price.toFixed(4)} (${snapshot.dxy.trend})`,
      yields: `${snapshot.yields.price.toFixed(2)}% (${snapshot.yields.trend})`,
      oil:    `$${snapshot.oil.price.toFixed(2)} (${snapshot.oil.trend})`,
      points: { eurusd: eurusdCloses.length, tnx: tnxCloses.length, cl: clCloses.length },
    });

    return snapshot;

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    signalLogger.warn('[macro] Live fetch failed — using fallback', { error: errMsg });

    // Return stale cache (any age) if available; otherwise hardcoded defaults
    if (_cache) {
      signalLogger.info('[macro] Returning stale cache', {
        age: `${Math.round((Date.now() - _cacheTs) / 60000)}m`,
      });
      return { ..._cache, is_fallback: true };
    }

    const fallback: MacroSnapshot = {
      ...HARDCODED_DEFAULTS,
      fetchedAt:   new Date().toISOString(),
      is_fallback: true,
    };
    signalLogger.info('[macro] Using hardcoded defaults');
    return fallback;
  }
}

/** Force cache expiry (useful in tests or after manual intervention). */
export function invalidateMacroCache(): void {
  _cache   = null;
  _cacheTs = 0;
}
