/**
 * TRU-NEXUS Autonomous Trading System — Main Entry Point
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the orchestrator that wires together all three layers:
 *   Layer 1: Deterministic Execution Engine
 *   Layer 2: Strategy & Signal Layer
 *   Layer 3: Monitoring & Multi-Account Management
 *
 * The system runs an event loop:
 *   1. Simulate price movement on open positions (paper mode)
 *   2. Classify market regime periodically
 *   3. Generate trade signals
 *   4. Run signals through risk checks
 *   5. Execute approved trades via adapter
 *   6. Update all monitors
 *   7. Log everything
 */

import { config, loadConfig } from './utils/config.js';
import { logger, tradeLogger, riskLogger } from './utils/logger.js';
import { eventBus } from './utils/event-bus.js';
import { loadAllFirmProfiles } from './firms/schema.js';
import { AccountManager } from './accounts/account-manager.js';
import { RegimeClassifier } from './strategy/regime-classifier.js';
import { SignalGenerator } from './strategy/signal-generator.js';
import { ClaudeReviewer } from './strategy/claude-reviewer.js';
import { PaperTradingAdapter } from './adapters/paper-trader.js';
import { startDashboard } from './dashboard/server.js';
import { PropFundTracker } from './engine/prop-fund-tracker.js';
import {
  PROP_FUND_RULES,
  checkDailyLoss,
  checkDrawdown,
  getDrawdownSizeMultiplier,
  canOpenNewTrade,
} from './engine/prop-fund-rules.js';
// Phase 20 — Intermarket Correlation Engine
import { getMacroSnapshot } from './core/lib/macro-provider.js';
import { classifyMacroRegime, logMacroRegime, macroRegimeColor } from './strategy/macro-regime-classifier.js';
import type { MacroRegimeState } from './strategy/macro-regime-classifier.js';
// isDirectionBlocked is now internal to SignalGenerator.generateSignalsV2 (Phase 21)
import { applyCorrelationLimit } from './strategy/correlation-limiter.js';
import type { FirmProfile, TradeSignal, EngineEvent } from './engine/types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 2000;             // Main loop tick
const REGIME_UPDATE_INTERVAL_MS = 60000;   // Classify regime every 60s
const DAILY_REVIEW_HOUR = 22;              // 10 PM UTC daily review
const MAX_OPEN_POSITIONS_PER_ACCOUNT = 3;  // Cap simultaneous positions

// ── Prop Fund Mode ──────────────────────────────────────────────────────────

/** The ID of the prop fund target account — the one we're paper trading as if live. */
const PROP_FUND_ACCOUNT_ID = 'prop_fund_target';

/** Forex pairs to trade for the prop fund account. */
const FOREX_INSTRUMENTS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF'];

/**
 * London/NY overlap window (UTC hours, inclusive of start, exclusive of end).
 * 13:00–17:00 UTC = highest liquidity, tightest spreads, most momentum.
 * This is a HARD GATE — no forex signals generated outside this window.
 */
const SESSION_START_UTC = 13;
const SESSION_END_UTC = 17;

/**
 * Minimum time (ms) between signals for the same instrument.
 * In-session: 15 minutes. Outside session: 60 minutes.
 * Prevents overtrading while still capturing moves during busy periods.
 */
const IN_SESSION_COOLDOWN_MS = 15 * 60 * 1000;   // 15 minutes
const OUT_SESSION_COOLDOWN_MS = 60 * 60 * 1000;   // 60 minutes

// ─── Signal Check Intervals ─────────────────────────────────────────────────

/** How often to check for signals during the active London/NY session. */
const SIGNAL_CHECK_IN_SESSION_MS = 15 * 60 * 1000;   // 15 minutes
/** How often to check for signals outside the active session. */
const SIGNAL_CHECK_OUT_SESSION_MS = 60 * 60 * 1000;  // 60 minutes

