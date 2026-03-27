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
}

function generateId(): string {
  return `sig_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}
