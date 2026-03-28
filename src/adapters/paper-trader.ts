/**
 * TRU-NEXUS Paper Trading Adapter
 * ═══════════════════════════════════════════════════════════════════════════
 * Simulates order execution against live market data for validation.
 * This is the primary testing adapter — the system MUST prove itself
 * in paper mode before any real capital is deployed.
 */

import type { 
  TradingAdapter, Position, ClosedTrade, OrderRequest, 
  Candle, Platform 
} from '../engine/types.js';
import { tradeLogger } from '../utils/logger.js';

export class PaperTradingAdapter implements TradingAdapter {
  readonly name = 'Paper Trader';
  readonly platform: Platform = 'tradelocker';

  private connected: boolean = false;
  private balance: number;
  private equity: number;
  private positions: Map<string, Position> = new Map();
  private closedTrades: ClosedTrade[] = [];
  private priceFeeds: Map<string, { bid: number; ask: number }> = new Map();
  private candleStore: Map<string, Candle[]> = new Map();
  private spread: number = 0.00015; // 1.5 pip spread for simulation
  private tradeIdCounter: number = 0;
  // Registered price-update callbacks (see onPriceUpdate)
  _priceCallbacks: Map<string, Array<(p: { bid: number; ask: number }) => void>> = new Map();

  constructor(initialBalance: number) {
    this.balance = initialBalance;
    this.equity = initialBalance;

    tradeLogger.info('Paper trading adapter initialized', { initialBalance });
  }