// Phase 21: SL/TP multipliers and confidence floor are now internal to
// generateSignalsV2() via the VolatilityEngine and MetaConfidence engines.
// They are no longer set as constants here.

// ─── Global State ───────────────────────────────────────────────────────────

let isRunning = false;
let tickCount = 0;
let lastRegimeUpdate = 0;
let lastSignalCheck = 0;
let lastDailyReview = '';

/** Current macro regime — updated every REGIME_UPDATE_INTERVAL_MS alongside candle regime. */
let currentMacroRegime: MacroRegimeState = 'NEUTRAL';
/** Hex colour string for the latest macro regime (for dashboard WS push). */
let currentMacroRegimeColor = '#94a3b8';  // slate = NEUTRAL

// Track simulated prices per instrument — walks randomly from a starting point
const simulatedPrices: Map<string, number> = new Map();
const INSTRUMENTS = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'BTCUSD'];

// Realistic starting prices
const STARTING_PRICES: Record<string, number> = {
  EURUSD: 1.08500,
  GBPUSD: 1.29200,
  USDJPY: 150.250,
  USDCHF: 0.90500,
  XAUUSD: 2350.00,
  BTCUSD: 87500.00,
};

// Per-instrument pip sizes (for P&L calculation)
const PIP_SIZES: Record<string, number> = {
  EURUSD: 0.0001,
  GBPUSD: 0.0001,
  USDJPY: 0.01,
  USDCHF: 0.0001,
  XAUUSD: 0.10,
  BTCUSD: 1.00,
};

// Per-instrument cooldown tracking — maps instrument → last signal timestamp
const instrumentLastSignal: Map<string, number> = new Map();

// ── Phase 21 — Last signal metadata store ────────────────────────────────────
// Populated by generateAndProcessSignals() for each V2 signal produced.
// Exposed via /api/last-signals for the dashboard cards.
export interface SignalMetadata {
  instrument: string;
  side: string;
  stateScore: number;
  stateLabel: string;
  volatilityState: string;
  regimeAlignment: string;
  metaConfidence: number;
  executionTier: string;
  macroRegime: string;
  timestamp: string;
}
export const lastSignalMeta: Map<string, SignalMetadata> = new Map();

// Prop fund tracker — persists daily P&L summaries to data/prop-fund-tracker.json
const propFundTracker = new PropFundTracker();

const accountManager = new AccountManager();
const regimeClassifier = new RegimeClassifier(config.ollamaBaseUrl, config.ollamaModel);
const signalGenerator = new SignalGenerator();
const claudeReviewer = new ClaudeReviewer(config.anthropicApiKey);

// Keep reference to all paper adapters for direct price updates
const paperAdapters: PaperTradingAdapter[] = [];

// ─── Session Helpers ─────────────────────────────────────────────────────────

function isInSession(): boolean {
  const hourUtc = new Date().getUTCHours();
  return hourUtc >= SESSION_START_UTC && hourUtc < SESSION_END_UTC;
}

function getSignalCheckInterval(): number {
  return isInSession() ? SIGNAL_CHECK_IN_SESSION_MS : SIGNAL_CHECK_OUT_SESSION_MS;
}

function isInstrumentCooledDown(instrument: string): boolean {
  const last = instrumentLastSignal.get(instrument) ?? 0;
  const cooldown = isInSession() ? IN_SESSION_COOLDOWN_MS : OUT_SESSION_COOLDOWN_MS;
  return Date.now() - last >= cooldown;
}

function markInstrumentSignaled(instrument: string): void {
  instrumentLastSignal.set(instrument, Date.now());
}

// ─── Event Listeners ────────────────────────────────────────────────────────

