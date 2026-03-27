/**
 * TRU-NEXUS Multi-Account Manager
 * ═══════════════════════════════════════════════════════════════════════════
 * Manages multiple prop firm accounts simultaneously.
 * Routes signals to appropriate accounts based on each firm's rules
 * and drawdown headroom. Enforces directional consistency across
 * accounts to prevent cross-account hedging detection.
 */

import type { 
  FirmProfile, AccountState, Position, TradeSignal, 
  TradingAdapter, OrderRequest 
} from '../engine/types.js';
import { DrawdownMonitor } from '../engine/drawdown-monitor.js';
import { DailyLossMonitor } from '../engine/daily-loss-monitor.js';
import { PositionSizer } from '../engine/position-sizer.js';
import { ConsistencyEnforcer } from '../engine/consistency-enforcer.js';
import { SessionManager } from '../engine/session-manager.js';
import { KillSwitch } from '../engine/kill-switch.js';
import { StrategyBlacklist } from '../engine/strategy-blacklist.js';
import { logger } from '../utils/logger.js';
import { eventBus } from '../utils/event-bus.js';

export interface ManagedAccount {
  profile: FirmProfile;
  adapter: TradingAdapter;
  state: AccountState;
  drawdownMonitor: DrawdownMonitor;
  dailyLossMonitor: DailyLossMonitor;
  positionSizer: PositionSizer;
  consistencyEnforcer: ConsistencyEnforcer;
  sessionManager: SessionManager;
  killSwitch: KillSwitch;
  blacklist: StrategyBlacklist;
  status: 'active' | 'locked' | 'passed' | 'failed';
}

export class AccountManager {
  private accounts: Map<string, ManagedAccount> = new Map();

  /**
   * Register a new prop firm account.
   */
  async registerAccount(
    profile: FirmProfile,
    adapter: TradingAdapter
  ): Promise<ManagedAccount> {
    await adapter.connect();
    
    const balance = await adapter.getAccountBalance();
    const equity = await adapter.getAccountEquity();

    const killSwitch = new KillSwitch();
    killSwitch.setAdapter(adapter);

    const account: ManagedAccount = {
      profile,
      adapter,
      state: {
        firm_id: profile.firm_id,
        initial_balance: profile.account_size,
        current_balance: balance,
        current_equity: equity,
        peak_equity: equity,
        drawdown_floor: 0,
        daily_loss_used: 0,
        daily_loss_limit: 0,
        balance_at_day_reset: balance,
        total_challenge_profit: 0,
        daily_profit: 0,
        trading_days_count: 0,
        start_date: new Date().toISOString(),
        last_reset_utc: new Date().toISOString(),
        is_locked_out: false,
        lockout_reason: null,
        open_positions: [],
        closed_trades_today: [],
        all_closed_trades: []
      },
      drawdownMonitor: new DrawdownMonitor(profile, profile.account_size),
      dailyLossMonitor: new DailyLossMonitor(profile, profile.account_size, equity),
      positionSizer: new PositionSizer(profile, profile.account_size),
      consistencyEnforcer: new ConsistencyEnforcer(profile),
      sessionManager: new SessionManager(profile),
      killSwitch,
      blacklist: new StrategyBlacklist(profile),
      status: 'active'
    };

    this.accounts.set(profile.firm_id, account);

    logger.info(`Account registered: ${profile.firm_name} (${profile.firm_id})`, {
      accountSize: profile.account_size,
      drawdownModel: profile.drawdown_model,
      platform: profile.platform
    });

    return account;
  }

  /**
   * Route a trade signal to eligible accounts.
   * Enforces directional consistency across all accounts.
   */
  async routeSignal(signal: TradeSignal): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();

    // Get all positions across all accounts for cross-account hedging check
    const allPositions = new Map<string, Position[]>();
    for (const [firmId, account] of this.accounts) {
      const positions = await account.adapter.getOpenPositions();
      allPositions.set(firmId, positions);
    }

    for (const [firmId, account] of this.accounts) {
      if (account.status !== 'active') {
        results.set(firmId, false);
        continue;
      }

      // Check if we can trade on this account
      const canTrade = await this.canExecuteOnAccount(account, signal, allPositions);
      
      if (canTrade.approved) {
        try {
          await this.executeSignalOnAccount(account, signal, canTrade.lots);
          results.set(firmId, true);
        } catch (error) {
          logger.error(`Failed to execute signal on ${firmId}`, { error });
          results.set(firmId, false);
        }
      } else {
        logger.info(`Signal rejected for ${firmId}: ${canTrade.reason}`, {
          signalId: signal.id,
          instrument: signal.instrument
        });
        results.set(firmId, false);
      }
    }

