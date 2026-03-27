/**
 * TRU-NEXUS MT5 Adapter
 * ═══════════════════════════════════════════════════════════════════════════
 * Implements TradingAdapter for MetaTrader 5 via a local REST bridge.
 *
 * The bridge is a small MT5 Expert Advisor (EA) or a Python script that
 * wraps the MetaTrader5 Python library and exposes a minimal HTTP API on
 * localhost. Two popular options:
 *
 *   Option A — Python bridge (recommended):
 *     pip install MetaTrader5 flask
 *     # See: scripts/mt5-bridge.py (scaffold provided)
 *     # Runs on MT5_REST_URL (default: http://localhost:5050)
 *
 *   Option B — MT5 REST EA:
 *     Compile and attach the EA in MetaTrader 5 terminal.
 *     Both options expose the same API contract below.
 *
 * Required environment variables:
 *   MT5_REST_URL   — e.g. http://localhost:5050   (no trailing slash)
 *   MT5_REST_KEY   — Optional API key for the bridge (empty = no auth)
 *
 * Instrument mapping:
 *   Some brokers append suffixes (e.g. EURUSDm, EURUSD., EURUSD.pro).
 *   Set MT5_SYMBOL_SUFFIX=m (or whatever your broker uses) to auto-append it.
 *
 * REST API contract (must be implemented by the bridge):
 *
 *   GET  /account                          → { balance, equity, margin_free }
 *   GET  /positions                        → Position[]  (bridge format, see below)
 *   POST /order                            → Position    (bridge format)
 *        Body: { symbol, side, lots, sl, tp, magic? }
 *   POST /close/:ticket                    → ClosedTrade (bridge format)
 *   POST /close-all                        → ClosedTrade[]
 *   POST /modify/:ticket                   → Position    (bridge format)
 *        Body: { sl?, tp? }
 *   GET  /price/:symbol                    → { bid, ask }
 *   GET  /candles/:symbol/:timeframe/:n    → Candle[]
 *
 * Bridge position format:
 *   { ticket, symbol, type ("buy"|"sell"), lots, open_price, sl, tp,
 *     profit, open_time_utc }
 */

import type {
  TradingAdapter, Position, ClosedTrade, OrderRequest,
  Candle, Platform
} from '../engine/types.js';
import { tradeLogger, logger } from '../utils/logger.js';

// ─── Bridge response types ───────────────────────────────────────────────────

interface BridgeAccount {
  balance: number;
  equity: number;
  margin_free: number;
}

interface BridgePosition {
  ticket: number;
  symbol: string;
  type: 'buy' | 'sell';
  lots: number;
  open_price: number;
  sl: number;
  tp: number;
  profit: number;
  open_time_utc: string;      // ISO 8601
}

interface BridgeClosedTrade {
  ticket: number;
  symbol: string;
  type: 'buy' | 'sell';
  lots: number;
  open_price: number;
  close_price: number;
  sl: number;
  tp: number;
  profit: number;
  open_time_utc: string;
  close_time_utc: string;
  reason: 'tp' | 'sl' | 'manual' | 'kill_switch';
}

interface BridgePrice {
  bid: number;
  ask: number;
}

interface BridgeCandle {
  time: string;           // ISO 8601
  open: number;
  high: number;
  low: number;
  close: number;
  tick_volume: number;
}

// ─── MT5 Adapter ─────────────────────────────────────────────────────────────

export class MT5Adapter implements TradingAdapter {
  readonly name = 'MT5 REST Bridge';
  readonly platform: Platform = 'mt5';

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly symbolSuffix: string;
  private connected: boolean = false;

  // Magic number stamped on every order so we can filter our positions
  // from manual trades the user might place in the terminal
  private readonly MAGIC = 20260101;

  // Price update subscribers (polled every 2s in the main loop)
  private priceCallbacks: Map<string, Array<(p: { bid: number; ask: number }) => void>> = new Map();

