/**
 * TRU-NEXUS Dashboard Server
 * ═══════════════════════════════════════════════════════════════════════════
 * Express server at :3456 providing real-time monitoring of all accounts,
 * drawdown gauges, consistency trackers, and trade logs.
 */

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { AccountManager } from '../accounts/account-manager.js';
import type { AccountDashboard, DashboardSnapshot } from '../engine/types.js';
import { logger } from '../utils/logger.js';
import { eventBus } from '../utils/event-bus.js';
import type { PropFundTracker } from '../engine/prop-fund-tracker.js';
import { PROP_FUND_RULES } from '../engine/prop-fund-rules.js';
// Phase 20 — macro regime dashboard data
import { getMacroSnapshot } from '../core/lib/macro-provider.js';
import {
  classifyMacroRegime,
  macroRegimeLabel,
  macroRegimeColor,
} from '../strategy/macro-regime-classifier.js';
import { getCluster } from '../strategy/asset-clusters.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function startDashboard(
  accountManager: AccountManager,
  port: number = 3456,
  propFundTracker?: PropFundTracker,
  lastSignalMeta?: Map<string, {
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
  }>
) {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server });

  // Serve static files
  app.use(express.static(join(__dirname, 'public')));

  // API endpoints
  app.get('/api/status', async (req, res) => {
    const snapshot = await buildSnapshot(accountManager);
    res.json(snapshot);
  });

  app.get('/api/accounts', async (req, res) => {
    const accounts: AccountDashboard[] = [];
    for (const [, account] of accountManager.getAccounts()) {
      accounts.push(await buildAccountDashboard(account));
    }
    res.json(accounts);
  });

  app.get('/api/accounts/:firmId', async (req, res) => {
    const account = accountManager.getAccount(req.params.firmId);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    res.json({
      dashboard: await buildAccountDashboard(account),
      state: account.state,
      drawdown: account.drawdownMonitor.update(account.state.current_equity),
      session: account.sessionManager.getState(),
      killSwitch: account.killSwitch.getState()
    });
  });

  // Phase 21 — Last signal metadata per instrument (state score, vol, tier, etc.)
  app.get('/api/last-signals', (_req, res) => {
    if (!lastSignalMeta || lastSignalMeta.size === 0) {
      res.json({ signals: [], note: 'No V2 signals generated yet' });
      return;
    }
    res.json({
      signals: Array.from(lastSignalMeta.values()).sort((a, b) =>
        b.metaConfidence - a.metaConfidence
      ),
    });
  });

  // Prop fund readiness endpoint — drives the dashboard readiness section
  app.get('/api/prop-fund-readiness', (req, res) => {
    if (!propFundTracker) {
      res.status(503).json({ error: 'Prop fund tracker not initialised' });
      return;
    }

    const pfAccount = accountManager.getAccount('prop_fund_target');
    let currentEquity = PROP_FUND_RULES.accountSize;
    let todayPnL = 0;
    let peakEquity = PROP_FUND_RULES.accountSize;

    if (pfAccount) {
      currentEquity = pfAccount.state.current_equity;
      todayPnL = pfAccount.state.closed_trades_today.reduce(
        (s: number, t: any) => s + t.realized_pnl, 0
      );
      const ddState = pfAccount.drawdownMonitor.update(pfAccount.state.current_equity);
      peakEquity = ddState.peak_equity;
    }

    res.json(propFundTracker.getReadiness(currentEquity, todayPnL, peakEquity));
  });

  app.get('/api/trades/:firmId', (req, res) => {
    const account = accountManager.getAccount(req.params.firmId);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    res.json(account.state.all_closed_trades.slice(-100)); // Last 100 trades
  });

  // ── Phase 20: Macro regime endpoint ─────────────────────────────────────
  // Returns the current macro regime state with DXY/yields/oil driver values.
  // The dashboard JS polls this every 60s to update the regime indicator badge.
  app.get('/api/macro-regime', async (_req, res) => {
    try {
      const macro  = await getMacroSnapshot();
      const regime = classifyMacroRegime(macro);

      // Cluster exposure: count open positions per cluster across all accounts
      const clusterExposure: Record<string, number> = {};
      for (const [, account] of accountManager.getAccounts()) {
        for (const pos of account.state.open_positions) {
          const cluster = getCluster(pos.instrument);
          clusterExposure[cluster] = (clusterExposure[cluster] ?? 0) + 1;
        }
      }

      res.json({
        regime,
        label:           macroRegimeLabel(regime),
        color:           macroRegimeColor(regime),
        is_fallback:     macro.is_fallback,
        fetched_at:      macro.fetchedAt,
        drivers: {
          dxy: {
            price:  macro.dxy.price.toFixed(4),
            ema20:  macro.dxy.ema20.toFixed(4),
            trend:  macro.dxy.trend,
            label:  'DXY Proxy (1/EURUSD)',
          },
          yields: {
            price:  `${macro.yields.price.toFixed(2)}%`,
            ema20:  `${macro.yields.ema20.toFixed(2)}%`,
            trend:  macro.yields.trend,
            label:  'US10Y Yield (^TNX)',
          },
          oil: {
            price:  `$${macro.oil.price.toFixed(2)}`,
            ema20:  `$${macro.oil.ema20.toFixed(2)}`,
            trend:  macro.oil.trend,
            label:  'WTI Crude (CL=F)',
          },
        },
        cluster_exposure: clusterExposure,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(503).json({
        error:   'Macro data unavailable',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // WebSocket for real-time updates
  wss.on('connection', (ws: WebSocket) => {
    logger.info('Dashboard client connected');

    const sendUpdate = async () => {
      try {
        const snapshot = await buildSnapshot(accountManager);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(snapshot));
        }
      } catch (error) {
        // Ignore errors during updates
      }
    };

    // Send initial state
    sendUpdate();

    // Send updates every 2 seconds
    const interval = setInterval(sendUpdate, 2000);

    ws.on('close', () => {
      clearInterval(interval);
      logger.info('Dashboard client disconnected');
    });
  });

  // Forward engine events to WebSocket clients
  eventBus.on('engine', (event: unknown) => {
    const message = JSON.stringify({ type: 'engine_event', data: event });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  });

  server.listen(port, () => {
    logger.info(`Dashboard server running on http://localhost:${port}`);
  });

  return server;
}

async function buildSnapshot(accountManager: AccountManager): Promise<DashboardSnapshot> {
  const accounts: AccountDashboard[] = [];
  let signalsToday = 0;
  let tradesToday = 0;

  for (const [, account] of accountManager.getAccounts()) {
    accounts.push(await buildAccountDashboard(account));
    tradesToday += account.state.closed_trades_today.length;
  }

  // Phase 20 — attach macro regime to every WS snapshot push
  // Using the cached snapshot (no await) so WS sends never block on network calls.
  let macroRegime = 'NEUTRAL';
  let macroRegimeColorStr = '#94a3b8';
  try {
    const macro = await getMacroSnapshot();
    const regime = classifyMacroRegime(macro);
    macroRegime        = regime;
    macroRegimeColorStr = macroRegimeColor(regime);
  } catch {
    // Non-fatal — snapshot proceeds without macro data
  }

  return {
    timestamp: new Date().toISOString(),
    accounts,
    system_status: 'running',
    uptime_seconds: process.uptime(),
    signals_today: signalsToday,
    trades_today: tradesToday,
    macro_regime:       macroRegime,
    macro_regime_color: macroRegimeColorStr,
  };
}

async function buildAccountDashboard(account: any): Promise<AccountDashboard> {
  const state = account.state;
  const trades = state.all_closed_trades || [];
  const wins = trades.filter((t: any) => t.realized_pnl > 0);
  const totalPnl = trades.reduce((s: number, t: any) => s + t.realized_pnl, 0);

  const ddState = account.drawdownMonitor.update(state.current_equity);

  return {
    firm_id: state.firm_id,
    firm_name: account.profile.firm_name,
    balance: state.current_balance,
    equity: state.current_equity,
    drawdown_used_pct: ddState.consumed_pct,
    daily_loss_used_pct: state.daily_loss_limit > 0 ? state.daily_loss_used / state.daily_loss_limit : 0,
    open_positions: state.open_positions.length,
    todays_pnl: state.closed_trades_today.reduce((s: number, t: any) => s + t.realized_pnl, 0),
    total_pnl: totalPnl,
    win_rate: trades.length > 0 ? wins.length / trades.length : 0,
    avg_rr: 0,
    trading_days: state.trading_days_count,
    consistency_score: account.consistencyEnforcer.getState().todays_profit_pct_of_total,
    status: account.status
  };
}