eventBus.on('engine', (event: unknown) => {
  const e = event as EngineEvent;
  switch (e.type) {
    case 'KILL_SWITCH_TRIGGERED':
      riskLogger.error('🚨 KILL SWITCH EVENT', e);
      break;
    case 'DRAWDOWN_WARNING':
      riskLogger.warn('⚠️ Drawdown warning', e);
      break;
    case 'DRAWDOWN_CRITICAL':
      riskLogger.error('🔴 Drawdown critical', e);
      break;
    case 'DAILY_LOSS_WARNING':
      riskLogger.warn('⚠️ Daily loss warning', e);
      break;
    case 'DAILY_LOSS_CRITICAL':
      riskLogger.error('🔴 Daily loss critical', e);
      break;
    case 'SIGNAL_GENERATED':
      tradeLogger.info('📊 Signal generated', { id: (e as any).signal?.id });
      break;
    case 'POSITION_OPENED':
      tradeLogger.info('📈 Position opened', { id: (e as any).position?.id });
      break;
    case 'POSITION_CLOSED':
      tradeLogger.info('📉 Position closed', { id: (e as any).trade?.id });
      break;
    default:
      break;
  }
});

// ─── Price Simulation ───────────────────────────────────────────────────────

function initializePrices(): void {
  const allInstruments = [...INSTRUMENTS, 'USDCHF'];
  for (const instrument of allInstruments) {
    const startPrice = STARTING_PRICES[instrument] ?? 1.10000;
    simulatedPrices.set(instrument, startPrice);
  }
  logger.info('Simulated price feeds initialized', {
    instruments: Object.fromEntries(simulatedPrices)
  });
}

/**
 * Simulate realistic price movement using geometric Brownian motion.
 * This drives SL/TP execution on paper positions.
 */
function simulatePriceTick(): void {
  for (const [instrument, currentPrice] of simulatedPrices) {
    const pipSize = PIP_SIZES[instrument] ?? 0.0001;

    // Volatility scaled per instrument (pips of movement per tick)
    const volatilityPips = instrument === 'BTCUSD' ? 15
                         : instrument === 'XAUUSD' ? 8
                         : instrument === 'USDJPY' ? 3
                         : 2;

    // Random walk with slight mean-reversion
    const startPrice = STARTING_PRICES[instrument] ?? currentPrice;
    const meanReversion = (startPrice - currentPrice) * 0.001; // gentle pull back
    const randomMove = (Math.random() - 0.5) * 2 * volatilityPips * pipSize;
    const newPrice = currentPrice + randomMove + meanReversion;

    simulatedPrices.set(instrument, newPrice);

    const spread = pipSize * 1.5; // 1.5 pip spread
    const bid = newPrice;
    const ask = newPrice + spread;

    // Push price to ALL paper adapters — this triggers SL/TP execution
    for (const adapter of paperAdapters) {
      adapter.updatePrice(instrument, bid, ask);
    }
  }
}

// ─── Main Loop ──────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  tickCount++;
  const now = Date.now();

  try {
    // 1. SIMULATE PRICE MOVEMENT — this is what was missing!
    simulatePriceTick();

    // 2. Update all account states (reads new equity after price moves)
    await accountManager.updateAll();

    // 3. Classify market regime periodically
    if (now - lastRegimeUpdate > REGIME_UPDATE_INTERVAL_MS) {
      await updateRegime();
      lastRegimeUpdate = now;
    }

    // 4. Generate and process signals (interval adapts to session window)
    if (now - lastSignalCheck > getSignalCheckInterval()) {
      await generateAndProcessSignals();
      lastSignalCheck = now;
    }

    // 5. Daily review check
    const currentHour = new Date().getUTCHours();
    const today = new Date().toISOString().split('T')[0];
    if (currentHour === DAILY_REVIEW_HOUR && lastDailyReview !== today) {
      await runDailyReview(today);
      lastDailyReview = today;
    }

    // 6. Log summary every 30 ticks (~1 min)
    if (tickCount % 30 === 0) {
      logSummary();
    }

  } catch (error) {
    logger.error('Tick error', { error, tickCount });
  }
}

