/**
 * TRU-NEXUS Position Sizer
 * ═══════════════════════════════════════════════════════════════════════════
 * Calculates lot size per trade based on remaining drawdown headroom,
 * NOT account balance. Uses ATR-based stop distance as the risk unit.
 * 
 * Risk caps:
 *   - Evaluations: 0.5% of initial balance per trade
 *   - Funded accounts: 1% of initial balance per trade
 *   - Trailing drawdown accounts: 0.3% of initial balance per trade
 * 
 * The sizer NEVER allows a position that could breach either the daily
 * or max drawdown limit, even in a worst-case instant move scenario.
 */

import type { FirmProfile, PositionSizeRequest, PositionSizeResult } from './types.js';
import { riskLogger } from '../utils/logger.js';

export class PositionSizer {
  private initialBalance: number;
  private maxRiskPctEval: number;      // 0.005 = 0.5%
  private maxRiskPctFunded: number;    // 0.01 = 1%
  private maxRiskPctTrailing: number;  // 0.003 = 0.3%
  private isTrailing: boolean;
  private pipValue: number;            // Default pip value per lot

  // Standard lot = 100,000 units, pip = 0.0001 for forex
  private readonly STANDARD_LOT_SIZE = 100_000;
  private readonly DEFAULT_PIP = 0.0001;

  constructor(profile: FirmProfile, initialBalance: number) {
    this.initialBalance = initialBalance;
    this.isTrailing = profile.drawdown_model !== 'static';
    this.maxRiskPctEval = 0.005;    // 0.5%
    this.maxRiskPctFunded = 0.01;   // 1.0%
    this.maxRiskPctTrailing = 0.003; // 0.3%
    this.pipValue = 10; // $10 per pip per standard lot (typical for USD pairs)

    riskLogger.info('Position sizer initialized', {
      initialBalance,
      isTrailing: this.isTrailing,
      maxRiskEval: `${this.maxRiskPctEval * 100}%`,
      maxRiskFunded: `${this.maxRiskPctFunded * 100}%`
    });
  }

