/**
 * TRU-NEXUS Technical Signal Generator
 * ═══════════════════════════════════════════════════════════════════════════
 * Processes price data + indicator values into scored trade setups (0-100).
 * Only setups scoring 70+ are forwarded to the execution engine.
 * 
 * Ensemble approach: RSI + EMA crossover + support/resistance + ATR volatility filter.
 * Each factor contributes to the final confidence score.
 */


import type { Candle, TradeSignal, MarketRegime, IndicatorSnapshot, OrderSide } from '../engine/types.js';
import { generateIndicatorSnapshot, atr } from './indicators.js';
import { signalLogger } from '../utils/logger.js';
import { eventBus } from '../utils/event-bus.js';
import { computeVolatilitySurface } from '../engine/volatility-engine.js';
import { computeStateScore } from '../engine/state-engine.js';
import { computeMetaConfidence, TIER_MULTIPLIERS } from '../engine/meta-confidence.js';
import type { RegimeAlignment } from '../engine/meta-confidence.js';
import { isDirectionBlocked } from './asset-clusters.js';
import type { MacroRegimeState } from './macro-regime-classifier.js';

export interface SignalGeneratorConfig {
  minConfidence: number;          // Default: 70
  atrMultiplierSL: number;        // ATR multiplier for stop loss (default: 1.5)
  atrMultiplierTP: number;        // ATR multiplier for take profit (default: 2.5)
  rsiOversold: number;            // Default: 30
  rsiOverbought: number;          // Default: 70
}

const DEFAULT_CONFIG: SignalGeneratorConfig = {
  minConfidence: 40,
  atrMultiplierSL: 1.5,
  atrMultiplierTP: 2.5,
  rsiOversold: 30,
  rsiOverbought: 70,
};

export class SignalGenerator {
  private config: SignalGeneratorConfig;
  private currentRegime: MarketRegime = 'ranging';

  constructor(config: Partial<SignalGeneratorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    signalLogger.info('Signal generator initialized', { config: this.config });
  }

  /**
   * Set the current market regime (from regime classifier).
   */
  setRegime(regime: MarketRegime): void {
    this.currentRegime = regime;
  }

  /**
   * Generate trade signals from candle data.
   * Returns signals that MEET the minimum confidence threshold.
   */
  generateSignals(instrument: string, candles: Candle[]): TradeSignal[] {
    if (candles.length < 200) {
      signalLogger.warn('Insufficient candle data for signal generation', {
        instrument,
        candles: candles.length,
        required: 200
      });
      return [];
    }

    const indicators = generateIndicatorSnapshot(candles);
    const currentPrice = candles[candles.length - 1].close;
    const currentAtr = indicators.atr_14;

    if (isNaN(currentAtr) || currentAtr <= 0) {
      return [];
    }

    const signals: TradeSignal[] = [];

    // ─── Check for BUY signals ────────────────────────────────────────
    const buyScore = this.scoreBuySetup(indicators, currentPrice);
    if (buyScore.confidence >= this.config.minConfidence) {
      const stopLoss = currentPrice - (currentAtr * this.config.atrMultiplierSL);
      const takeProfit = currentPrice + (currentAtr * this.config.atrMultiplierTP);
      const rrRatio = (takeProfit - currentPrice) / (currentPrice - stopLoss);

      const signal: TradeSignal = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        instrument,
        side: 'buy',
        confidence: buyScore.confidence,
        regime: this.currentRegime,
        entry_price: currentPrice,
        stop_loss: stopLoss,
        take_profit: takeProfit,
        risk_reward_ratio: rrRatio,
        confluence_factors: buyScore.factors,
        indicator_values: indicators,
        acted_upon: false
      };

      signals.push(signal);
      eventBus.emitEngine({ type: 'SIGNAL_GENERATED', signal });
    }