  async connect(): Promise<void> {
    this.connected = true;
    tradeLogger.info('Paper trader connected');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    tradeLogger.info('Paper trader disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getAccountBalance(): Promise<number> {
    return this.balance;
  }

  async getAccountEquity(): Promise<number> {
    // Equity = balance + unrealized P&L
    let unrealizedPnl = 0;
    for (const pos of this.positions.values()) {
      unrealizedPnl += pos.unrealized_pnl;
    }
    this.equity = this.balance + unrealizedPnl;
    return this.equity;
  }

  async getOpenPositions(): Promise<Position[]> {
    return Array.from(this.positions.values());
  }

  async placeOrder(order: OrderRequest): Promise<Position> {
    if (!this.connected) throw new Error('Paper trader not connected');

    const id = `paper_${++this.tradeIdCounter}_${Date.now()}`;
    const price = this.getSimulatedFill(order);

    const position: Position = {
      id,
      instrument: order.instrument,
      side: order.side,
      lots: order.lots,
      entry_price: price,
      current_price: price,
      stop_loss: order.stop_loss,
      take_profit: order.take_profit ?? 0,
      unrealized_pnl: 0,
      opened_at: new Date().toISOString(),
      max_adverse_excursion: 0
    };

    this.positions.set(id, position);

    tradeLogger.info('Paper trade opened', {
      id,
      instrument: order.instrument,
      side: order.side,
      lots: order.lots,
      entryPrice: price,
      stopLoss: order.stop_loss,
      takeProfit: order.take_profit
    });

    return position;
  }

  async closePosition(positionId: string): Promise<ClosedTrade> {
    const pos = this.positions.get(positionId);
    if (!pos) throw new Error(`Position ${positionId} not found`);

    const exitPrice = pos.current_price;
    const pnl = this.calculatePnl(pos, exitPrice);
    const holdTimeSeconds = (Date.now() - new Date(pos.opened_at).getTime()) / 1000;

    const trade: ClosedTrade = {
      id: pos.id,
      instrument: pos.instrument,
      side: pos.side,
      lots: pos.lots,
      entry_price: pos.entry_price,
      exit_price: exitPrice,
      stop_loss: pos.stop_loss,
      take_profit: pos.take_profit || 0,
      realized_pnl: pnl,
      opened_at: pos.opened_at,
      closed_at: new Date().toISOString(),
      hold_time_seconds: holdTimeSeconds,
      close_reason: 'manual'
    };

    this.positions.delete(positionId);
    this.balance += pnl;
    this.closedTrades.push(trade);

    tradeLogger.info('Paper trade closed', {
      id: trade.id,
      pnl: pnl.toFixed(2),
      holdTime: `${holdTimeSeconds.toFixed(0)}s`
    });

    return trade;
  }

  async closeAllPositions(): Promise<ClosedTrade[]> {
    const trades: ClosedTrade[] = [];
    const positionIds = Array.from(this.positions.keys());

    for (const id of positionIds) {
      const trade = await this.closePosition(id);
      trade.close_reason = 'kill_switch';
      trades.push(trade);
    }

    return trades;
  }

  async modifyPosition(positionId: string, stopLoss?: number, takeProfit?: number): Promise<Position> {
    const pos = this.positions.get(positionId);
    if (!pos) throw new Error(`Position ${positionId} not found`);

    if (stopLoss !== undefined) pos.stop_loss = stopLoss;
    if (takeProfit !== undefined) pos.take_profit = takeProfit;

    return pos;
  }

  async getCurrentPrice(instrument: string): Promise<{ bid: number; ask: number }> {
    const feed = this.priceFeeds.get(instrument);
    if (feed) return feed;
    
    // Return a default price for simulation
    return { bid: 1.10000, ask: 1.10015 };
  }

  async getCandles(instrument: string, timeframe: string, count: number): Promise<Candle[]> {
    const stored = this.candleStore.get(`${instrument}_${timeframe}`);
    if (stored) return stored.slice(-count);

    // Generate synthetic candles for testing
    return this.generateSyntheticCandles(instrument, count);
  }

  onPriceUpdate(instrument: string, callback: (price: { bid: number; ask: number }) => void): void {
    // Register a callback for price updates on this instrument.
    // In paper trading mode the main loop calls updatePrice() directly —
    // so we store the callback and fire it from updatePrice() each tick.
    // On a live adapter (MT5Adapter) this would subscribe to the broker's
    // WebSocket or REST poll, then call registered callbacks as ticks arrive.
    if (!this._priceCallbacks) {
      this._priceCallbacks = new Map<string, Array<(p: { bid: number; ask: number }) => void>>();
    }
    if (!this._priceCallbacks.has(instrument)) {
      this._priceCallbacks.set(instrument, []);
    }
    this._priceCallbacks.get(instrument)!.push(callback);
  }

  onPositionUpdate(_callback: (position: Position) => void): void {
    // TODO (Phase 19): On live adapters this will subscribe to broker position
    // events (fills, SL/TP triggers, margin calls) and push them to the
    // AccountManager so the internal state stays in sync without polling.
    // In paper mode, positions are updated synchronously inside updatePrice()
    // (SL/TP execution is immediate) so push notifications aren't needed.
  }

  // ─── Paper Trading Specific Methods ─────────────────────────────────

  /**
   * Feed price data into the paper trader (from external data source).
   */
  updatePrice(instrument: string, bid: number, ask: number): void {
    this.priceFeeds.set(instrument, { bid, ask });

    // Notify any registered onPriceUpdate subscribers
    const cbs = this._priceCallbacks.get(instrument);
    if (cbs) {
      for (const cb of cbs) cb({ bid, ask });
    }

    // Update all open positions for this instrument
    for (const pos of this.positions.values()) {
      if (pos.instrument === instrument) {
        pos.current_price = pos.side === 'buy' ? bid : ask;
        pos.unrealized_pnl = this.calculatePnl(pos, pos.current_price);

        // Track max adverse excursion
        if (pos.unrealized_pnl < -pos.max_adverse_excursion) {
          pos.max_adverse_excursion = Math.abs(pos.unrealized_pnl);
        }

        // Check stop loss
        if (pos.side === 'buy' && bid <= pos.stop_loss) {
          this.executeStopLoss(pos.id, bid);
        } else if (pos.side === 'sell' && ask >= pos.stop_loss) {
          this.executeStopLoss(pos.id, ask);
        }

        // Check take profit
        if (pos.take_profit) {
          if (pos.side === 'buy' && bid >= pos.take_profit) {
            this.executeTakeProfit(pos.id, bid);
          } else if (pos.side === 'sell' && ask <= pos.take_profit) {
            this.executeTakeProfit(pos.id, ask);
          }
        }
      }
    }
  }

  /**
   * Feed candle data into the store.
   */
  updateCandles(instrument: string, timeframe: string, candles: Candle[]): void {
    this.candleStore.set(`${instrument}_${timeframe}`, candles);
  }

  /**
   * Get all closed trades for analysis.
   */
  getClosedTrades(): ClosedTrade[] {
    return [...this.closedTrades];
  }

  /**
   * Get performance summary.
   */
  getPerformanceSummary(): {
    totalTrades: number;
    winRate: number;
    avgPnl: number;
    avgRR: number;
    maxConsecutiveLosses: number;
    totalPnl: number;
  } {
    const trades = this.closedTrades;
    if (trades.length === 0) {
      return { totalTrades: 0, winRate: 0, avgPnl: 0, avgRR: 0, maxConsecutiveLosses: 0, totalPnl: 0 };
    }

    const wins = trades.filter(t => t.realized_pnl > 0);
    const losses = trades.filter(t => t.realized_pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.realized_pnl, 0);
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.realized_pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.realized_pnl, 0) / losses.length) : 1;