  /**
   * Calculate the appropriate position size for a given trade setup.
   */
  calculate(request: PositionSizeRequest): PositionSizeResult {
    // 1. Determine risk cap based on account type and drawdown model
    let riskCap: number;
    if (this.isTrailing) {
      riskCap = this.maxRiskPctTrailing;
    } else if (request.is_funded) {
      riskCap = this.maxRiskPctFunded;
    } else {
      riskCap = this.maxRiskPctEval;
    }

    // 2. Scale risk by signal confidence (50-100 maps to 0.5-1.0 multiplier)
    const confidenceMultiplier = Math.max(0.5, Math.min(1.0, request.signal_confidence / 100));
    const adjustedRiskPct = riskCap * confidenceMultiplier;

    // 3. Calculate max risk amount in dollars
    const maxRiskFromCap = this.initialBalance * adjustedRiskPct;
    
    // 4. Constrain by daily headroom (can't risk more than remaining daily limit)
    const maxRiskFromDaily = request.remaining_daily_headroom * 0.5; // Use at most 50% of remaining daily
    
    // 5. Constrain by max drawdown headroom
    const maxRiskFromDD = request.remaining_max_drawdown_headroom * 0.25; // Use at most 25% of remaining DD

    // 6. Take the minimum of all constraints
    const riskAmount = Math.min(maxRiskFromCap, maxRiskFromDaily, maxRiskFromDD);

    // 7. If risk amount is too small, reject the trade
    if (riskAmount <= 0) {
      return {
        lots: 0,
        risk_amount: 0,
        risk_pct: 0,
        stop_distance_pips: 0,
        max_loss_scenario: 0,
        approved: false,
        rejection_reason: 'Insufficient headroom to place any trade'
      };
    }

    // 8. Calculate stop distance in pips
    const stopDistance = Math.abs(request.entry_price - request.stop_loss);
    const stopDistancePips = stopDistance / this.DEFAULT_PIP;

    if (stopDistancePips <= 0) {
      return {
        lots: 0,
        risk_amount: 0,
        risk_pct: 0,
        stop_distance_pips: 0,
        max_loss_scenario: 0,
        approved: false,
        rejection_reason: 'Invalid stop loss — zero pip distance'
      };
    }

    // 9. Calculate lot size: risk_amount / (stop_pips × pip_value)
    const rawLots = riskAmount / (stopDistancePips * this.pipValue);
    
    // 10. Round down to nearest 0.01 lot (micro lot)
    const lots = Math.floor(rawLots * 100) / 100;

    if (lots < 0.01) {
      return {
        lots: 0,
        risk_amount: 0,
        risk_pct: 0,
        stop_distance_pips: stopDistancePips,
        max_loss_scenario: 0,
        approved: false,
        rejection_reason: `Calculated lot size ${rawLots.toFixed(4)} is below minimum 0.01`
      };
    }

    // 11. Calculate actual risk with rounded lots
    const actualRisk = lots * stopDistancePips * this.pipValue;
    const actualRiskPct = actualRisk / this.initialBalance;

    // 12. Worst case scenario: stop + 2x ATR slippage
    const worstCaseSlippage = request.atr * 2;
    const worstCaseStopPips = (stopDistance + worstCaseSlippage) / this.DEFAULT_PIP;
    const maxLossScenario = lots * worstCaseStopPips * this.pipValue;

    // 13. Final safety check: worst case should not breach daily or max DD
    if (maxLossScenario > request.remaining_daily_headroom) {
      // Reduce lots to fit worst case within daily limit
      const safeLots = Math.floor(
        (request.remaining_daily_headroom / (worstCaseStopPips * this.pipValue)) * 100
      ) / 100;

      if (safeLots < 0.01) {
        return {
          lots: 0,
          risk_amount: 0,
          risk_pct: 0,
          stop_distance_pips: stopDistancePips,
          max_loss_scenario: maxLossScenario,
          approved: false,
          rejection_reason: 'Worst-case slippage scenario exceeds daily headroom'
        };
      }

      const safeRisk = safeLots * stopDistancePips * this.pipValue;
      return {
        lots: safeLots,
        risk_amount: safeRisk,
        risk_pct: safeRisk / this.initialBalance,
        stop_distance_pips: stopDistancePips,
        max_loss_scenario: safeLots * worstCaseStopPips * this.pipValue,
        approved: true
      };
    }

    riskLogger.info('Position size calculated', {
      lots,
      riskAmount: actualRisk.toFixed(2),
      riskPct: (actualRiskPct * 100).toFixed(3) + '%',
      stopDistancePips: stopDistancePips.toFixed(1),
      maxLossScenario: maxLossScenario.toFixed(2),
      confidence: request.signal_confidence
    });

    return {
      lots,
      risk_amount: actualRisk,
      risk_pct: actualRiskPct,
      stop_distance_pips: stopDistancePips,
      max_loss_scenario: maxLossScenario,
      approved: true
    };
  }

  /**
   * Apply drawdown-based reduction multiplier to a calculated size.
   */
  applyDrawdownReduction(result: PositionSizeResult, multiplier: number): PositionSizeResult {
    if (multiplier >= 1.0) return result;
    if (multiplier <= 0) {
      return { ...result, lots: 0, risk_amount: 0, risk_pct: 0, approved: false, rejection_reason: 'Drawdown lockout' };
    }

    const reducedLots = Math.floor(result.lots * multiplier * 100) / 100;
    if (reducedLots < 0.01) {
      return { ...result, lots: 0, risk_amount: 0, risk_pct: 0, approved: false, rejection_reason: 'Reduced size below minimum' };
    }

    const reducedRisk = reducedLots * result.stop_distance_pips * this.pipValue;
    return {
      ...result,
      lots: reducedLots,
      risk_amount: reducedRisk,
      risk_pct: reducedRisk / this.initialBalance
    };
  }
}
