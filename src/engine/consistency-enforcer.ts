/**
 * TRU-NEXUS Consistency Enforcer
 * ═══════════════════════════════════════════════════════════════════════════
 * Tracks daily P&L as a percentage of total challenge profits.
 * If any single day would exceed the firm's consistency threshold
 * (e.g., 40% for FundedNext), position sizes are reduced for the remainder
 * of that session.
 */

import type { FirmProfile } from './types.js';
import { eventBus } from '../utils/event-bus.js';
import { riskLogger } from '../utils/logger.js';

export interface ConsistencyState {
  consistency_threshold: number | null;
  total_challenge_profit: number;
  todays_profit: number;
  todays_profit_pct_of_total: number;
  is_approaching_limit: boolean;          // > threshold * 0.7
  is_at_limit: boolean;                   // >= threshold
  position_size_multiplier: number;       // 1.0, 0.5, or 0.25
}

export class ConsistencyEnforcer {
  private threshold: number | null;         // e.g., 0.40 = 40%
  private totalChallengeProfit: number = 0;
  private dailyProfit: number = 0;
  private dailyProfits: Map<string, number> = new Map(); // date → profit

  constructor(profile: FirmProfile) {
    this.threshold = profile.consistency_rule_pct;
    
    riskLogger.info('Consistency enforcer initialized', {
      threshold: this.threshold ? `${this.threshold * 100}%` : 'none'
    });
  }

  /**
   * Update today's profit figure.
   */
  updateDailyProfit(profit: number): ConsistencyState {
    this.dailyProfit = profit;
    return this.getState();
  }

  /**
   * Record end-of-day profit and add to total.
   */
  recordEndOfDay(dailyProfit: number): void {
    const today = new Date().toISOString().split('T')[0];
    this.dailyProfits.set(today, dailyProfit);
    
    if (dailyProfit > 0) {
      this.totalChallengeProfit += dailyProfit;
    }
    
    this.dailyProfit = 0;

    riskLogger.info('Consistency EOD recorded', {
      date: today,
      dailyProfit,
      totalChallengeProfit: this.totalChallengeProfit
    });
  }

  /**
   * Set the total challenge profit (for initialization from trade history).
   */
  setTotalChallengeProfit(total: number): void {
    this.totalChallengeProfit = total;
  }

  /**
   * Get the current consistency state.
   */
  getState(): ConsistencyState {
    if (this.threshold === null) {
      return {
        consistency_threshold: null,
        total_challenge_profit: this.totalChallengeProfit,
        todays_profit: this.dailyProfit,
        todays_profit_pct_of_total: 0,
        is_approaching_limit: false,
        is_at_limit: false,
        position_size_multiplier: 1.0
      };
    }

    // Calculate what % of total profits today's profit represents
    // Add today's profit to total for the calculation
    const projectedTotal = this.totalChallengeProfit + Math.max(0, this.dailyProfit);
    const todaysPctOfTotal = projectedTotal > 0
      ? Math.max(0, this.dailyProfit) / projectedTotal
      : 0;

    const isApproaching = todaysPctOfTotal > this.threshold * 0.7;
    const isAtLimit = todaysPctOfTotal >= this.threshold;

    let multiplier = 1.0;
    if (isAtLimit) {
      multiplier = 0.25; // Drastically reduce
    } else if (isApproaching) {
      multiplier = 0.5;  // Moderate reduction
    }

    // Emit warning
    if (isApproaching) {
      eventBus.emitEngine({
        type: 'CONSISTENCY_WARNING',
        daily_pct: todaysPctOfTotal,
        threshold: this.threshold
      });
    }

    return {
      consistency_threshold: this.threshold,
      total_challenge_profit: this.totalChallengeProfit,
      todays_profit: this.dailyProfit,
      todays_profit_pct_of_total: todaysPctOfTotal,
      is_approaching_limit: isApproaching,
      is_at_limit: isAtLimit,
      position_size_multiplier: multiplier
    };
  }

  /**
   * Get the position size multiplier based on consistency rules.
   */
  getPositionSizeMultiplier(): number {
    return this.getState().position_size_multiplier;
  }
}
