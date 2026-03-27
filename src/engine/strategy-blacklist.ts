/**
 * TRU-NEXUS Strategy Blacklist
 * ═══════════════════════════════════════════════════════════════════════════
 * Hardcoded rejections for strategies explicitly banned by most prop firms.
 * The system must NEVER execute any of these regardless of what the AI
 * signal layer suggests.
 * 
 * Banned strategies:
 *   1. Martingale (doubling after loss)
 *   2. Grid trading without stops
 *   3. Latency arbitrage
 *   4. Cross-account hedging
 *   5. High-frequency scalping
 */

import type { OrderRequest, ClosedTrade, Position, FirmProfile } from './types.js';
import { eventBus } from '../utils/event-bus.js';
import { riskLogger } from '../utils/logger.js';

export interface BlacklistCheckResult {
  approved: boolean;
  violations: string[];
}

export class StrategyBlacklist {
  private recentTrades: ClosedTrade[] = [];
  private minHoldTimeSeconds: number;
  private maxDailyTrades: number | null;
  private dailyTradeCount: number = 0;
  private lookbackWindow: number = 10;     // Check last N trades for patterns

  constructor(profile: FirmProfile) {
    this.minHoldTimeSeconds = profile.min_hold_time_seconds;
    this.maxDailyTrades = profile.max_daily_trades;

    riskLogger.info('Strategy blacklist initialized', {
      minHoldTimeSeconds: this.minHoldTimeSeconds,
      maxDailyTrades: this.maxDailyTrades
    });
  }

  /**
   * Check a proposed order against all blacklisted strategies.
   * Returns approval status and any detected violations.
   */
  check(
    order: OrderRequest,
    openPositions: Position[],
    recentTrades: ClosedTrade[],
    allAccountPositions?: Map<string, Position[]>  // For cross-account hedging check
  ): BlacklistCheckResult {
    const violations: string[] = [];

    // 1. Martingale detection
    const martingale = this.checkMartingale(order, recentTrades);
    if (martingale) violations.push(martingale);

    // 2. Grid without stops
    if (!order.stop_loss || order.stop_loss === 0) {
      violations.push('GRID_NO_STOP: Order has no stop loss — all positions must have hard stops');
    }

    // 3. Max daily trades (HFT prevention)
    if (this.maxDailyTrades !== null && this.dailyTradeCount >= this.maxDailyTrades) {
      violations.push(`HFT_LIMIT: Daily trade count ${this.dailyTradeCount} exceeds max ${this.maxDailyTrades}`);
    }

    // 4. Cross-account hedging
    if (allAccountPositions) {
      const hedging = this.checkCrossAccountHedging(order, allAccountPositions);
      if (hedging) violations.push(hedging);
    }

    if (violations.length > 0) {
      for (const v of violations) {
        riskLogger.warn('Strategy blacklist violation', { violation: v, order });
        eventBus.emitEngine({
          type: 'STRATEGY_BLOCKED',
          strategy: v.split(':')[0],
          reason: v
        });
      }
    }

    return {
      approved: violations.length === 0,
      violations
    };
  }

  /**
   * Check for martingale pattern: is the new order larger than the previous
   * losing trade in the same instrument?
   */
  private checkMartingale(order: OrderRequest, recentTrades: ClosedTrade[]): string | null {
    // Look for the most recent losing trade in the same instrument
    const recentLoss = recentTrades
      .slice(-this.lookbackWindow)
      .reverse()
      .find(t => t.instrument === order.instrument && t.realized_pnl < 0);

    if (!recentLoss) return null;

    // If new order is larger than the losing trade, flag as potential martingale
    if (order.lots > recentLoss.lots * 1.1) { // 10% tolerance for rounding
      return `MARTINGALE: New position ${order.lots} lots > previous loss ${recentLoss.lots} lots on ${order.instrument}`;
    }

    return null;
  }

  /**
   * Check for cross-account hedging: opposing positions across different
   * firm accounts for the same instrument.
   */
  private checkCrossAccountHedging(
    order: OrderRequest,
    allAccountPositions: Map<string, Position[]>
  ): string | null {
    for (const [firmId, positions] of allAccountPositions) {
      for (const pos of positions) {
        if (pos.instrument === order.instrument) {
          // Check for opposing direction
          if (
            (pos.side === 'buy' && order.side === 'sell') ||
            (pos.side === 'sell' && order.side === 'buy')
          ) {
            return `CROSS_ACCOUNT_HEDGE: ${order.side} ${order.instrument} conflicts with ${pos.side} on ${firmId}`;
          }
        }
      }
    }

    return null;
  }

  /**
   * Validate that a closed trade's hold time meets minimum requirements.
   * Called after a trade is closed to flag latency arbitrage patterns.
   */
  validateHoldTime(trade: ClosedTrade): boolean {
    if (trade.hold_time_seconds < this.minHoldTimeSeconds) {
      riskLogger.warn('Hold time violation', {
        tradeId: trade.id,
        holdTime: trade.hold_time_seconds,
        minimum: this.minHoldTimeSeconds
      });
      return false;
    }
    return true;
  }

  /**
   * Increment daily trade counter.
   */
  recordTrade(): void {
    this.dailyTradeCount++;
  }

  /**
   * Reset daily trade counter (called at daily reset).
   */
  resetDailyCount(): void {
    this.dailyTradeCount = 0;
  }

  /**
   * Get current daily trade count.
   */
  getDailyTradeCount(): number {
    return this.dailyTradeCount;
  }
}
