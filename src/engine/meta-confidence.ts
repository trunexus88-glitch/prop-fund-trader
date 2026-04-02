/**
 * TRU-NEXUS Meta-Confidence Engine
 * ═══════════════════════════════════════════════════════════════════════════
 * Combines the state score, volatility surface, and macro regime alignment
 * into a single CONFIDENCE value (0.0–1.0) and an EXECUTION TIER that
 * directly controls position sizing.
 *
 * Execution tiers and their position-size multipliers:
 *   FULL    (≥0.80) — 100% of the base risk cap  (highest conviction)
 *   HALF    (≥0.70) —  50% of the base risk cap
 *   QUARTER (≥0.60) —  25% of the base risk cap
 *   NO_TRADE (<0.60) — signal is suppressed entirely
 *
 * Why tiers instead of a hard floor? The old 80-point hard floor threw away
 * genuinely valid 70-79 confidence setups with no recourse.  Tiers let
 * those setups participate at reduced size — the market still gets to prove
 * them right or wrong, but the account risks less on each.
 */

import type { StateResult } from './state-engine.js';
import type { VolatilitySurface } from './volatility-engine.js';

// ─── Public Types ─────────────────────────────────────────────────────────────

export type RegimeAlignment = 'ALIGNED' | 'NEUTRAL' | 'CONFLICTING';
export type ExecutionTier   = 'FULL' | 'HALF' | 'QUARTER' | 'NO_TRADE';

/** Risk-cap multipliers per execution tier */
export const TIER_MULTIPLIERS: Record<Exclude<ExecutionTier, 'NO_TRADE'>, number> = {
  FULL:    1.0,
  HALF:    0.5,
  QUARTER: 0.25,
};

export interface MetaConfidence {
  /** Final confidence in the 0.0–1.0 range */
  confidence: number;
  tier: ExecutionTier;
  regimeAlignment: RegimeAlignment;
}

// ─── Core Computation ─────────────────────────────────────────────────────────

/**
 * @param stateResult      Output of computeStateScore()
 * @param volSurface       Output of computeVolatilitySurface()
 * @param regimeAlignment  Macro regime alignment verdict
 * @param confluenceScore  Optional Phase 22 delta from MTF + historical layers.
 *                         Pass the SUM of MTFConfluenceResult.confidenceDelta and
 *                         HistoricalConfidenceResult.confidenceDelta.
 */
export function computeMetaConfidence(
  stateResult: StateResult,
  volSurface: VolatilitySurface,
  regimeAlignment: RegimeAlignment,
  confluenceScore?: number
): MetaConfidence {
  // Start from absolute state score (0 to 1)
  let confidence = stateResult.absScore;

  // ── Regime alignment adjustment ──────────────────────────────────────────
  // ALIGNED: macro tailwind, small bonus
  // CONFLICTING: macro headwind, meaningful penalty (prevents fighting the tape)
  if (regimeAlignment === 'ALIGNED')      confidence += 0.10;
  else if (regimeAlignment === 'CONFLICTING') confidence -= 0.15;

  // ── Volatility adjustment ────────────────────────────────────────────────
  // CONTRACTING markets have low noise → higher probability stops hold
  // ACCELERATING markets are noisy → increased risk of adverse whipsaw
  if (volSurface.state === 'CONTRACTING')  confidence += 0.05;
  if (volSurface.state === 'ACCELERATING') confidence -= 0.05;

  // ── Transition risk penalty ──────────────────────────────────────────────
  // NEUTRAL states have high transition risk (0.50) and lose 5 confidence pts.
  // STRONG states have low risk (0.15) and lose only 1.5 pts.
  confidence -= stateResult.transitionRisk * 0.10;

  // ── Phase 22: MTF confluence + historical enrichment ────────────────────
  // confluenceScore is the pre-summed delta from Layer B and Layer C.
  // Applied last so the existing tier boundaries remain stable for Phase 21.
  if (confluenceScore !== undefined) {
    confidence += confluenceScore;
  }

  confidence = Math.max(0, Math.min(1, confidence));

  // ── Tier assignment ───────────────────────────────────────────────────────
  let tier: ExecutionTier;
  if      (confidence >= 0.80) tier = 'FULL';
  else if (confidence >= 0.70) tier = 'HALF';
  else if (confidence >= 0.60) tier = 'QUARTER';
  else                         tier = 'NO_TRADE';

  return { confidence, tier, regimeAlignment };
}
