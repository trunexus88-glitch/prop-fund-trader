/**
 * TRU-NEXUS Core Type Definitions
 * These types define every data structure used across the three-layer architecture.
 * All monetary values are in account currency (typically USD).
 */

// ─── Firm Profile Types ─────────────────────────────────────────────────────

export type DrawdownModel = 'static' | 'trailing_eod' | 'trailing_realtime';
export type DailyLossBasis = 'initial_balance' | 'current_balance' | 'equity_at_reset';
export type Platform = 'mt4' | 'mt5' | 'ctrader' | 'tradovate' | 'rithmic' | 'tradelocker';
export type TradingMode = 'paper' | 'live';

export interface FirmProfile {
  firm_id: string;
  firm_name: string;
  account_size: number;
  max_drawdown_pct: number;                   // e.g., 0.10 = 10%
  drawdown_model: DrawdownModel;
  daily_loss_pct: number | null;              // null = no daily limit
  daily_loss_basis: DailyLossBasis;
  daily_reset_utc: string;                    // e.g., "23:00"
  profit_target_pct: number;                  // Phase profit target
  min_trading_days: number;
  max_trading_days: number | null;            // null = unlimited
  consistency_rule_pct: number | null;        // e.g., 0.40 = 40% max single-day
  news_blackout_mins: number;                 // 0 = allowed
  weekend_holding: boolean;
  ea_allowed: boolean;
  platform: Platform;
  profit_split_pct: number;                   // e.g., 0.80 = 80%
  scaling_cap: string;
  min_hold_time_seconds: number;              // Min hold time (anti-HFT)
  max_daily_trades: number | null;            // null = unlimited
  eval_fee: number;
  tier: 'tier1' | 'tier2' | 'futures';
}

// ─── Account State ──────────────────────────────────────────────────────────

export interface AccountState {
  firm_id: string;
  initial_balance: number;
  current_balance: number;
  current_equity: number;
  peak_equity: number;
  drawdown_floor: number;
  daily_loss_used: number;
  daily_loss_limit: number;
  balance_at_day_reset: number;
  total_challenge_profit: number;
  daily_profit: number;
  trading_days_count: number;
  start_date: string;
  last_reset_utc: string;
  is_locked_out: boolean;
  lockout_reason: string | null;
  open_positions: Position[];
  closed_trades_today: ClosedTrade[];
  all_closed_trades: ClosedTrade[];
}

// ─── Position & Trade Types ─────────────────────────────────────────────────

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';

export interface Position {
  id: string;
  instrument: string;
  side: OrderSide;
  lots: number;
  entry_price: number;
  current_price: number;
  stop_loss: number;
  take_profit: number | null;
  unrealized_pnl: number;
  opened_at: string;                          // ISO timestamp
  max_adverse_excursion: number;              // Worst drawdown during trade
}

export interface ClosedTrade {
  id: string;
  instrument: string;
  side: OrderSide;
  lots: number;
  entry_price: number;
  exit_price: number;
  stop_loss: number;
  take_profit: number | null;
  realized_pnl: number;
  opened_at: string;
  closed_at: string;
  hold_time_seconds: number;
  close_reason: 'tp' | 'sl' | 'manual' | 'kill_switch' | 'session_end' | 'rule_breach';
}

export interface OrderRequest {
  instrument: string;
  side: OrderSide;
  type: OrderType;
  lots: number;
  price?: number;                             // Required for limit/stop
  stop_loss: number;
  take_profit?: number;
  signal_id?: string;                         // Reference to originating signal
}

// ─── Signal Types ───────────────────────────────────────────────────────────

export type MarketRegime = 'trending_up' | 'trending_down' | 'ranging' | 'volatile' | 'low_liquidity';

export type ExecutionTier = 'FULL' | 'HALF' | 'QUARTER' | 'NO_TRADE';

export interface TradeSignal {
  id: string;
  timestamp: string;
  instrument: string;
  side: OrderSide;
  confidence: number;                         // 0-100
  regime: MarketRegime;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  risk_reward_ratio: number;
  confluence_factors: string[];
  indicator_values: IndicatorSnapshot;
  acted_upon: boolean;
  rejection_reason?: string;
  // ── Phase 21 — Analyst Intelligence (VQ++ state engine) ──────────────────
  /** Continuous state score from -1.0 (max bear) to +1.0 (max bull) */
  state_score?: number;
  /** Human-readable state label from state engine */
  state_label?: string;
  /** Volatility regime at signal creation time */
  volatility_state?: string;
  /** How the signal direction aligns with the macro regime */
  regime_alignment?: string;
  /** Probability (0–1) the state reverses before trade completes */
  transition_risk?: number;
  /** Sizing tier from meta-confidence engine */
  execution_tier?: ExecutionTier;
  /** Meta-confidence value (0–1) from combined state + vol + regime */
  meta_confidence?: number;
}

export interface IndicatorSnapshot {
  rsi_14: number;
  ema_9: number;
  ema_21: number;
  ema_50: number;
  ema_200: number;
  atr_14: number;
  macd_value: number;
  macd_signal: number;
  macd_histogram: number;
  bollinger_upper: number;
  bollinger_middle: number;
  bollinger_lower: number;
  volume: number;
  support_levels: number[];
  resistance_levels: number[];
}

// ─── Engine Events ──────────────────────────────────────────────────────────