  constructor() {
    this.baseUrl     = (process.env.MT5_REST_URL ?? 'http://localhost:5050').replace(/\/$/, '');
    this.apiKey      = process.env.MT5_REST_KEY ?? '';
    this.symbolSuffix = process.env.MT5_SYMBOL_SUFFIX ?? '';
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    // Ping /account to verify the bridge is reachable
    const acct = await this.fetch<BridgeAccount>('/account');
    this.connected = true;
    tradeLogger.info('MT5 adapter connected', {
      url: this.baseUrl,
      balance: acct.balance.toFixed(2),
      equity: acct.equity.toFixed(2),
    });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    tradeLogger.info('MT5 adapter disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Account ───────────────────────────────────────────────────────────────

  async getAccountBalance(): Promise<number> {
    const acct = await this.fetch<BridgeAccount>('/account');
    return acct.balance;
  }

  async getAccountEquity(): Promise<number> {
    const acct = await this.fetch<BridgeAccount>('/account');
    return acct.equity;
  }

  // ─── Positions ─────────────────────────────────────────────────────────────

  async getOpenPositions(): Promise<Position[]> {
    const raw = await this.fetch<BridgePosition[]>('/positions');
    return raw
      .filter(p => p.ticket !== undefined)  // sanity
      .map(p => this.mapPosition(p));
  }

  async placeOrder(order: OrderRequest): Promise<Position> {
    const symbol = this.toMT5Symbol(order.instrument);
    const body = {
      symbol,
      side:  order.side,
      lots:  order.lots,
      sl:    order.stop_loss,
      tp:    order.take_profit ?? 0,
      magic: this.MAGIC,
      comment: order.signal_id ? `sig:${order.signal_id.slice(0, 16)}` : 'tru-nexus',
    };

    const raw = await this.fetch<BridgePosition>('/order', 'POST', body);

    tradeLogger.info('MT5 order placed', {
      ticket: raw.ticket,
      symbol,
      side: order.side,
      lots: order.lots,
      openPrice: raw.open_price,
    });

    return this.mapPosition(raw);
  }

  async closePosition(positionId: string): Promise<ClosedTrade> {
    const raw = await this.fetch<BridgeClosedTrade>(`/close/${positionId}`, 'POST');
    return this.mapClosedTrade(raw);
  }

  async closeAllPositions(): Promise<ClosedTrade[]> {
    const raw = await this.fetch<BridgeClosedTrade[]>('/close-all', 'POST', {
      magic: this.MAGIC
    });
    return raw.map(t => this.mapClosedTrade(t));
  }

  async modifyPosition(
    positionId: string,
    stopLoss?: number,
    takeProfit?: number
  ): Promise<Position> {
    const body: Record<string, number> = {};
    if (stopLoss  !== undefined) body.sl = stopLoss;
    if (takeProfit !== undefined) body.tp = takeProfit;

    const raw = await this.fetch<BridgePosition>(`/modify/${positionId}`, 'POST', body);
    return this.mapPosition(raw);
  }

  // ─── Market data ────────────────────────────────────────────────────────────

  async getCurrentPrice(instrument: string): Promise<{ bid: number; ask: number }> {
    const symbol = this.toMT5Symbol(instrument);
    return this.fetch<BridgePrice>(`/price/${symbol}`);
  }

  async getCandles(instrument: string, timeframe: string, count: number): Promise<Candle[]> {
    const symbol = this.toMT5Symbol(instrument);
    const tf     = this.toMT5Timeframe(timeframe);
    const raw    = await this.fetch<BridgeCandle[]>(`/candles/${symbol}/${tf}/${count}`);

    return raw.map(c => ({
      timestamp: c.time,
      open:   c.open,
      high:   c.high,
      low:    c.low,
      close:  c.close,
      volume: c.tick_volume,
    }));
  }

  onPriceUpdate(
    instrument: string,
    callback: (price: { bid: number; ask: number }) => void
  ): void {
    if (!this.priceCallbacks.has(instrument)) {
      this.priceCallbacks.set(instrument, []);
    }
    this.priceCallbacks.get(instrument)!.push(callback);
  }

  onPositionUpdate(_callback: (position: Position) => void): void {
    // MT5 bridge is polled — position updates come through getOpenPositions()
    // In a future version, the bridge could push via WebSocket
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  /** Map a bridge position to our internal Position type */
  private mapPosition(raw: BridgePosition): Position {
    return {
      id:            String(raw.ticket),
      instrument:    this.fromMT5Symbol(raw.symbol),
      side:          raw.type,
      lots:          raw.lots,
      entry_price:   raw.open_price,
      current_price: raw.open_price,    // Will be updated by next tick
      stop_loss:     raw.sl,
      take_profit:   raw.tp,
      unrealized_pnl: raw.profit,
      opened_at:     raw.open_time_utc,
      max_adverse_excursion: 0,
    };
  }

  /** Map a bridge closed trade to our ClosedTrade type */
  private mapClosedTrade(raw: BridgeClosedTrade): ClosedTrade {
    const openMs   = new Date(raw.open_time_utc).getTime();
    const closeMs  = new Date(raw.close_time_utc).getTime();
    const holdSecs = (closeMs - openMs) / 1000;

    return {
      id:             String(raw.ticket),
      instrument:     this.fromMT5Symbol(raw.symbol),
      side:           raw.type,
      lots:           raw.lots,
      entry_price:    raw.open_price,
      exit_price:     raw.close_price,
      stop_loss:      raw.sl,
      take_profit:    raw.tp,
      realized_pnl:   raw.profit,
      opened_at:      raw.open_time_utc,
      closed_at:      raw.close_time_utc,
      hold_time_seconds: holdSecs,
      close_reason:   raw.reason ?? 'manual',
    };
  }

  /** Append broker suffix and uppercase */
  private toMT5Symbol(instrument: string): string {
    return `${instrument.toUpperCase()}${this.symbolSuffix}`;
  }

  /** Strip broker suffix, return canonical instrument name */
  private fromMT5Symbol(symbol: string): string {
    const suffix = this.symbolSuffix;
    if (suffix && symbol.endsWith(suffix)) {
      return symbol.slice(0, -suffix.length);
    }
    return symbol;
  }

  /**
   * Map generic timeframe strings to MT5 timeframe identifiers.
   * MT5 uses M1, M5, M15, M30, H1, H4, D1 etc.
   */
  private toMT5Timeframe(tf: string): string {
    const map: Record<string, string> = {
      '1m': 'M1', '3m': 'M3', '5m': 'M5', '15m': 'M15', '30m': 'M30',
      '1h': 'H1', '2h': 'H2', '4h': 'H4', '6h': 'H6', '12h': 'H12',
      '1d': 'D1', '1w': 'W1', '1M': 'MN1',
    };
    return map[tf] ?? tf.toUpperCase();
  }

  // ─── HTTP client ────────────────────────────────────────────────────────────

  private async fetch<T>(
    path: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;

    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(10_000),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await globalThis.fetch(url, init);
    } catch (err) {
      throw new Error(
        `[MT5Adapter] Network error connecting to bridge at ${this.baseUrl}.\n` +
        `  Is the MT5 REST bridge running? See scripts/mt5-bridge.py\n` +
        `  Error: ${String(err)}`
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '(no body)');
      throw new Error(`[MT5Adapter] Bridge returned ${res.status} for ${method} ${path}: ${text}`);
    }

    return res.json() as Promise<T>;
  }
}