function logSummary(): void {
  const sessionTag = isInSession() ? '[IN SESSION 🟢]' : '[OUT SESSION 🔵]';
  logger.info(`[macro] Regime: ${currentMacroRegime} ${sessionTag}`);

  for (const [firmId, account] of accountManager.getAccounts()) {
    if (account.status !== 'active') continue;
    const pnl = account.state.current_balance - account.profile.account_size;
    const openCount = account.state.open_positions.length;
    const closedToday = account.state.closed_trades_today.length;

    logger.info(`[${firmId}] ${sessionTag} Balance: $${account.state.current_balance.toFixed(2)} | P&L: $${pnl.toFixed(2)} | Open: ${openCount} | Closed today: ${closedToday}`);
  }
}

async function updateRegime(): Promise<void> {
  // ── Candle-based local regime (trending/ranging/volatile) ────────────────
  for (const [, account] of accountManager.getAccounts()) {
    if (account.status !== 'active') continue;

    try {
      const candles = await account.adapter.getCandles('EURUSD', '5m', 250);
      const regime = regimeClassifier.classify(candles);
      signalGenerator.setRegime(regime.regime);

      logger.info(`Candle regime: ${regime.regime} (${regime.confidence.toFixed(1)}%)`);
    } catch (error) {
      logger.error('Candle regime update failed', { error });
    }
    break; // First active account is the single candle source
  }

  // ── Macro regime (DXY / US10Y / USOIL intermarket) ──────────────────────
  // getMacroSnapshot() caches for 15 min — this call is cheap on most ticks.
  try {
    const macro      = await getMacroSnapshot();
    const newRegime  = classifyMacroRegime(macro);

    if (newRegime !== currentMacroRegime) {
      logMacroRegime(newRegime, macro);
      logger.info(`Macro regime changed: ${currentMacroRegime} → ${newRegime}`, {
        fallback: macro.is_fallback,
      });
      currentMacroRegime      = newRegime;
      currentMacroRegimeColor = macroRegimeColor(newRegime);
    }
  } catch (error) {
    logger.warn('Macro regime update failed — keeping previous regime', { error, currentMacroRegime });
  }
}