    return results;
  }

  /**
   * Check if a signal can be executed on a specific account.
   */
  private async canExecuteOnAccount(
    account: ManagedAccount,
    signal: TradeSignal,
    allPositions: Map<string, Position[]>
  ): Promise<{ approved: boolean; lots: number; reason?: string }> {
    // 1. Session check
    if (!account.sessionManager.isTradingAllowed()) {
      return { approved: false, lots: 0, reason: 'Session not active' };
    }

    // 2. Kill switch check
    if (account.killSwitch.isInLockout()) {
      return { approved: false, lots: 0, reason: 'Account in lockout' };
    }

    // 3. Daily loss limit check
    const positions = allPositions.get(account.profile.firm_id) || [];
    if (!account.dailyLossMonitor.canOpenNewPosition(positions)) {
      return { approved: false, lots: 0, reason: 'Daily loss limit approaching' };
    }

    // 4. Blacklist check
    const order: OrderRequest = {
      instrument: signal.instrument,
      side: signal.side,
      type: 'market',
      lots: 0.01, // Minimum for check
      stop_loss: signal.stop_loss
    };

    const blacklistResult = account.blacklist.check(
      order,
      positions,
      account.state.closed_trades_today,
      allPositions
    );

    if (!blacklistResult.approved) {
      return { approved: false, lots: 0, reason: blacklistResult.violations.join('; ') };
    }

    // 5. Position sizing
    const equity = await account.adapter.getAccountEquity();
    const ddState = account.drawdownMonitor.update(equity);
    const dailyHeadroom = account.dailyLossMonitor.getRemainingHeadroom(positions);
    const ddHeadroom = account.drawdownMonitor.getRemainingHeadroom(equity);

    const sizeResult = account.positionSizer.calculate({
      instrument: signal.instrument,
      signal_confidence: signal.confidence,
      entry_price: signal.entry_price,
      stop_loss: signal.stop_loss,
      atr: signal.indicator_values.atr_14,
      remaining_daily_headroom: dailyHeadroom,
      remaining_max_drawdown_headroom: ddHeadroom,
      current_open_exposure: positions.reduce((s, p) => s + p.lots, 0),
      is_funded: false // Will be determined by account type
    });

    if (!sizeResult.approved) {
      return { approved: false, lots: 0, reason: sizeResult.rejection_reason };
    }

    // 6. Apply drawdown reduction
    const ddMultiplier = account.drawdownMonitor.getPositionSizeMultiplier(equity);
    const consistencyMultiplier = account.consistencyEnforcer.getPositionSizeMultiplier();
    const finalMultiplier = ddMultiplier * consistencyMultiplier;

    const adjustedSize = account.positionSizer.applyDrawdownReduction(sizeResult, finalMultiplier);

    if (!adjustedSize.approved) {
      return { approved: false, lots: 0, reason: adjustedSize.rejection_reason };
    }

    return { approved: true, lots: adjustedSize.lots };
  }

  /**
   * Execute a signal on a specific account.
   */
  private async executeSignalOnAccount(
    account: ManagedAccount,
    signal: TradeSignal,
    lots: number
  ): Promise<void> {
    const order: OrderRequest = {
      instrument: signal.instrument,
      side: signal.side,
      type: 'market',
      lots,
      stop_loss: signal.stop_loss,
      take_profit: signal.take_profit,
      signal_id: signal.id
    };

    const position = await account.adapter.placeOrder(order);
    account.state.open_positions.push(position);
    account.blacklist.recordTrade();

    eventBus.emitEngine({ type: 'POSITION_OPENED', position });

    logger.info(`Trade executed on ${account.profile.firm_id}`, {
      signalId: signal.id,
      lots,
      instrument: signal.instrument,
      side: signal.side,
      entryPrice: position.entry_price
    });
  }

  /**
   * Update all account states (called on each tick).
   */
  async updateAll(): Promise<void> {
    for (const [firmId, account] of this.accounts) {
      if (account.status !== 'active') continue;

      try {
        const equity = await account.adapter.getAccountEquity();
        const balance = await account.adapter.getAccountBalance();
        const positions = await account.adapter.getOpenPositions();

        account.state.current_equity = equity;
        account.state.current_balance = balance;
        account.state.open_positions = positions;

        // Update monitors
        const ddState = account.drawdownMonitor.update(equity);
        const dailyState = account.dailyLossMonitor.update(positions);

        account.state.drawdown_floor = ddState.floor;
        account.state.daily_loss_used = dailyState.daily_loss_used;
        account.state.daily_loss_limit = dailyState.daily_limit;

        // Check for critical conditions
        if (ddState.is_breached || dailyState.is_breached) {
          account.status = 'locked';
          account.state.is_locked_out = true;
          account.state.lockout_reason = ddState.is_breached ? 'Max drawdown breached' : 'Daily loss limit breached';
        } else if (dailyState.is_critical) {
          // Flatten all positions at 85% daily loss
          await account.killSwitch.trigger('Daily loss limit at 85%');
        }

        // Check weekend close
        if (account.sessionManager.shouldCloseForWeekend()) {
          await account.adapter.closeAllPositions();
        }
      } catch (error) {
        logger.error(`Failed to update account ${firmId}`, { error });
      }
    }
  }

  /**
   * Get all managed accounts.
   */
  getAccounts(): Map<string, ManagedAccount> {
    return this.accounts;
  }

  /**
   * Get a specific account by firm ID.
   */
  getAccount(firmId: string): ManagedAccount | undefined {
    return this.accounts.get(firmId);
  }
}
