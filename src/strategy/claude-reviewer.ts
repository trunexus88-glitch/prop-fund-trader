/**
 * TRU-NEXUS Claude API Strategy Reviewer
 * ═══════════════════════════════════════════════════════════════════════════
 * Scheduled AI analysis using Claude API (cost-controlled).
 * 
 * - Daily end-of-session review (~$0.50-$2.00/day)
 * - Weekly performance audit
 * - On-demand anomaly handling (kill switch events)
 * - New firm profile generation
 */

import type { ClosedTrade, TradeSignal, AccountState } from '../engine/types.js';
import { signalLogger } from '../utils/logger.js';

export interface DailyReviewResult {
  summary: string;
  parameter_adjustments: {
    key: string;
    current_value: number;
    suggested_value: number;
    reason: string;
  }[];
  risk_flags: string[];
  strategy_commentary: string;
  estimated_tokens_used: number;
}

export interface WeeklyAuditResult {
  performance_grade: string;
  win_rate_analysis: string;
  risk_reward_analysis: string;
  drawdown_trajectory: string;
  consistency_score: number;
  recommendations: string[];
  estimated_tokens_used: number;
}

export class ClaudeReviewer {
  private apiKey: string;
  private apiUrl: string = 'https://api.anthropic.com/v1/messages';
  private model: string = 'claude-sonnet-4-20250514';
  private totalTokensUsed: number = 0;
  private totalCost: number = 0;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    signalLogger.info('Claude reviewer initialized');
  }

  /**
   * Daily end-of-session strategy review.
   * Reviews all trades, signals, and drawdown utilization.
   */
  async dailyReview(
    trades: ClosedTrade[],
    signals: TradeSignal[],
    accountState: AccountState
  ): Promise<DailyReviewResult> {
    if (!this.apiKey) {
      return this.mockDailyReview(trades, signals, accountState);
    }

    const prompt = this.buildDailyReviewPrompt(trades, signals, accountState);

    try {
      const response = await this.callClaude(prompt);
      const parsed = JSON.parse(response.content);
      
      this.trackCost(response.tokens_used);
      
      return {
        ...parsed,
        estimated_tokens_used: response.tokens_used
      };
    } catch (error) {
      signalLogger.error('Claude daily review failed', { error });
      return this.mockDailyReview(trades, signals, accountState);
    }
  }

  /**
   * Weekly comprehensive performance audit.
   */
  async weeklyAudit(
    allTrades: ClosedTrade[],
    accountState: AccountState,
    weekNumber: number
  ): Promise<WeeklyAuditResult> {
    if (!this.apiKey) {
      return this.mockWeeklyAudit(allTrades);
    }

    const prompt = this.buildWeeklyAuditPrompt(allTrades, accountState, weekNumber);

    try {
      const response = await this.callClaude(prompt);
      const parsed = JSON.parse(response.content);
      
      this.trackCost(response.tokens_used);
      
      return {
        ...parsed,
        estimated_tokens_used: response.tokens_used
      };
    } catch (error) {
      signalLogger.error('Claude weekly audit failed', { error });
      return this.mockWeeklyAudit(allTrades);
    }
  }

  /**
   * Anomaly handler — called when kill switch fires or unprecedented conditions detected.
   */
  async handleAnomaly(
    reason: string,
    accountState: AccountState,
    recentTrades: ClosedTrade[]
  ): Promise<string> {
    if (!this.apiKey) {
      return `Anomaly detected: ${reason}. Manual review recommended. System is in lockout.`;
    }

    const prompt = `URGENT: Trading system anomaly detected.

Reason: ${reason}

Account State:
- Balance: $${accountState.current_balance.toFixed(2)}
- Equity: $${accountState.current_equity.toFixed(2)}
- Drawdown used: ${((1 - accountState.current_equity / accountState.initial_balance) * 100).toFixed(2)}%
- Daily loss used: $${accountState.daily_loss_used.toFixed(2)}

Recent trades (last 5): ${JSON.stringify(recentTrades.slice(-5).map(t => ({
      pnl: t.realized_pnl.toFixed(2),
      instrument: t.instrument,
      close_reason: t.close_reason
    })))}

Provide a brief recovery strategy. Should the system resume trading? What adjustments are needed?
Respond in JSON: {"should_resume": boolean, "wait_hours": number, "adjustments": string[], "analysis": string}`;

    try {
      const response = await this.callClaude(prompt);
      this.trackCost(response.tokens_used);
      return response.content;
    } catch (error) {
      return `Anomaly analysis failed. Manual review required for: ${reason}`;
    }
  }

  // ─── Private Methods ───────────────────────────────────────────────

  private async callClaude(prompt: string): Promise<{ content: string; tokens_used: number }> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: prompt
        }],
        system: 'You are a quantitative trading analyst reviewing an automated trading system. Respond with valid JSON only. Be critical and honest — flag real risks.'
      })
    });

    if (!response.ok) {
      throw new Error(`Claude API returned ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as {
      content: { text: string }[];
      usage: { input_tokens: number; output_tokens: number };
    };

    return {
      content: data.content[0].text,
      tokens_used: data.usage.input_tokens + data.usage.output_tokens
    };
  }

  private buildDailyReviewPrompt(
    trades: ClosedTrade[],
    signals: TradeSignal[],
    state: AccountState
  ): string {
    const wins = trades.filter(t => t.realized_pnl > 0);
    const losses = trades.filter(t => t.realized_pnl <= 0);
    const actedSignals = signals.filter(s => s.acted_upon);
    const rejectedSignals = signals.filter(s => !s.acted_upon);

    return `Daily Trading Review - ${new Date().toISOString().split('T')[0]}

TRADES TAKEN: ${trades.length} (${wins.length} wins, ${losses.length} losses)
WIN RATE: ${trades.length > 0 ? ((wins.length / trades.length) * 100).toFixed(1) : 0}%
TOTAL P&L: $${trades.reduce((s, t) => s + t.realized_pnl, 0).toFixed(2)}

SIGNALS: ${signals.length} generated, ${actedSignals.length} acted upon, ${rejectedSignals.length} rejected
REJECTION REASONS: ${rejectedSignals.map(s => s.rejection_reason).filter(Boolean).join('; ')}

ACCOUNT STATE:
- Balance: $${state.current_balance.toFixed(2)} (started: $${state.initial_balance.toFixed(2)})
- Max drawdown used: ${((1 - state.current_equity / state.initial_balance) * 100).toFixed(2)}%
- Daily loss used: $${state.daily_loss_used.toFixed(2)} / $${state.daily_loss_limit.toFixed(2)}

TRADE DETAILS:
${trades.map(t => `  ${t.instrument} ${t.side} ${t.lots}lot | Entry: ${t.entry_price} Exit: ${t.exit_price} | P&L: $${t.realized_pnl.toFixed(2)} | ${t.close_reason}`).join('\n')}

Analyze this session and provide:
1. Parameter adjustments for tomorrow (signal thresholds, risk limits)
2. Risk flags or concerns
3. Strategy commentary

Respond in JSON:
{
  "summary": "...",
  "parameter_adjustments": [{"key": "...", "current_value": 0, "suggested_value": 0, "reason": "..."}],
  "risk_flags": ["..."],
  "strategy_commentary": "..."
}`;
  }

  private buildWeeklyAuditPrompt(
    trades: ClosedTrade[],
    state: AccountState,
    weekNumber: number
  ): string {
    const wins = trades.filter(t => t.realized_pnl > 0);
    const totalPnl = trades.reduce((s, t) => s + t.realized_pnl, 0);
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.realized_pnl, 0) / wins.length : 0;
    const losses = trades.filter(t => t.realized_pnl <= 0);
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.realized_pnl, 0) / losses.length) : 0;

    return `Weekly Performance Audit - Week ${weekNumber}

OVERVIEW:
- Total trades: ${trades.length}
- Win rate: ${trades.length > 0 ? ((wins.length / trades.length) * 100).toFixed(1) : 0}%
- Total P&L: $${totalPnl.toFixed(2)}
- Average win: $${avgWin.toFixed(2)}
- Average loss: $${avgLoss.toFixed(2)}
- Risk/Reward: ${avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 'N/A'}

DRAWDOWN:
- Max drawdown reached: ${((1 - state.current_equity / state.initial_balance) * 100).toFixed(2)}%
- Current balance: $${state.current_balance.toFixed(2)}

Provide a comprehensive weekly audit in JSON:
{
  "performance_grade": "A/B/C/D/F",
  "win_rate_analysis": "...",
  "risk_reward_analysis": "...",
  "drawdown_trajectory": "...",
  "consistency_score": 0-100,
  "recommendations": ["..."]
}`;
  }

  private trackCost(tokensUsed: number): void {
    this.totalTokensUsed += tokensUsed;
    // Approximate cost: $3/MTok input + $15/MTok output for Sonnet
    this.totalCost += (tokensUsed / 1_000_000) * 9; // Rough average
    signalLogger.info('Claude API cost tracked', {
      tokensUsed,
      totalTokens: this.totalTokensUsed,
      estimatedTotalCost: `$${this.totalCost.toFixed(2)}`
    });
  }

  private mockDailyReview(
    trades: ClosedTrade[],
    signals: TradeSignal[],
    state: AccountState
  ): DailyReviewResult {
    const wins = trades.filter(t => t.realized_pnl > 0);
    return {
      summary: `Paper mode: ${trades.length} trades, ${wins.length} wins, P&L $${trades.reduce((s, t) => s + t.realized_pnl, 0).toFixed(2)}`,
      parameter_adjustments: [],
      risk_flags: state.daily_loss_used > state.daily_loss_limit * 0.5 ? ['Daily loss limit over 50% utilized'] : [],
      strategy_commentary: 'Claude API not configured — using automated analysis only.',
      estimated_tokens_used: 0
    };
  }

  private mockWeeklyAudit(trades: ClosedTrade[]): WeeklyAuditResult {
    const wins = trades.filter(t => t.realized_pnl > 0);
    return {
      performance_grade: trades.length === 0 ? 'N/A' : (wins.length / trades.length > 0.55 ? 'B' : 'C'),
      win_rate_analysis: `${trades.length} trades, ${((wins.length / Math.max(1, trades.length)) * 100).toFixed(1)}% win rate`,
      risk_reward_analysis: 'Claude API not configured',
      drawdown_trajectory: 'Automated tracking only',
      consistency_score: 50,
      recommendations: ['Configure Claude API for detailed analysis'],
      estimated_tokens_used: 0
    };
  }

  /** Get total estimated API cost */
  getTotalCost(): number {
    return this.totalCost;
  }
}
