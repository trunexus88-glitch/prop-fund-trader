/**
 * TRU-NEXUS Capital Compounding Protocol
 * ═══════════════════════════════════════════════════════════════════════════
 * Defines how profits from funded accounts are reinvested into purchasing
 * larger evaluations. This is the scaling mechanism from $5K → $150K+.
 * 
 * Rules:
 *   - 60% of profits → reinvestment pool
 *   - 40% of profits → personal income
 *   - When pool reaches next tier eval cost → purchase immediately
 *   - Always maintain 3-evaluation safety reserve
 */

import type { CompoundingState, FundedAccount, EvaluationAccount, Payout } from '../engine/types.js';
import { logger } from '../utils/logger.js';

export const COMPOUNDING_SPLIT = {
  reinvestment: 0.60,
  personal: 0.40
};

export const PROGRESSION_TIERS = [
  { firmId: 'onefunded_5k', cost: 23, fundedCapital: 5000, tier: 'tier1' },
  { firmId: 'fundednext_6k', cost: 49, fundedCapital: 6000, tier: 'tier1' },
  { firmId: 'ftmo_25k', cost: 200, fundedCapital: 25000, tier: 'tier2' },
  { firmId: 'ftmo_100k_phase1', cost: 540, fundedCapital: 100000, tier: 'tier2' },
  { firmId: 'fxify_100k', cost: 399, fundedCapital: 100000, tier: 'tier2' },
];

export class CompoundingProtocol {
  private state: CompoundingState;

  constructor() {
    this.state = {
      total_profits: 0,
      reinvestment_pool: 0,
      personal_income: 0,
      active_funded_accounts: [],
      pending_evaluations: [],
      completed_payouts: [],
      safety_reserve: 0
    };

    logger.info('Compounding protocol initialized');
  }

  /**
   * Record a payout from a funded account.
   * Automatically splits into reinvestment pool and personal income.
   */
  recordPayout(firmId: string, amount: number): Payout {
    const toReinvestment = amount * COMPOUNDING_SPLIT.reinvestment;
    const toPersonal = amount * COMPOUNDING_SPLIT.personal;

    this.state.total_profits += amount;
    this.state.reinvestment_pool += toReinvestment;
    this.state.personal_income += toPersonal;

    const payout: Payout = {
      firm_id: firmId,
      amount,
      date: new Date().toISOString(),
      to_reinvestment: toReinvestment,
      to_personal: toPersonal
    };

    this.state.completed_payouts.push(payout);

    // Update funded account stats
    const account = this.state.active_funded_accounts.find(a => a.firm_id === firmId);
    if (account) {
      account.total_payouts += amount;
      account.successful_payout_count++;
    }

    logger.info('Payout recorded', {
      firmId,
      amount,
      toReinvestment,
      toPersonal,
      poolBalance: this.state.reinvestment_pool
    });

    // Check if we can purchase next tier
    this.checkProgression();

    return payout;
  }

  /**
   * Check if the reinvestment pool has enough for the next tier evaluation.
   */
  checkProgression(): { canPurchase: boolean; nextTier: typeof PROGRESSION_TIERS[0] | null } {
    // Find the next tier we haven't started
    const activeIds = new Set([
      ...this.state.active_funded_accounts.map(a => a.firm_id),
      ...this.state.pending_evaluations.map(a => a.firm_id)
    ]);

    const nextTier = PROGRESSION_TIERS.find(t => !activeIds.has(t.firmId));
    if (!nextTier) {
      return { canPurchase: false, nextTier: null };
    }

    // Need: eval cost + 3x safety reserve
    const safetyReserve = nextTier.cost * 3;
    const totalNeeded = nextTier.cost + safetyReserve;
    const canPurchase = this.state.reinvestment_pool >= totalNeeded;

    if (canPurchase) {
      logger.info('Next tier evaluation available', {
        tier: nextTier.firmId,
        cost: nextTier.cost,
        poolBalance: this.state.reinvestment_pool,
        safetyReserve
      });
    }

    return { canPurchase, nextTier };
  }

  /**
   * Purchase an evaluation from the reinvestment pool.
   */
  purchaseEvaluation(firmId: string, cost: number): EvaluationAccount | null {
    if (this.state.reinvestment_pool < cost) {
      logger.warn('Insufficient funds for evaluation', {
        firmId,
        cost,
        available: this.state.reinvestment_pool
      });
      return null;
    }

    this.state.reinvestment_pool -= cost;

    const eval_: EvaluationAccount = {
      firm_id: firmId,
      eval_cost: cost,
      current_phase: 1,
      start_date: new Date().toISOString(),
      status: 'in_progress'
    };

    this.state.pending_evaluations.push(eval_);

    logger.info('Evaluation purchased', {
      firmId,
      cost,
      remainingPool: this.state.reinvestment_pool
    });

    return eval_;
  }

  /**
   * Mark an evaluation as passed and create a funded account.
   */
  evaluationPassed(firmId: string, fundedBalance: number): void {
    const evalIndex = this.state.pending_evaluations.findIndex(e => e.firm_id === firmId);
    if (evalIndex >= 0) {
      this.state.pending_evaluations[evalIndex].status = 'passed';
      this.state.pending_evaluations.splice(evalIndex, 1);
    }

    const funded: FundedAccount = {
      firm_id: firmId,
      funded_balance: fundedBalance,
      total_payouts: 0,
      successful_payout_count: 0,
      status: 'active'
    };

    this.state.active_funded_accounts.push(funded);

    logger.info('Evaluation passed — funded account created', {
      firmId,
      fundedBalance
    });
  }

  /**
   * Mark an evaluation as failed.
   */
  evaluationFailed(firmId: string): void {
    const evalIndex = this.state.pending_evaluations.findIndex(e => e.firm_id === firmId);
    if (evalIndex >= 0) {
      this.state.pending_evaluations[evalIndex].status = 'failed';
      this.state.pending_evaluations.splice(evalIndex, 1);
    }

    logger.warn('Evaluation failed', { firmId });
  }

  /**
   * Get the full compounding state.
   */
  getState(): CompoundingState {
    return { ...this.state };
  }

  /**
   * Get projected timeline based on current performance.
   */
  getProjectedTimeline(monthlyReturnPct: number = 0.04): {
    month: number;
    funded_capital: number;
    monthly_revenue: number;
  }[] {
    const timeline = [];
    let fundedCapital = this.state.active_funded_accounts
      .reduce((s, a) => s + a.funded_balance, 0);
    
    for (let month = 1; month <= 6; month++) {
      const revenue = fundedCapital * monthlyReturnPct;
      fundedCapital += revenue * COMPOUNDING_SPLIT.reinvestment;
      
      timeline.push({
        month,
        funded_capital: Math.round(fundedCapital),
        monthly_revenue: Math.round(revenue)
      });
    }

    return timeline;
  }
}
