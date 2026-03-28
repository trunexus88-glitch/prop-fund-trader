/**
 * TRU-NEXUS Drawdown Monitor
 * ═══════════════════════════════════════════════════════════════════════════
 * Tracks equity against the prop firm's maximum drawdown limit.
 * Supports all three drawdown models: static, trailing EOD, trailing realtime.
 * 
 * This is DETERMINISTIC code — zero AI inference. It is the primary safety
 * mechanism that keeps prop firm accounts alive.
 * 
 * Behavior:
 *   - Static: floor = initial_balance × (1 - max_dd_pct), never changes
 *   - Trailing EOD: floor = max(initial_floor, peak_equity_eod - trail_amount)
 *   - Trailing Realtime: floor = max(initial_floor, peak_equity_rt - trail_amount)
 * 
 * Warning levels:
 *   - 80% consumed → reduce position sizes by 50%
 *   - 90% consumed → full lockout (no new positions)
 *   - 100% consumed → BREACH (kill switch fires)
 */

import type { DrawdownModel, DrawdownState, AccountState, FirmProfile } from './types.js';
import { eventBus } from '../utils/event-bus.js';
import { riskLogger } from '../utils/logger.js';

export class DrawdownMonitor {
  private model: DrawdownModel;
  private initialBalance: number;
  private maxDrawdownPct: number;
  private floor: number;
  private peakEquity: number;
  private trailAmount: number;
  private initialFloor: number;

  // Configurable thresholds
  private readonly WARNING_THRESHOLD = 0.80;   // 80% of drawdown consumed
  private readonly CRITICAL_THRESHOLD = 0.90;  // 90% → full lockout

  // One-shot emission flags — each state transition fires its event exactly once.
  // Without these, every call to calculateState() re-emits while breached,
  // which fires the kill switch dozens of times per minute (event storm).
  private hasEmittedWarning  = false;
  private hasEmittedCritical = false;
  private hasEmittedBreach   = false;
  private lastHeartbeatMs    = 0;               // Rate-limit the heartbeat log

  constructor(profile: FirmProfile, initialBalance: number) {
    this.model = profile.drawdown_model;
    this.initialBalance = initialBalance;
    this.maxDrawdownPct = profile.max_drawdown_pct;
    this.trailAmount = initialBalance * profile.max_drawdown_pct;
    this.peakEquity = initialBalance;

    // Calculate initial floor based on model
    if (this.model === 'static') {
      this.floor = initialBalance * (1 - profile.max_drawdown_pct);
    } else {
      // Trailing models: initial floor is initial_balance - trail_amount
      this.floor = initialBalance - this.trailAmount;
    }

    this.initialFloor = this.floor;

    riskLogger.info('Drawdown monitor initialized', {
      model: this.model,
      initialBalance,
      floor: this.floor,
      trailAmount: this.trailAmount,
      maxDrawdownPct: this.maxDrawdownPct
    });
  }

  /**
   * Update with current equity. Call on every tick / price update.
   * Returns the current drawdown state.
   */
  update(currentEquity: number): DrawdownState {
    // Update peak equity for trailing models
    if (this.model === 'trailing_realtime') {
      this.updatePeakAndFloor(currentEquity);
    }
    // For trailing_eod, peak/floor only updates at EOD (see updateEndOfDay)

    // Static model: floor never changes, peak tracking is informational only
    if (this.model === 'static') {
      if (currentEquity > this.peakEquity) {
        this.peakEquity = currentEquity;
      }
    }

    return this.calculateState(currentEquity);
  }

  /**
   * Called at end-of-day for trailing EOD models.
   * This is when the floor ratchets up.
   */
  updateEndOfDay(equityAtClose: number): DrawdownState {
    if (this.model === 'trailing_eod') {
      this.updatePeakAndFloor(equityAtClose);
      riskLogger.info('EOD drawdown update', {
        equityAtClose,
        newPeak: this.peakEquity,
        newFloor: this.floor
      });
    }
    return this.calculateState(equityAtClose);
  }

  /**
   * Core trailing logic: update peak equity and ratchet floor upward.
   */
  private updatePeakAndFloor(equity: number): void {
    if (equity > this.peakEquity) {
      this.peakEquity = equity;
      const newFloor = this.peakEquity - this.trailAmount;
      // Floor only moves UP, never down
      if (newFloor > this.floor) {
        const oldFloor = this.floor;
        this.floor = newFloor;
        riskLogger.info('Drawdown floor ratcheted up', {
          model: this.model,
          oldFloor,
          newFloor: this.floor,
          peakEquity: this.peakEquity,
          trailAmount: this.trailAmount
        });
      }
    }
  }