    // Max consecutive losses
    let maxConsec = 0;
    let currentConsec = 0;
    for (const t of trades) {
      if (t.realized_pnl <= 0) {
        currentConsec++;
        maxConsec = Math.max(maxConsec, currentConsec);
      } else {
        currentConsec = 0;
      }
    }

    return {
      totalTrades: trades.length,
      winRate: wins.length / trades.length,
      avgPnl: totalPnl / trades.length,
      avgRR: avgLoss > 0 ? avgWin / avgLoss : 0,
      maxConsecutiveLosses: maxConsec,
      totalPnl
    };
  }

  // ─── Private Methods ───────────────────────────────────────────────

  private getSimulatedFill(order: OrderRequest): number {
    const feed = this.priceFeeds.get(order.instrument);
    if (!feed) {
      // Use a default mid-price with spread
      return order.price || 1.10000;
    }

    // Market orders fill at ask (buy) or bid (sell)
    if (order.type === 'market') {
      return order.side === 'buy' ? feed.ask : feed.bid;
    }

    // Limit/stop orders fill at the specified price
    return order.price || (order.side === 'buy' ? feed.ask : feed.bid);
  }

  /**
   * Returns the pip size for an instrument.
   * Must match position-sizer.ts getPipSize() — keep them in sync.
   *
   * JPY pairs use 0.01 (not 0.0001). Using 0.0001 for USDJPY makes a
   * 50-pip move appear as 5,000 pips, producing phantom $50,000 P&L per lot
   * that would immediately breach every drawdown floor on live data.
   */
  private getPipSize(instrument: string): number {
    if (instrument.includes('JPY')) return 0.01;
    if (instrument === 'XAUUSD') return 0.10;
    if (instrument === 'XAGUSD') return 0.01;
    if (instrument === 'BTCUSD') return 1.00;
    if (instrument === 'ETHUSD') return 0.10;
    if (instrument === 'USOIL')  return 0.01;
    if (/^(US30|NAS100|SPX500)$/.test(instrument)) return 1.0;
    return 0.0001;
  }

  private calculatePnl(position: Position, exitPrice: number): number {
    const direction = position.side === 'buy' ? 1 : -1;
    const priceDiff = (exitPrice - position.entry_price) * direction;
    const pipSize   = this.getPipSize(position.instrument);
    const pipDiff   = priceDiff / pipSize;
    return pipDiff * 10 * position.lots; // $10 per pip per standard lot
  }

  private async executeStopLoss(positionId: string, price: number): Promise<void> {
    const pos = this.positions.get(positionId);
    if (!pos) return;

    pos.current_price = price;
    const trade = await this.closePosition(positionId);
    trade.close_reason = 'sl';

    tradeLogger.info('Stop loss executed', {
      id: trade.id,
      pnl: trade.realized_pnl.toFixed(2)
    });
  }

  private async executeTakeProfit(positionId: string, price: number): Promise<void> {
    const pos = this.positions.get(positionId);
    if (!pos) return;

    pos.current_price = price;
    const trade = await this.closePosition(positionId);
    trade.close_reason = 'tp';

    tradeLogger.info('Take profit executed', {
      id: trade.id,
      pnl: trade.realized_pnl.toFixed(2)
    });
  }

  private generateSyntheticCandles(instrument: string, count: number): Candle[] {
    const candles: Candle[] = [];
    let price = 1.10000;
    const now = Date.now();

    for (let i = count; i > 0; i--) {
      const open = price;
      // Inject synthetic trend to trigger indicator signals
      const drift = instrument.includes('USD') ? (instrument === 'EURUSD' ? -0.0003 : 0.0003) : 0;
      const change = (Math.random() - 0.45) * 0.002 + drift;
      const close = open + change;
      const high = Math.max(open, close) + Math.random() * 0.001;
      const low = Math.min(open, close) - Math.random() * 0.001;

      candles.push({
        timestamp: new Date(now - i * 5 * 60 * 1000).toISOString(),
        open, high, low, close,
        volume: Math.floor(Math.random() * 1000) + 100
      });

      price = close;
    }

    return candles;
  }
}
