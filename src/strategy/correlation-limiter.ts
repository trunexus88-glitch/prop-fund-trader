/**
 * TRU-NEXUS Correlation Limiter
 * ═══════════════════════════════════════════════════════════════════════════
 * Within each asset cluster, only the highest-confidence signal is approved.
 * All other signals from the same cluster are demoted (not routed).
 *
 * Rationale: EURUSD SELL and GBPUSD SELL respond to the same macro driver
 * (USD strength).  Taking both doubles the exposure to a single theme while
 * consuming two separate drawdown buckets.  The limiter enforces cluster-level
 * position limits: one conviction trade per cluster per signal cycle.
 *
 * Example:
 *   Input:  [EURUSD SELL conf=78, GBPUSD SELL conf=72, USDJPY BUY conf=81]
 *   Clusters: EURUSD=RISK_ASSETS, GBPUSD=RISK_ASSETS, USDJPY=SAFE_HAVENS_USD
 *   Output: approved=[EURUSD SELL (78), USDJPY BUY (81)], blocked=[GBPUSD SELL (72)]
 */

import type { TradeSignal } from '../engine/types.js';
import { getCluster } from './asset-clusters.js';
import { signalLogger } from '../utils/logger.js';

// ─── Public Types ────────────────────────────────────────────────────────────

export interface CorrelationLimitResult {
  /** Signals that survived the limiter — safe to route to accounts. */
  approved: TradeSignal[];

  /**
   * Signals demoted by the limiter — a higher-confidence signal from the
   * same cluster was already approved.  These are logged but not routed.
   */
  blocked: TradeSignal[];

  /**
   * Maps each cluster name to the winning instrument ticker.
   * Useful for dashboard display and audit logging.
   */
  clusterWinners: Map<string, string>;
}

// ─── Core Function ───────────────────────────────────────────────────────────

/**
 * Apply the one-signal-per-cluster rule to a batch of candidate signals.
 *
 * @param signals  Candidate signals that have already passed the macro gate
 *                 and confidence floor — the correlation limiter is the
 *                 final filter before routing.
 * @returns        Approved signals, demoted signals, and a map of cluster → winner.
 */
export function applyCorrelationLimit(signals: TradeSignal[]): CorrelationLimitResult {
  if (signals.length === 0) {
    return { approved: [], blocked: [], clusterWinners: new Map() };
  }

  // ── Group by cluster ─────────────────────────────────────────────────────
  const byCluster = new Map<string, TradeSignal[]>();
  for (const signal of signals) {
    const cluster = getCluster(signal.instrument);
    if (!byCluster.has(cluster)) byCluster.set(cluster, []);
    byCluster.get(cluster)!.push(signal);
  }

  const approved: TradeSignal[] = [];
  const blocked: TradeSignal[]  = [];
  const clusterWinners          = new Map<string, string>();

  // ── Pick one winner per cluster ──────────────────────────────────────────
  for (const [cluster, clusterSignals] of byCluster) {
    if (clusterSignals.length === 1) {
      // Only one candidate in this cluster — no competition, approve unconditionally
      approved.push(clusterSignals[0]);
      clusterWinners.set(cluster, clusterSignals[0].instrument);
      continue;
    }

    // Multiple candidates — sort descending by confidence and pick the best
    const sorted = [...clusterSignals].sort((a, b) => b.confidence - a.confidence);
    const winner  = sorted[0];
    const demoted = sorted.slice(1);

    approved.push(winner);
    blocked.push(...demoted);
    clusterWinners.set(cluster, winner.instrument);

    signalLogger.info(`[corr-limiter] ${cluster}: winner=${winner.instrument}/${winner.side} conf=${winner.confidence}`, {
      demoted: demoted.map(s => `${s.instrument}/${s.side}(${s.confidence})`).join(', '),
    });
  }

  if (blocked.length > 0) {
    signalLogger.info(`[corr-limiter] ${approved.length} approved, ${blocked.length} demoted across ${byCluster.size} cluster(s)`);
  }

  return { approved, blocked, clusterWinners };
}