  /**
   * Calculate the full drawdown state snapshot.
   */
  private calculateState(currentEquity: number): DrawdownState {
    const totalDrawdownAllowed = this.model === 'static'
      ? this.initialBalance * this.maxDrawdownPct
      : this.trailAmount;

    const remainingHeadroom = Math.max(0, currentEquity - this.floor);
    const drawdownUsed = totalDrawdownAllowed - remainingHeadroom;
    const consumedPct = totalDrawdownAllowed > 0
      ? Math.min(1, Math.max(0, drawdownUsed / totalDrawdownAllowed))
      : 0;

    const isWarning = consumedPct >= this.WARNING_THRESHOLD && consumedPct < this.CRITICAL_THRESHOLD;
    const isCritical = consumedPct >= this.CRITICAL_THRESHOLD && consumedPct < 1.0;
    const isBreached = currentEquity <= this.floor;

    // Emit events — one-shot per state transition to prevent event storms.
    // Each flag is set on first emission and only cleared on reset/recovery.
    if (isBreached) {
      if (!this.hasEmittedBreach) {
        this.hasEmittedBreach = true;
        riskLogger.error('[drawdown-monitor] BREACH — equity below floor. Trading halted.', {
          currentEquity: currentEquity.toFixed(2),
          floor: this.floor.toFixed(2),
          model: this.model
        });
        eventBus.emitEngine({
          type: 'KILL_SWITCH_TRIGGERED',
          reason: `Max drawdown breached. Equity ${currentEquity.toFixed(2)} <= floor ${this.floor.toFixed(2)}`,
          timestamp: new Date().toISOString()
        });
      } else {
        // Heartbeat log once per minute while locked — not every 2s tick
        if (Date.now() - this.lastHeartbeatMs > 60_000) {
          this.lastHeartbeatMs = Date.now();
          riskLogger.debug('[drawdown-monitor] Still locked — equity below floor', {
            currentEquity: currentEquity.toFixed(2),
            floor: this.floor.toFixed(2)
          });
        }
      }
    } else {
      // Equity recovered above floor — reset breach flag so it re-fires if
      // the floor is breached again after a reset or new peak.
      if (this.hasEmittedBreach) {
        this.hasEmittedBreach = false;
        riskLogger.info('[drawdown-monitor] Equity recovered above floor', {
          currentEquity: currentEquity.toFixed(2),
          floor: this.floor.toFixed(2)
        });
      }

      if (isCritical && !this.hasEmittedCritical) {
        this.hasEmittedCritical = true;
        this.hasEmittedWarning  = true; // Critical implies warning
        eventBus.emitEngine({
          type: 'DRAWDOWN_CRITICAL',
          level: consumedPct,
          remaining_pct: 1 - consumedPct
        });
      } else if (!isCritical && this.hasEmittedCritical) {
        this.hasEmittedCritical = false; // Recovered from critical
      }

      if (isWarning && !this.hasEmittedWarning) {
        this.hasEmittedWarning = true;
        eventBus.emitEngine({
          type: 'DRAWDOWN_WARNING',
          level: consumedPct,
          remaining_pct: 1 - consumedPct
        });
      } else if (!isWarning && this.hasEmittedWarning) {
        this.hasEmittedWarning = false; // Recovered from warning
      }
    }

    return {
      model: this.model,
      initial_balance: this.initialBalance,
      floor: this.floor,
      peak_equity: this.peakEquity,
      current_equity: currentEquity,
      consumed_pct: consumedPct,
      remaining_headroom: remainingHeadroom,
      is_warning: isWarning,
      is_critical: isCritical,
      is_breached: isBreached
    };
  }

  /**
   * Get the position size reduction factor based on current drawdown consumption.
   * - < 80% consumed → 1.0 (full size)
   * - 80-90% consumed → 0.5 (half size) 
   * - > 90% consumed → 0.0 (no new positions)
   */
  getPositionSizeMultiplier(currentEquity: number): number {
    const state = this.calculateState(currentEquity);
    if (state.is_critical || state.is_breached) return 0;
    if (state.is_warning) return 0.5;
    return 1.0;
  }

  /** Get the current floor value */
  getFloor(): number {
    return this.floor;
  }

  /** Get remaining headroom in dollars */
  getRemainingHeadroom(currentEquity: number): number {
    return Math.max(0, currentEquity - this.floor);
  }

  /** Get peak equity */
  getPeakEquity(): number {
    return this.peakEquity;
  }

  /** Get the drawdown model */
  getModel(): DrawdownModel {
    return this.model;
  }

  /**
   * Returns true if current equity is genuinely below the floor.
   * Use this to decide whether to auto-reset the kill switch after a pip-calc
   * fix or other correction.
   */
  isCurrentlyBreached(currentEquity: number): boolean {
    return currentEquity <= this.floor;
  }

  /**
   * Reset all one-shot emission flags. Called:
   *   - On daily reset (a new trading day is a clean slate for warnings)
   *   - After an operator-acknowledged kill switch reset
   * Does NOT reset the floor or peak — those are risk rails, not counters.
   */
  resetEmissionFlags(): void {
    this.hasEmittedWarning  = false;
    this.hasEmittedCritical = false;
    this.hasEmittedBreach   = false;
    this.lastHeartbeatMs    = 0;
    riskLogger.info('[drawdown-monitor] Emission flags reset');
  }
}
