/**
 * TRU-NEXUS Market Regime Classifier
 * ═══════════════════════════════════════════════════════════════════════════
 * Identifies market conditions: trending, ranging, volatile, or low-liquidity.
 * Updates every 5 minutes. Can use local Ollama model or rule-based fallback.
 * 
 * The regime classifier adjusts signal thresholds — it never executes trades.
 */

import type { Candle, MarketRegime } from '../engine/types.js';
import { ema, emaSeries, atr, rsi } from './indicators.js';
import { signalLogger } from '../utils/logger.js';

export interface RegimeClassification {
  regime: MarketRegime;
  confidence: number;             // 0-100
  metrics: {
    trend_strength: number;       // ADX-like metric
    volatility_ratio: number;     // Current vol vs. average
    directional_bias: number;     // -1.0 to +1.0
    volume_trend: number;         // Volume relative to average
  };
}

export class RegimeClassifier {
  private currentRegime: MarketRegime = 'ranging';
  private ollamaUrl: string;
  private ollamaModel: string;
  private useOllama: boolean = false;

  constructor(ollamaUrl?: string, ollamaModel?: string) {
    this.ollamaUrl = ollamaUrl || 'http://localhost:11434';
    this.ollamaModel = ollamaModel || 'llama3.1:7b';
  }

  /**
   * Classify the current market regime using rule-based analysis.
   * This is the primary (deterministic) classifier.
   */
  classify(candles: Candle[]): RegimeClassification {
    if (candles.length < 50) {
      return {
        regime: 'ranging',
        confidence: 30,
        metrics: { trend_strength: 0, volatility_ratio: 1, directional_bias: 0, volume_trend: 1 }
      };
    }

    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);

