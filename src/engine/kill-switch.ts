/**
 * TRU-NEXUS Kill Switch
 * ═══════════════════════════════════════════════════════════════════════════
 * Emergency position flatten with market orders. Fires when ANY rule is
 * within 5% of breach.
 * 
 * Target latency: trigger → flat-all confirmation < 500ms (local execution).
 * 
 * The kill switch is the last line of defense. It cannot be overridden
 * by any other component, including the AI signal layer.
 */

import type { TradingAdapter, ClosedTrade, Position } from './types.js';
import { eventBus } from '../utils/event-bus.js';
import { riskLogger } from '../utils/logger.js';

export interface KillSwitchState {
  is_armed: boolean;
  is_triggered: boolean;
  trigger_reason: string | null;
  trigger_timestamp: string | null;
  flatten_latency_ms: number | null;
  positions_closed: number;
}

export class KillSwitch {
  private isArmed: boolean = true;
  private isTriggered: boolean = false;
  private triggerReason: string | null = null;
  private triggerTimestamp: string | null = null;
  private flattenLatencyMs: number | null = null;
  private positionsClosed: number = 0;
  private adapter: TradingAdapter | null = null;
  private isExecuting: boolean = false;

  constructor() {
    // Listen for kill switch events from other engine components
    eventBus.on('KILL_SWITCH_TRIGGERED', (event: unknown) => {
      const e = event as { reason: string; timestamp: string };
      this.trigger(e.reason);
    });

    riskLogger.info('Kill switch initialized and armed');
  }

  /**
   * Set the trading adapter for order execution.
   */
  setAdapter(adapter: TradingAdapter): void {
    this.adapter = adapter;
  }

  /**
   * Trigger the kill switch — flatten ALL positions immediately.
   * This is an irreversible action for the current session.
   */
  async trigger(reason: string): Promise<ClosedTrade[]> {
    if (this.isExecuting) {
      riskLogger.warn('Kill switch already executing, ignoring duplicate trigger');
      return [];
    }

    if (!this.isArmed) {
      riskLogger.warn('Kill switch is disarmed — NOT flattening', { reason });
      return [];
    }

    this.isExecuting = true;
    const startTime = performance.now();

    riskLogger.error('🚨 KILL SWITCH TRIGGERED', { reason });

    this.isTriggered = true;
    this.triggerReason = reason;
    this.triggerTimestamp = new Date().toISOString();

    let closedTrades: ClosedTrade[] = [];

    if (this.adapter && this.adapter.isConnected()) {
      try {
        closedTrades = await this.adapter.closeAllPositions();
        this.positionsClosed = closedTrades.length;
      } catch (error) {
        riskLogger.error('Kill switch flatten FAILED — MANUAL INTERVENTION REQUIRED', { error });
        // Even if flatten fails, we mark as triggered to prevent new trades
      }
    } else {
      riskLogger.error('Kill switch triggered but no adapter connected — MANUAL INTERVENTION REQUIRED');
    }

    const endTime = performance.now();
    this.flattenLatencyMs = endTime - startTime;

    riskLogger.error('Kill switch execution complete', {
      reason,
      positionsClosed: this.positionsClosed,
      latencyMs: this.flattenLatencyMs.toFixed(1),
      closedTrades: closedTrades.map(t => ({
        id: t.id,
        instrument: t.instrument,
        pnl: t.realized_pnl
      }))
    });

    eventBus.emitEngine({
      type: 'LOCKOUT_ACTIVATED',
      reason: `Kill switch: ${reason}`
    });

    this.isExecuting = false;
    return closedTrades;
  }

  /**
   * Check if the system should be in lockout mode.
   */
  isInLockout(): boolean {
    return this.isTriggered;
  }

  /**
   * Get the current kill switch state.
   */
  getState(): KillSwitchState {
    return {
      is_armed: this.isArmed,
      is_triggered: this.isTriggered,
      trigger_reason: this.triggerReason,
      trigger_timestamp: this.triggerTimestamp,
      flatten_latency_ms: this.flattenLatencyMs,
      positions_closed: this.positionsClosed
    };
  }

  /**
   * Arm the kill switch (default state).
   */
  arm(): void {
    this.isArmed = true;
    riskLogger.info('Kill switch armed');
  }

  /**
   * Disarm the kill switch. USE WITH EXTREME CAUTION.
   * Only for maintenance/testing scenarios.
   */
  disarm(): void {
    this.isArmed = false;
    riskLogger.warn('⚠️ Kill switch DISARMED — safety degraded');
  }

  /**
   * Reset the kill switch after a triggered state.
   * Requires explicit acknowledgment of the reason.
   */
  reset(acknowledgment: string): void {
    if (!this.isTriggered) return;

    riskLogger.warn('Kill switch reset', {
      previousReason: this.triggerReason,
      acknowledgment
    });

    this.isTriggered = false;
    this.triggerReason = null;
    this.triggerTimestamp = null;
    this.flattenLatencyMs = null;
    this.positionsClosed = 0;
    this.isArmed = true;
  }
}