async function generateAndProcessSignals(): Promise<void> {
  const sessionActive = isInSession();
  const sessionTag = sessionActive ? '🟢 IN SESSION' : '🔵 OUT OF SESSION';

  for (const [firmId, account] of accountManager.getAccounts()) {
    if (account.status !== 'active') continue;

    // ── Prop fund account: forex-only, session-gated ────────────────────────
    const isPropFund = firmId === PROP_FUND_ACCOUNT_ID;
    const instrumentList = isPropFund ? FOREX_INSTRUMENTS : INSTRUMENTS;

    if (isPropFund && !sessionActive) {
      // Outside the London/NY overlap: no new signals for prop fund account.
      // The session is a HARD GATE, not just a bonus point.
      logger.debug(`[${firmId}] ${sessionTag} — skipping signal generation`);
      continue;
    }

    // ── Prop fund daily loss cutoff ──────────────────────────────────────────
    // Include BOTH realized (closed) AND floating (unrealized) P&L.
    // Prop firm rules count all open exposure toward the daily limit — a position
    // that's deeply underwater counts against the limit even before it's closed.
    // Checking only realized P&L could allow opening new trades while already at
    // 99% of the daily limit via open floating losses.
    if (isPropFund) {
      const realizedPnL  = account.state.closed_trades_today.reduce(
        (s, t) => s + t.realized_pnl, 0
      );
      const floatingPnL  = account.state.open_positions.reduce(
        (s, p) => s + p.unrealized_pnl, 0
      );
      const totalDailyPnL = realizedPnL + floatingPnL;

      if (!canOpenNewTrade(totalDailyPnL, PROP_FUND_RULES)) {
        riskLogger.warn(`[${firmId}] Prop fund daily loss cutoff reached — no new trades`, {
          realizedPnL:    realizedPnL.toFixed(2),
          floatingPnL:    floatingPnL.toFixed(2),
          totalDailyPnL:  totalDailyPnL.toFixed(2),
          cutoff: `-$${(PROP_FUND_RULES.dailyLossCutoffPct * PROP_FUND_RULES.accountSize).toFixed(2)}`,
        });
        continue;
      }
    }

    // ── Phase 21: Collect all candidate signals across instruments (V2 path) ─
    // generateSignalsV2() internalises the macro gate, regime alignment,
    // adaptive SL/TP, and execution tier.  We still apply the correlation
    // limiter across the full instrument set after collection.
    const candidates: TradeSignal[] = [];

    for (const instrument of instrumentList) {
      try {
        // Per-instrument cooldown — skip if the signal interval hasn't elapsed
        if (!isInstrumentCooledDown(instrument)) continue;

        // ── Step 6: Fetch primary + extra timeframes ──────────────────────────
        const candles = await account.adapter.getCandles(instrument, '5m', 250);

        // 4H and daily candles for the volatility surface.
        // Graceful degradation: if the adapter doesn't expose these timeframes
        // (or the provider is unavailable), V2 estimates from the 1H ATR.
        let candles4h: Awaited<ReturnType<typeof account.adapter.getCandles>> | undefined;
        let candles1d: Awaited<ReturnType<typeof account.adapter.getCandles>> | undefined;
        try {
          candles4h = await account.adapter.getCandles(instrument, '4h', 50);
        } catch { /* provider doesn't support 4H — volatility engine will estimate */ }
        try {
          candles1d = await account.adapter.getCandles(instrument, '1d', 50);
        } catch { /* provider doesn't support 1D — volatility engine will estimate */ }

        // ── V2 signal generation (all internal gates applied) ─────────────────
        const rawSignals = signalGenerator.generateSignalsV2(
          instrument,
          candles,
          { candles4h, candles1d },
          currentMacroRegime
        );

        for (const signal of rawSignals) {
          // Anchor entry to the live simulated price (preserving the adaptive
          // stop distance computed by the volatility engine).
          const currentPrice = simulatedPrices.get(instrument);
          if (currentPrice) {
            const stopDist = Math.abs(signal.entry_price - signal.stop_loss);
            const tpDist   = Math.abs(signal.take_profit  - signal.entry_price);
            signal.entry_price  = parseFloat(currentPrice.toFixed(5));
            signal.stop_loss    = parseFloat(
              (signal.side === 'buy'
                ? currentPrice - stopDist
                : currentPrice + stopDist).toFixed(5)
            );
            signal.take_profit  = parseFloat(
              (signal.side === 'buy'
                ? currentPrice + tpDist
                : currentPrice - tpDist).toFixed(5)
            );
          }

          markInstrumentSignaled(instrument);
          candidates.push(signal);

          // Update last-signal metadata store for dashboard cards
          if (signal.execution_tier && signal.execution_tier !== 'NO_TRADE') {
            lastSignalMeta.set(instrument, {
              instrument,
              side:             signal.side,
              stateScore:       signal.state_score ?? 0,
              stateLabel:       signal.state_label ?? 'UNKNOWN',
              volatilityState:  signal.volatility_state ?? 'NORMAL',
              regimeAlignment:  signal.regime_alignment ?? 'NEUTRAL',
              metaConfidence:   signal.meta_confidence ?? 0,
              executionTier:    signal.execution_tier,
              macroRegime:      currentMacroRegime,
              timestamp:        signal.timestamp,
            });
          }
        }
      } catch (error) {
        logger.error(`Signal gen failed for ${instrument}`, { error });
      }
    }

    if (candidates.length > 0) {
      logger.info(`[v2-analyst] regime=${currentMacroRegime} candidates=${candidates.length}`, {
        sessionTag,
        tiers: candidates.map(s => `${s.instrument}:${s.execution_tier ?? 'legacy'}`),
      });
    }

    if (candidates.length === 0) {
      // Intentional break — see comment below
      break;
    }

    // ── Phase 20 Step 6: Correlation limiter ──────────────────────────────────
    // From each asset cluster, keep only the highest-confidence signal.
    // This prevents simultaneous correlated losses (e.g. EURUSD SELL + GBPUSD SELL
    // both triggered by the same USD strength move).
    const { approved, blocked: correlationBlocked, clusterWinners } = applyCorrelationLimit(candidates);

    if (correlationBlocked.length > 0) {
      logger.info(`[corr-limiter] approved=${approved.length} demoted=${correlationBlocked.length}`, {
        winners: Object.fromEntries(clusterWinners),
      });
    }

    // ── Route approved signals ────────────────────────────────────────────────
    for (const signal of approved) {
      // Check open position cap across all accounts before routing
      let canRoute = true;
      for (const [, acct] of accountManager.getAccounts()) {
        const openPositions = await acct.adapter.getOpenPositions();
        if (openPositions.length >= MAX_OPEN_POSITIONS_PER_ACCOUNT) {
          canRoute = false;
          break;
        }
      }

      if (!canRoute) {
        logger.debug(`[route] ${signal.instrument} skipped — position cap reached`);
        continue;
      }

      logger.info(`Signal [${sessionTag}]: ${signal.side} ${signal.instrument} conf=${signal.confidence} tier=${signal.execution_tier ?? 'legacy'} regime=${currentMacroRegime}`, {
        factors:   signal.confluence_factors,
        isPropFund,
        volState:  signal.volatility_state,
        stateScore: signal.state_score,
      });

      const results = await accountManager.routeSignal(signal);
      for (const [routedFirmId, executed] of results) {
        if (executed) {
          signal.acted_upon = true;
          logger.info(`✅ Executed on ${routedFirmId} [${sessionTag}]`);
        }
      }
    }

    // Intentional break: we use the FIRST active account as the sole candle
    // data source for all signals. Generating signals independently per account
    // would produce correlated-but-slightly-different entries across accounts
    // (due to price feed timing) which the cross-account hedging check in
    // AccountManager interprets as hedging attempts. One signal source →
    // one set of confluence decisions → routed to all eligible accounts.
    break;
  }
}