export type EngineEvent =
  | { type: 'DRAWDOWN_WARNING'; level: number; remaining_pct: number }
  | { type: 'DRAWDOWN_CRITICAL'; level: number; remaining_pct: number }
  | { type: 'DAILY_LOSS_WARNING'; used_pct: number }
  | { type: 'DAILY_LOSS_CRITICAL'; used_pct: number }
  | { type: 'KILL_SWITCH_TRIGGERED'; reason: string; timestamp: string }
  | { type: 'POSITION_OPENED'; position: Position }
  | { type: 'POSITION_CLOSED'; trade: ClosedTrade }
  | { type: 'SIGNAL_GENERATED'; signal: TradeSignal }
  | { type: 'SIGNAL_REJECTED'; signal: TradeSignal; reason: string }
  | { type: 'LOCKOUT_ACTIVATED'; reason: string }
  | { type: 'CONSISTENCY_WARNING'; daily_pct: number; threshold: number }
  | { type: 'SESSION_BLACKOUT'; reason: string; until: string }
  | { type: 'STRATEGY_BLOCKED'; strategy: string; reason: string }
  | { type: 'DAILY_RESET'; new_daily_limit: number };

// ─── Drawdown Monitor Types ────────────────────────────────────────────────

export interface DrawdownState {
  model: DrawdownModel;
  initial_balance: number;
  floor: number;
  peak_equity: number;
  current_equity: number;
  consumed_pct: number;                       // 0.0 to 1.0 (how much of drawdown used)
  remaining_headroom: number;                 // $ amount remaining before breach
  is_warning: boolean;                        // 80% consumed
  is_critical: boolean;                       // 90% consumed
  is_breached: boolean;                       // 100% consumed
}

// ─── Position Sizing Types ──────────────────────────────────────────────────

export interface PositionSizeRequest {
  instrument: string;
  signal_confidence: number;
  entry_price: number;
  stop_loss: number;
  atr: number;
  remaining_daily_headroom: number;
  remaining_max_drawdown_headroom: number;
  current_open_exposure: number;              // Total lots already open
  is_funded: boolean;                         // Affects risk cap
  // Phase 20 — total exposure cap (Step 7)
  account_equity: number;                     // Current equity for 50% cap check
  current_open_risk_usd: number;              // Sum of dollar risk on all open positions
  // Phase 21 — execution tier multiplier (FULL=1.0, HALF=0.5, QUARTER=0.25)
  tier_multiplier?: number;
}

export interface PositionSizeResult {
  lots: number;
  risk_amount: number;                        // $ risk on this trade
  risk_pct: number;                           // % of initial balance risked
  stop_distance_pips: number;
  max_loss_scenario: number;                  // Worst case $ loss
  approved: boolean;
  rejection_reason?: string;
}

// ─── Dashboard Types ────────────────────────────────────────────────────────

export interface DashboardSnapshot {
  timestamp: string;
  accounts: AccountDashboard[];
  system_status: 'running' | 'paused' | 'lockout' | 'error';
  uptime_seconds: number;
  signals_today: number;
  trades_today: number;
  // Phase 20 additions
  macro_regime?: string;                      // Current macro regime state
  macro_regime_color?: string;               // Hex color for dashboard badge
}

export interface AccountDashboard {
  firm_id: string;
  firm_name: string;
  balance: number;
  equity: number;
  drawdown_used_pct: number;
  daily_loss_used_pct: number;
  open_positions: number;
  todays_pnl: number;
  total_pnl: number;
  win_rate: number;
  avg_rr: number;
  trading_days: number;
  consistency_score: number;
  status: 'active' | 'locked' | 'passed' | 'failed';
}

// ─── Adapter Interface ──────────────────────────────────────────────────────

export interface TradingAdapter {
  readonly name: string;
  readonly platform: Platform;
  
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  
  getAccountBalance(): Promise<number>;
  getAccountEquity(): Promise<number>;
  getOpenPositions(): Promise<Position[]>;
  
  placeOrder(order: OrderRequest): Promise<Position>;
  closePosition(positionId: string): Promise<ClosedTrade>;
  closeAllPositions(): Promise<ClosedTrade[]>;
  modifyPosition(positionId: string, stopLoss?: number, takeProfit?: number): Promise<Position>;
  
  getCurrentPrice(instrument: string): Promise<{ bid: number; ask: number }>;
  getCandles(instrument: string, timeframe: string, count: number): Promise<Candle[]>;
  
  onPriceUpdate(instrument: string, callback: (price: { bid: number; ask: number }) => void): void;
  onPositionUpdate(callback: (position: Position) => void): void;
}

export interface Candle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── Compounding Protocol ───────────────────────────────────────────────────

export interface CompoundingState {
  total_profits: number;
  reinvestment_pool: number;                  // 60% of profits
  personal_income: number;                    // 40% of profits
  active_funded_accounts: FundedAccount[];
  pending_evaluations: EvaluationAccount[];
  completed_payouts: Payout[];
  safety_reserve: number;
}

export interface FundedAccount {
  firm_id: string;
  funded_balance: number;
  total_payouts: number;
  successful_payout_count: number;
  status: 'active' | 'lost' | 'scaling';
}

export interface EvaluationAccount {
  firm_id: string;
  eval_cost: number;
  current_phase: number;
  start_date: string;
  status: 'in_progress' | 'passed' | 'failed';
}

export interface Payout {
  firm_id: string;
  amount: number;
  date: string;
  to_reinvestment: number;
  to_personal: number;
}
