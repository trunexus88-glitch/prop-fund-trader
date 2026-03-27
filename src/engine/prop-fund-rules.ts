/**
 * TRU-NEXUS Prop Fund Rules
 * ═══════════════════════════════════════════════════════════════════════════
 * Configuration and constraint-checking for the target $5K prop fund account.
 * These rules gate every trade decision and determine "READY" status for
 * live deployment after the 2-week paper trading period.
 *
 * Target account constraints (prop fund paper trading phase):
 *   - 3% daily loss limit ($150/day on $5K)
 *   - 6% trailing max drawdown ($300 total)
 *   - 90% profit split
 *   - 50:1 leverage available
 *   - No profit target, no time limit
 *   - Consistency: no single day > 15% of total profit
 */

// ─── Prop Fund Configuration ─────────────────────────────────────────────────

export interface PropFundRules {
  accountSize: number;
  dailyLossLimit: number;         // Fraction e.g. 0.03 = 3%
  maxTrailingDrawdown: number;    // Fraction e.g. 0.06 = 6%
  profitSplit: number;            // Fraction e.g. 0.90 = 90%
  leverage: number;               // e.g. 50
  consistencyRule: number;        // Max single day as fraction of total profit
  weekendHolding: boolean;
  noTimeLimit: boolean;
  noMinProfitTarget: boolean;
  // Operational thresholds (more conservative than the hard limits)
  dailyLossCutoffPct: number;     // Stop new trades before hitting hard limit
  drawdownReducePct: number;      // Reduce position sizes at this drawdown %
  drawdownHaltPct: number;        // Halt new trades entirely at this drawdown %
  maxRiskPerTradePct: number;     // Max % of account risked per trade
}

export const PROP_FUND_RULES: PropFundRules = {
  accountSize: 5000,
  dailyLossLimit: 0.03,           // 3% = $150/day
  maxTrailingDrawdown: 0.06,      // 6% = $300 total
  profitSplit: 0.90,              // Keep 90% of profits
  leverage: 50,                   // 50:1 available
  consistencyRule: 0.15,          // No single day > 15% of total profit
  weekendHolding: true,
  noTimeLimit: true,
  noMinProfitTarget: true,

  // Operational thresholds (leave a buffer before the hard limits fire)
  dailyLossCutoffPct: 0.025,      // Stop new trades at 2.5% (0.5% buffer before 3%)
  drawdownReducePct: 0.05,        // Reduce positions 50% at 5% drawdown
  drawdownHaltPct: 0.055,         // Halt all new trades at 5.5% drawdown
  maxRiskPerTradePct: 0.01,       // 1% per trade = $50 on $5K account
};

// ─── Derived Dollar Values ────────────────────────────────────────────────────

export function getDailyLossLimitDollars(rules: PropFundRules): number {
  return rules.accountSize * rules.dailyLossLimit;
}

export function getDailyLossCutoffDollars(rules: PropFundRules): number {
  return rules.accountSize * rules.dailyLossCutoffPct;
}

export function getMaxDrawdownDollars(rules: PropFundRules): number {
  return rules.accountSize * rules.maxTrailingDrawdown;
}

export function getMaxRiskPerTrade(rules: PropFundRules): number {
  return rules.accountSize * rules.maxRiskPerTradePct;
}

// ─── Constraint Checkers ──────────────────────────────────────────────────────

/**
 * Check if today's P&L is approaching or breaching the daily loss limit.
 * todayPnL is a signed value: negative = loss.
 * Returns: 'ok' | 'warning' | 'cutoff' | 'breach'
 */
export function checkDailyLoss(
  todayPnL: number,
  rules: PropFundRules
): 'ok' | 'warning' | 'cutoff' | 'breach' {
  const loss = -todayPnL; // Convert to positive loss amount
  if (loss <= 0) return 'ok';

  const cutoffDollars = getDailyLossCutoffDollars(rules);
  const limitDollars = getDailyLossLimitDollars(rules);

  if (loss >= limitDollars) return 'breach';
  if (loss >= cutoffDollars) return 'cutoff';
  if (loss >= cutoffDollars * 0.7) return 'warning'; // 70% of cutoff
  return 'ok';
}

/**
 * Check if drawdown from peak is approaching or breaching the trailing limit.
 * Returns: 'ok' | 'warning' | 'reduce' | 'halt' | 'breach'
 */
export function checkDrawdown(
  peakEquity: number,
  currentEquity: number,
  rules: PropFundRules
): 'ok' | 'warning' | 'reduce' | 'halt' | 'breach' {
  if (peakEquity <= 0) return 'ok';

  const drawdownPct = (peakEquity - currentEquity) / peakEquity;
  if (drawdownPct <= 0) return 'ok';

  if (drawdownPct >= rules.maxTrailingDrawdown) return 'breach';
  if (drawdownPct >= rules.drawdownHaltPct) return 'halt';
  if (drawdownPct >= rules.drawdownReducePct) return 'reduce';
  if (drawdownPct >= rules.drawdownReducePct * 0.8) return 'warning';
  return 'ok';
}

/**
 * Check if the consistency rule is satisfied.
 * No single day should account for more than consistencyRule % of total profit.
 * Returns: 'ok' | 'warning' | 'breach'
 */
export function checkConsistency(
  dailyPnLs: number[],
  rules: PropFundRules
): 'ok' | 'warning' | 'breach' {
  const totalProfit = dailyPnLs.reduce((s, p) => s + Math.max(0, p), 0);
  if (totalProfit <= 0) return 'ok'; // No profit yet, nothing to check

  const maxDay = Math.max(...dailyPnLs.map(p => Math.max(0, p)));
  const maxDayPct = maxDay / totalProfit;

  if (maxDayPct > rules.consistencyRule) return 'breach';
  if (maxDayPct > rules.consistencyRule * 0.8) return 'warning';
  return 'ok';
}

/**
 * Check if the position size multiplier should be reduced due to drawdown.
 * Returns 1.0 (full), 0.5 (half), or 0.0 (halt).
 */
export function getDrawdownSizeMultiplier(
  peakEquity: number,
  currentEquity: number,
  rules: PropFundRules
): number {
  const status = checkDrawdown(peakEquity, currentEquity, rules);
  switch (status) {
    case 'halt':
    case 'breach':
      return 0.0;
    case 'reduce':
      return 0.5;
    default:
      return 1.0;
  }
}

/**
 * Check if new trades are allowed given current daily P&L.
 */
export function canOpenNewTrade(todayPnL: number, rules: PropFundRules): boolean {
  const status = checkDailyLoss(todayPnL, rules);
  return status === 'ok' || status === 'warning';
}