    // ─── Check for SELL signals ───────────────────────────────────────
    const sellScore = this.scoreSellSetup(indicators, currentPrice);
    if (sellScore.confidence >= this.config.minConfidence) {
      const stopLoss = currentPrice + (currentAtr * this.config.atrMultiplierSL);
      const takeProfit = currentPrice - (currentAtr * this.config.atrMultiplierTP);
      const rrRatio = (currentPrice - takeProfit) / (stopLoss - currentPrice);

      const signal: TradeSignal = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        instrument,
        side: 'sell',
        confidence: sellScore.confidence,
        regime: this.currentRegime,
        entry_price: currentPrice,
        stop_loss: stopLoss,
        take_profit: takeProfit,
        risk_reward_ratio: rrRatio,
        confluence_factors: sellScore.factors,
        indicator_values: indicators,
        acted_upon: false
      };

      signals.push(signal);
      eventBus.emitEngine({ type: 'SIGNAL_GENERATED', signal });
    }

    return signals;
  }

  /**
   * Score a potential BUY setup. Returns 0-100 confidence.
   */
  private scoreBuySetup(
    ind: IndicatorSnapshot,
    price: number
  ): { confidence: number; factors: string[] } {
    let score = 0;
    const factors: string[] = [];

    // 1. RSI oversold zone (0-25 points)
    if (ind.rsi_14 < this.config.rsiOversold) {
      const rsiScore = Math.min(25, (this.config.rsiOversold - ind.rsi_14) * 1.5);
      score += rsiScore;
      factors.push(`RSI oversold: ${ind.rsi_14.toFixed(1)}`);
    } else if (ind.rsi_14 < 45) {
      score += 10;
      factors.push(`RSI neutral-low: ${ind.rsi_14.toFixed(1)}`);
    }

    // 2. EMA alignment — bullish when short > long (0-25 points)
    if (ind.ema_9 > ind.ema_21 && ind.ema_21 > ind.ema_50) {
      score += 25;
      factors.push('EMA bullish alignment (9 > 21 > 50)');
    } else if (ind.ema_9 > ind.ema_21) {
      score += 15;
      factors.push('EMA 9/21 bullish crossover');
    }

    // 3. Price near support (0-20 points)
    if (ind.support_levels.length > 0) {
      const nearestSupport = ind.support_levels[0];
      const distanceToSupport = (price - nearestSupport) / price;
      if (distanceToSupport < 0.005) { // Within 0.5% of support
        score += 20;
        factors.push(`Price at support: ${nearestSupport.toFixed(5)}`);
      } else if (distanceToSupport < 0.01) {
        score += 10;
        factors.push(`Price near support: ${nearestSupport.toFixed(5)}`);
      }
    }

    // 4. MACD bullish crossover (0-15 points)
    if (ind.macd_histogram > 0 && ind.macd_value > ind.macd_signal) {
      score += 15;
      factors.push('MACD bullish crossover');
    }

    // 5. Bollinger Band bounce (0-15 points)
    if (price <= ind.bollinger_lower * 1.005) { // Within 0.5% of lower band
      score += 15;
      factors.push('Price at lower Bollinger Band');
    }

    // 6. Regime adjustment
    score = this.adjustForRegime(score, 'buy');

    return { confidence: Math.min(100, Math.round(score)), factors };
  }

  /**
   * Score a potential SELL setup. Returns 0-100 confidence.
   */
  private scoreSellSetup(
    ind: IndicatorSnapshot,
    price: number
  ): { confidence: number; factors: string[] } {
    let score = 0;
    const factors: string[] = [];

    // 1. RSI overbought zone
    if (ind.rsi_14 > this.config.rsiOverbought) {
      const rsiScore = Math.min(25, (ind.rsi_14 - this.config.rsiOverbought) * 1.5);
      score += rsiScore;
      factors.push(`RSI overbought: ${ind.rsi_14.toFixed(1)}`);
    } else if (ind.rsi_14 > 55) {
      score += 10;
      factors.push(`RSI neutral-high: ${ind.rsi_14.toFixed(1)}`);
    }

    // 2. EMA alignment — bearish when short < long
    if (ind.ema_9 < ind.ema_21 && ind.ema_21 < ind.ema_50) {
      score += 25;
      factors.push('EMA bearish alignment (9 < 21 < 50)');
    } else if (ind.ema_9 < ind.ema_21) {
      score += 15;
      factors.push('EMA 9/21 bearish crossover');
    }

    // 3. Price near resistance
    if (ind.resistance_levels.length > 0) {
      const nearestResistance = ind.resistance_levels[0];
      const distanceToResistance = (nearestResistance - price) / price;
      if (distanceToResistance < 0.005) {
        score += 20;
        factors.push(`Price at resistance: ${nearestResistance.toFixed(5)}`);
      } else if (distanceToResistance < 0.01) {
        score += 10;
        factors.push(`Price near resistance: ${nearestResistance.toFixed(5)}`);
      }
    }

    // 4. MACD bearish crossover
    if (ind.macd_histogram < 0 && ind.macd_value < ind.macd_signal) {
      score += 15;
      factors.push('MACD bearish crossover');
    }

    // 5. Bollinger Band rejection
    if (price >= ind.bollinger_upper * 0.995) {
      score += 15;
      factors.push('Price at upper Bollinger Band');
    }

    // 6. Regime adjustment
    score = this.adjustForRegime(score, 'sell');

    return { confidence: Math.min(100, Math.round(score)), factors };
  }

  /**
   * Adjust signal score based on market regime.
   */
  private adjustForRegime(score: number, side: OrderSide): number {
    switch (this.currentRegime) {
      case 'trending_up':
        return side === 'buy' ? score * 1.15 : score * 0.7;
      case 'trending_down':
        return side === 'sell' ? score * 1.15 : score * 0.7;
      case 'ranging':
        return score * 0.9; // Slightly reduce in ranging markets
      case 'volatile':
        return score * 0.75; // Reduce in volatile markets
      case 'low_liquidity':
        return score * 0.5; // Heavily reduce in low liquidity
      default:
        return score;
    }
  }

  // ─── Phase 21 — VQ++ State Engine ─────────────────────────────────────────

  /**
   * Generate a single trade signal using the continuous state engine, adaptive
   * volatility surface, and meta-confidence tier system.
   *
   * This is the ANALYST'S primary scoring path going forward.  The legacy
   * generateSignals() is retained for backward compatibility.
   *
   * The method internalises what was previously scattered across index.ts:
   *   - Macro regime direction gate (isDirectionBlocked)
   *   - Regime alignment bonus/penalty
   *   - Adaptive stop / take-profit via VolatilitySurface
   *   - Execution tier (FULL / HALF / QUARTER / NO_TRADE)
   *
   * @returns Array of 0 or 1 signals (one per instrument per call)
   */
  generateSignalsV2(
    instrument: string,
    candles: Candle[],
    extraCandles?: { candles4h?: Candle[]; candles1d?: Candle[] },
    macroRegime?: MacroRegimeState
  ): TradeSignal[] {
    if (candles.length < 200) {
      signalLogger.warn('[v2] Insufficient candle data', { instrument, count: candles.length });
      return [];
    }

    const indicators = generateIndicatorSnapshot(candles);
    const close = candles[candles.length - 1].close;

    // Guard: ATR must be valid
    if (isNaN(indicators.atr_14) || indicators.atr_14 <= 0) {
      signalLogger.warn('[v2] ATR invalid — skipping', { instrument });
      return [];
    }

    // 1. Volatility surface — adaptive stop/TP multipliers
    const volSurface = computeVolatilitySurface(
      candles,
      extraCandles?.candles4h,
      extraCandles?.candles1d
    );

    // 2. Continuous state score (-1.0 to +1.0)
    const stateResult = computeStateScore(indicators, close);

    // 3. Direction gate — no trade on NEUTRAL state
    if (!stateResult.direction) {
      signalLogger.debug('[v2] Neutral state — no trade', {
        instrument,
        score: stateResult.score.toFixed(3),
      });
      return [];
    }

    const side: OrderSide = stateResult.direction === 'LONG' ? 'buy' : 'sell';

    // 4. Macro regime alignment (ALIGNED / NEUTRAL / CONFLICTING)
    const effectiveMacroRegime = macroRegime ?? 'NEUTRAL';
    const blocked = isDirectionBlocked(instrument, side, effectiveMacroRegime);

    const regimeAlignment: RegimeAlignment = blocked
      ? 'CONFLICTING'
      : effectiveMacroRegime === 'NEUTRAL'
        ? 'NEUTRAL'
        : 'ALIGNED';

    // 5. Meta-confidence — combines state score + vol surface + regime
    const meta = computeMetaConfidence(stateResult, volSurface, regimeAlignment);

    // 6. Suppression gates
    if (meta.tier === 'NO_TRADE') {
      signalLogger.debug('[v2] Meta-confidence below QUARTER threshold — suppressed', {
        instrument,
        metaConf: meta.confidence.toFixed(3),
      });
      return [];
    }

    if (regimeAlignment === 'CONFLICTING') {
      signalLogger.debug('[v2] Regime gate — direction blocked by macro', {
        instrument,
        side,
        regime: effectiveMacroRegime,
      });
      return [];
    }

    // 7. Build adaptive SL/TP from volatility surface
    const atr1h = volSurface.atr1h;
    const stopDist = volSurface.stopMult * atr1h;
    const tpDist   = volSurface.tpMult   * atr1h;

    const stopLoss   = side === 'buy' ? close - stopDist : close + stopDist;
    const takeProfit = side === 'buy' ? close + tpDist   : close - tpDist;
    const rrRatio    = stopDist > 0 ? parseFloat((tpDist / stopDist).toFixed(2)) : 0;

    // 8. Build the enriched signal
    const signal: TradeSignal = {
      id:                generateId(),
      timestamp:         new Date().toISOString(),
      instrument,
      side,
      confidence:        Math.round(meta.confidence * 100),
      regime:            this.currentRegime,
      entry_price:       parseFloat(close.toFixed(5)),
      stop_loss:         parseFloat(stopLoss.toFixed(5)),
      take_profit:       parseFloat(takeProfit.toFixed(5)),
      risk_reward_ratio: rrRatio,
      confluence_factors: [
        `State: ${stateResult.label} (${stateResult.score.toFixed(3)})`,
        `Vol: ${volSurface.state} (stop×${volSurface.stopMult}, tp×${volSurface.tpMult})`,
        `Regime: ${effectiveMacroRegime} [${regimeAlignment}]`,
        `Tier: ${meta.tier} (${(meta.confidence * 100).toFixed(1)}%)`,
      ],
      indicator_values: indicators,
      acted_upon:       false,
      // Phase 21 enrichment fields
      state_score:       parseFloat(stateResult.score.toFixed(4)),
      state_label:       stateResult.label,
      volatility_state:  volSurface.state,
      regime_alignment:  regimeAlignment,
      transition_risk:   stateResult.transitionRisk,
      execution_tier:    meta.tier,
      meta_confidence:   parseFloat(meta.confidence.toFixed(4)),
    };

    signalLogger.info('[v2] Signal generated', {
      instrument,
      side,
      stateScore:  signal.state_score,
      stateLabel:  signal.state_label,
      volState:    signal.volatility_state,
      regimeAlign: signal.regime_alignment,
      metaConf:    signal.meta_confidence,
      tier:        signal.execution_tier,
      rrRatio,
    });

    eventBus.emitEngine({ type: 'SIGNAL_GENERATED', signal });
    return [signal];
  }
}

function generateId(): string {
  return `sig_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}