async function runDailyReview(today: string): Promise<void> {
  logger.info('Running daily strategy review...');

  for (const [firmId, account] of accountManager.getAccounts()) {
    try {
      const review = await claudeReviewer.dailyReview(
        account.state.closed_trades_today,
        [],
        account.state
      );

      logger.info(`Daily review for ${firmId}`, {
        summary: review.summary,
        riskFlags: review.risk_flags,
        adjustments: review.parameter_adjustments.length
      });

      // ── Record day in prop fund tracker ──────────────────────────────────
      if (firmId === PROP_FUND_ACCOUNT_ID) {
        const closedToday = account.state.closed_trades_today;
        const todayPnL = closedToday.reduce((s, t) => s + t.realized_pnl, 0);
        const wins = closedToday.filter(t => t.realized_pnl > 0).length;
        const losses = closedToday.filter(t => t.realized_pnl <= 0).length;
        const ddState = account.drawdownMonitor.update(account.state.current_equity);

        propFundTracker.recordDay({
          day: today,
          startEquity: account.state.balance_at_day_reset,
          endEquity: account.state.current_equity,
          dailyPnL: todayPnL,
          dailyPnLPct: todayPnL / account.profile.account_size,
          peakEquity: ddState.peak_equity,
          drawdownFromPeakPct: (ddState.peak_equity - account.state.current_equity) / ddState.peak_equity,
          tradesOpened: closedToday.length,
          tradesClosed: closedToday.length,
          wins,
          losses,
          dailyLossLimitBreached: ddState.is_breached || account.dailyLossMonitor.update([]).is_breached,
          drawdownLimitBreached: ddState.is_breached,
          consistencyOk: !account.consistencyEnforcer.getState().is_at_limit,
        });
      }
    } catch (error) {
      logger.error(`Daily review failed for ${firmId}`, { error });
    }
  }
}