    // 1. Calculate trend strength using EMA alignment
    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);
    const ema50 = ema(closes, 50);
    
    const trendStrength = this.calculateTrendStrength(ema9, ema21, ema50, closes[closes.length - 1]);

    // 2. Calculate volatility ratio (current ATR vs. 50-period average ATR)
    const currentAtr = atr(candles, 14);
    const atrValues: number[] = [];
    for (let i = 50; i <= candles.length; i++) {
      atrValues.push(atr(candles.slice(0, i), 14));
    }
    const avgAtr = atrValues.length > 0 
      ? atrValues.reduce((s, v) => s + (isNaN(v) ? 0 : v), 0) / atrValues.filter(v => !isNaN(v)).length
      : currentAtr;
    
    const volatilityRatio = avgAtr > 0 ? currentAtr / avgAtr : 1;

    // 3. Directional bias (-1.0 to +1.0)
    const directionalBias = this.calculateDirectionalBias(closes);

    // 4. Volume trend
    const recentVol = volumes.slice(-10).reduce((s, v) => s + v, 0) / 10;
    const avgVol = volumes.slice(-50).reduce((s, v) => s + v, 0) / Math.min(50, volumes.length);
    const volumeTrend = avgVol > 0 ? recentVol / avgVol : 1;

    // 5. Classify regime
    let regime: MarketRegime;
    let confidence: number;

    if (volatilityRatio > 1.8) {
      regime = 'volatile';
      confidence = Math.min(95, 60 + volatilityRatio * 10);
    } else if (volumeTrend < 0.4) {
      regime = 'low_liquidity';
      confidence = Math.min(90, 50 + (1 - volumeTrend) * 30);
    } else if (trendStrength > 60 && directionalBias > 0.3) {
      regime = 'trending_up';
      confidence = Math.min(95, trendStrength);
    } else if (trendStrength > 60 && directionalBias < -0.3) {
      regime = 'trending_down';
      confidence = Math.min(95, trendStrength);
    } else {
      regime = 'ranging';
      confidence = Math.min(85, 100 - trendStrength);
    }

    this.currentRegime = regime;

    const classification: RegimeClassification = {
      regime,
      confidence,
      metrics: {
        trend_strength: trendStrength,
        volatility_ratio: volatilityRatio,
        directional_bias: directionalBias,
        volume_trend: volumeTrend
      }
    };

    signalLogger.info('Regime classified', classification);
    return classification;
  }

  /**
   * Enhanced classification using Ollama LLM.
   * Falls back to rule-based if Ollama is unavailable.
   */
  async classifyWithOllama(candles: Candle[]): Promise<RegimeClassification> {
    // First get rule-based classification
    const ruleBasedResult = this.classify(candles);

    try {
      const closes = candles.slice(-50).map(c => c.close);
      const prompt = `Analyze this price series and classify the market regime.
Price data (last 50 closes): ${closes.map(c => c.toFixed(5)).join(', ')}

Rule-based analysis suggests: ${ruleBasedResult.regime} (${ruleBasedResult.confidence}% confidence)
Metrics: trend_strength=${ruleBasedResult.metrics.trend_strength.toFixed(1)}, volatility_ratio=${ruleBasedResult.metrics.volatility_ratio.toFixed(2)}, directional_bias=${ruleBasedResult.metrics.directional_bias.toFixed(2)}

Classify as one of: trending_up, trending_down, ranging, volatile, low_liquidity
Respond with JSON only: {"regime": "...", "confidence": 0-100, "reasoning": "..."}`;

      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.ollamaModel,
          prompt,
          stream: false,
          format: 'json'
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama returned ${response.status}`);
      }

      const data = await response.json() as { response: string };
      const parsed = JSON.parse(data.response);

      // Blend rule-based and LLM results (60% rule-based, 40% LLM)
      if (parsed.regime && ['trending_up', 'trending_down', 'ranging', 'volatile', 'low_liquidity'].includes(parsed.regime)) {
        // If both agree, boost confidence
        if (parsed.regime === ruleBasedResult.regime) {
          return {
            ...ruleBasedResult,
            confidence: Math.min(98, ruleBasedResult.confidence + 10)
          };
        }
        
        // If they disagree, use rule-based but lower confidence
        return {
          ...ruleBasedResult,
          confidence: Math.max(40, ruleBasedResult.confidence - 15)
        };
      }
    } catch (error) {
      signalLogger.warn('Ollama classification failed, using rule-based', { error });
    }

    return ruleBasedResult;
  }

  /**
   * Calculate trend strength (0-100) based on EMA alignment.
   */
  private calculateTrendStrength(ema9: number, ema21: number, ema50: number, price: number): number {
    let strength = 0;

    // Check EMA ordering (perfect alignment = strongest trend)
    const bullishOrder = ema9 > ema21 && ema21 > ema50;
    const bearishOrder = ema9 < ema21 && ema21 < ema50;

    if (bullishOrder || bearishOrder) {
      strength += 40;
    }

    // Check EMA separation (wider = stronger)
    const separation = Math.abs(ema9 - ema50) / ema50;
    strength += Math.min(30, separation * 2000); // Scale appropriately

    // Price relative to EMAs
    if ((price > ema9 && price > ema21 && price > ema50) ||
        (price < ema9 && price < ema21 && price < ema50)) {
      strength += 20;
    }

    // Price momentum (distance from EMA50)
    const momentumPct = Math.abs(price - ema50) / ema50;
    strength += Math.min(10, momentumPct * 500);

    return Math.min(100, strength);
  }

  /**
   * Calculate directional bias from -1.0 (bearish) to +1.0 (bullish).
   */
  private calculateDirectionalBias(closes: number[]): number {
    const recent = closes.slice(-20);
    if (recent.length < 2) return 0;

    // Linear regression slope
    const n = recent.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += recent[i];
      sumXY += i * recent[i];
      sumX2 += i * i;
    }

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const avgPrice = sumY / n;
    
    // Normalize slope to -1/+1 range
    const normalizedSlope = slope / (avgPrice * 0.01); // 1% move per bar = 1.0
    return Math.max(-1, Math.min(1, normalizedSlope));
  }

  getCurrentRegime(): MarketRegime {
    return this.currentRegime;
  }
}
