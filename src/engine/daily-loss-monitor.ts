/**
 * TRU-NEXUS Daily Loss Limit Monitor
 * ═══════════════════════════════════════════════════════════════════════════
 * Tracks daily P&L (closed + floating) against the firm's daily loss limit.
 * Resets at the configured time each trading day.
 * 
 * The daily loss limit is the rule that catches the most traders off guard
 * because it includes unrealized (floating) losses on open positions.
 * 
 * Basis types:
 *   - initial_balance: 5% of initial balance, fixed forever
 *   - current_balance: 5% of balance at day reset (dynamic)
 *   - equity_at_reset: 5% of equity at day reset
 * 
 * Behavior:
 *   - 70% consumed → no new positions allowed
 *   - 85% consumed → flatten ALL positions immediately
 */

import type { FirmProfile, DailyLossBasis, Position, ClosedTrade } from './types.js';
import { eventBus } from '../utils/event-bus.js';
import { riskLogger } from '../utils/logger.js';

export interface DailyLossState {
  daily_limit: number;
  daily_loss_used: number;     // Closed P&L + floating P&L (negative = losses)
  closed_pnl: number;
  floating_pnl: number;
  consumed_pct: number;        // 0.0 to 1.0
  is_warning: boolean;         // 70% consumed
  is_critical: boolean;        // 85% consumed
  is_breached: boolean;        // 100% consumed
  can_open_new: boolean;       // false if >= 70% consumed
  basis: DailyLossBasis;
  reset_time_utc: string;
}

export class DailyLossMonitor {
  private dailyLossPct: number | null;
  private basis: DailyLossBasis;
  private resetTimeUtc: string;
  private initialBalance: number;
  private balanceAtReset: number;
  private equityAtReset: number;
  private dailyLimit: number;
  private closedPnlToday: number = 0;
  private lastResetDate: string;

  // Thresholds
  private readonly NO_NEW_TRADES_THRESHOLD = 0.70;   // 70% consumed
  private readonly FLATTEN_ALL_THRESHOLD = 0.85;      // 85% consumed

  constructor(profile: FirmProfile, initialBalance: number, currentEquity?: number) {
    this.dailyLossPct = profile.daily_loss_pct;
    this.basis = profile.daily_loss_basis;
    this.resetTimeUtc = profile.daily_reset_utc;
    this.initialBalance = initialBalance;
    this.balanceAtReset = initialBalance;
    this.equityAtReset = currentEquity ?? initialBalance;
    this.lastResetDate = new Date().toISOString().split('T')[0];

    this.dailyLimit = this.calculateDailyLimit();

    riskLogger.info('Daily loss monitor initialized', {
      dailyLossPct: this.dailyLossPct,
      basis: this.basis,
      dailyLimit: this.dailyLimit,
      resetTimeUtc: this.resetTimeUtc
    });
  }

  /**
   * Calculate the daily loss limit based on the configured basis.
   */
  private calculateDailyLimit(): number {
    if (this.dailyLossPct === null) return Infinity; // No daily limit

    switch (this.basis) {
      case 'initial_balance':
        return this.initialBalance * this.dailyLossPct;
      case 'current_balance':
        return this.balanceAtReset * this.dailyLossPct;
      case 'equity_at_reset':
        return this.equityAtReset * this.dailyLossPct;
      default:
        return this.initialBalance * this.dailyLossPct;
    }
  }

  /**
   * Perform a daily reset. Called when the server clock hits the reset time.
   */
  performDailyReset(currentBalance: number, currentEquity: number): void {
    const today = new Date().toISOString().split('T')[0];
    if (today === this.lastResetDate) return; // Already reset today

    this.balanceAtReset = currentBalance;
    this.equityAtReset = currentEquity;
    this.closedPnlToday = 0;
    this.lastResetDate = today;
    this.dailyLimit = this.calculateDailyLimit();

    riskLogger.info('Daily loss limit reset', {
      date: today,
      balanceAtReset: currentBalance,
      equityAtReset: currentEquity,
      newDailyLimit: this.dailyLimit
    });

    eventBus.emitEngine({
      type: 'DAILY_RESET',
      new_daily_limit: this.dailyLimit
    });
  }