// ─── Startup ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`
  ████████╗██████╗ ██╗   ██╗    ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗
  ╚══██╔══╝██╔══██╗██║   ██║    ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝
     ██║   ██████╔╝██║   ██║    ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗
     ██║   ██╔══██╗██║   ██║    ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║
     ██║   ██║  ██║╚██████╔╝    ██║ ╚████║███████╗██╔╝ ╚██╗╚██████╔╝███████║
     ╚═╝   ╚═╝  ╚═╝ ╚═════╝     ╚═╝  ╚═══╝╚══════╝╚═╝   ╚═╝ ╚═════╝ ╚══════╝

  Autonomous Trading System v1.0
  Mode: ${config.mode.toUpperCase()}
  Prop Fund Target: $${PROP_FUND_RULES.accountSize.toLocaleString()} | ${PROP_FUND_RULES.dailyLossLimit * 100}% daily limit | ${PROP_FUND_RULES.maxTrailingDrawdown * 100}% max DD
  Session Gate: ${SESSION_START_UTC}:00–${SESSION_END_UTC}:00 UTC (London/NY overlap)
  `);

  logger.info('TRU-NEXUS starting...', { mode: config.mode });

  // Initialize simulated price feeds
  initializePrices();

  // Load firm profiles
  const profiles = loadAllFirmProfiles();
  logger.info(`Loaded ${profiles.size} firm profiles`);

  // Register all profiles with paper trading adapters
  if (config.mode === 'paper') {
    for (const [firmId, profile] of profiles) {
      const adapter = new PaperTradingAdapter(profile.account_size);
      paperAdapters.push(adapter);
      await accountManager.registerAccount(profile, adapter);
      logger.info(`Paper account: ${profile.firm_name} ($${profile.account_size})`);
    }

    // Seed initial prices into all adapters (including USDCHF)
    const allInstruments = [...INSTRUMENTS, 'USDCHF'];
    for (const instrument of allInstruments) {
      const price = simulatedPrices.get(instrument) ?? STARTING_PRICES[instrument] ?? 1.10000;
      const pipSize = PIP_SIZES[instrument] ?? 0.0001;
      for (const adapter of paperAdapters) {
        adapter.updatePrice(instrument, price, price + pipSize * 1.5);
      }
    }
  }

  // Start the dashboard (passes propFundTracker for readiness + lastSignalMeta for V2 cards)
  const dashboardServer = startDashboard(accountManager, config.dashboardPort, propFundTracker, lastSignalMeta);
  logger.info(`Dashboard: http://localhost:${config.dashboardPort}`);

  // Start the main loop
  isRunning = true;
  logger.info('Engine started — price simulation active');
  logger.info(`Prop fund session gate: ${SESSION_START_UTC}:00–${SESSION_END_UTC}:00 UTC | SL/TP adaptive via VolatilityEngine (Phase 21)`);

  const interval = setInterval(async () => {
    if (!isRunning) {
      clearInterval(interval);
      return;
    }
    await tick();
  }, TICK_INTERVAL_MS);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    isRunning = false;
    clearInterval(interval);

    for (const [firmId, account] of accountManager.getAccounts()) {
      try {
        await account.adapter.closeAllPositions();
        await account.adapter.disconnect();
        logger.info(`${firmId} disconnected`);
      } catch (error) {
        logger.error(`Error disconnecting ${firmId}`, { error });
      }
    }

    logger.info('TRU-NEXUS shut down complete');
    process.exit(0);
  });
}

main().catch(error => {
  logger.error('Fatal error', { error });
  process.exit(1);
});