  /**
   * Record a closed trade's P&L for today.
   */
  recordClosedTrade(pnl: number): void {
    this.closedPnlToday += pnl;
  }

  /**
   * Update with current floating P&L from all open positions.
   * Returns the current daily loss state.
   */
  update(openPositions: Position[]): DailyLossState {
    if (this.dailyLossPct === null) {
      return this.noLimitState();
    }

    // Calculate total floating P&L from open positions
    const floatingPnl = openPositions.reduce((sum, pos) => sum + pos.unrealized_pnl, 0);
    
    // Total daily loss = closed losses + floating losses
    // We track the negative direction (losses)
    const totalDailyPnl = this.closedPnlToday + floatingPnl;
    
    // Daily loss is measured as how much has been LOST (negative pnl = loss consumed)
    const dailyLossUsed = Math.max(0, -totalDailyPnl); // Convert negative P&L to positive loss
    const consumedPct = this.dailyLimit > 0 ? Math.min(1, dailyLossUsed / this.dailyLimit) : 0;

    const isWarning = consumedPct >= this.NO_NEW_TRADES_THRESHOLD && consumedPct < this.FLATTEN_ALL_THRESHOLD;
    const isCritical = consumedPct >= this.FLATTEN_ALL_THRESHOLD && consumedPct < 1.0;
    const isBreached = consumedPct >= 1.0;

    // Emit events
    if (isBreached) {
      eventBus.emitEngine({
        type: 'KILL_SWITCH_TRIGGERED',
        reason: `Daily loss limit breached. Loss ${dailyLossUsed.toFixed(2)} >= limit ${this.dailyLimit.toFixed(2)}`,
        timestamp: new Date().toISOString()
      });
    } else if (isCritical) {
      eventBus.emitEngine({
        type: 'DAILY_LOSS_CRITICAL',
        used_pct: consumedPct
      });
    } else if (isWarning) {
      eventBus.emitEngine({
        type: 'DAILY_LOSS_WARNING',
        used_pct: consumedPct
      });
    }

    return {
      daily_limit: this.dailyLimit,
      daily_loss_used: dailyLossUsed,
      closed_pnl: this.closedPnlToday,
      floating_pnl: floatingPnl,
      consumed_pct: consumedPct,
      is_warning: isWarning,
      is_critical: isCritical,
      is_breached: isBreached,
      can_open_new: consumedPct < this.NO_NEW_TRADES_THRESHOLD,
      basis: this.basis,
      reset_time_utc: this.resetTimeUtc
    };
  }

  /**
   * Get remaining daily headroom in dollars.
   */
  getRemainingHeadroom(openPositions: Position[]): number {
    if (this.dailyLossPct === null) return Infinity;
    const state = this.update(openPositions);
    return Math.max(0, this.dailyLimit - state.daily_loss_used);
  }

  /**
   * Check if it's safe to enter a new trade given the current daily loss state.
   */
  canOpenNewPosition(openPositions: Position[]): boolean {
    if (this.dailyLossPct === null) return true;
    const state = this.update(openPositions);
    return state.can_open_new;
  }

  /** Returns the current daily limit value */
  getDailyLimit(): number {
    return this.dailyLimit;
  }

  /** Returns today's closed P&L */
  getClosedPnlToday(): number {
    return this.closedPnlToday;
  }

  private noLimitState(): DailyLossState {
    return {
      daily_limit: Infinity,
      daily_loss_used: 0,
      closed_pnl: this.closedPnlToday,
      floating_pnl: 0,
      consumed_pct: 0,
      is_warning: false,
      is_critical: false,
      is_breached: false,
      can_open_new: true,
      basis: this.basis,
      reset_time_utc: this.resetTimeUtc
    };
  }
}
