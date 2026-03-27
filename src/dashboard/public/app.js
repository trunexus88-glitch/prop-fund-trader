/**
 * TRU-NEXUS Dashboard Client
 * Real-time WebSocket updates and DOM rendering
 */

// ─── WebSocket Connection ───────────────────────────────────────────────

let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 10;
const events = [];
const MAX_EVENTS = 200;

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    reconnectAttempts = 0;
    updateSystemStatus('active', 'RUNNING');
    addEvent('info', 'Connected to TRU-NEXUS engine');
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      if (data.type === 'engine_event') {
        handleEngineEvent(data.data);
      } else {
        // Dashboard snapshot
        updateDashboard(data);
      }
    } catch (e) {
      console.error('WebSocket message error:', e);
    }
  };

  ws.onclose = () => {
    updateSystemStatus('error', 'DISCONNECTED');
    addEvent('error', 'Connection lost — reconnecting...');
    
    if (reconnectAttempts < MAX_RECONNECT) {
      reconnectAttempts++;
      setTimeout(connect, 2000 * reconnectAttempts);
    }
  };

  ws.onerror = () => {
    updateSystemStatus('error', 'ERROR');
  };
}

// ─── Dashboard Update ───────────────────────────────────────────────────

function updateDashboard(snapshot) {
  // Update header stats
  document.getElementById('uptime').textContent = formatUptime(snapshot.uptime_seconds);
  document.getElementById('signalsToday').textContent = snapshot.signals_today;
  document.getElementById('tradesToday').textContent = snapshot.trades_today;
  document.getElementById('lastUpdate').textContent = `Last update: ${new Date(snapshot.timestamp).toLocaleTimeString()}`;

  // Update account cards
  const grid = document.getElementById('accountsGrid');
  if (snapshot.accounts && snapshot.accounts.length > 0) {
    grid.innerHTML = snapshot.accounts.map(renderAccountCard).join('');
  }

  // Update risk monitors
  const riskPanel = document.getElementById('riskMonitors');
  if (snapshot.accounts && snapshot.accounts.length > 0) {
    riskPanel.innerHTML = snapshot.accounts.map(renderRiskGauges).join('');
  }
}

// ─── Account Card Renderer ──────────────────────────────────────────────

function renderAccountCard(account) {
  const pnlClass = account.total_pnl > 0 ? 'profit' : account.total_pnl < 0 ? 'loss' : 'neutral';
  const statusClass = account.status;
  const pnlSign = account.total_pnl >= 0 ? '+' : '';

  return `
    <div class="account-card ${statusClass}">
      <div class="card-header">
        <div class="card-firm">${account.firm_name}</div>
        <div class="card-status ${statusClass}">${account.status.toUpperCase()}</div>
      </div>
      <div class="card-balance ${pnlClass}">
        $${account.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
      </div>
      <div class="card-metrics">
        <div class="card-metric">
          <span class="metric-label">Today P&L</span>
          <span class="metric-value" style="color: ${account.todays_pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">
            ${pnlSign}$${account.todays_pnl.toFixed(2)}
          </span>
        </div>
        <div class="card-metric">
          <span class="metric-label">Total P&L</span>
          <span class="metric-value" style="color: ${account.total_pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">
            ${pnlSign}$${account.total_pnl.toFixed(2)}
          </span>
        </div>
        <div class="card-metric">
          <span class="metric-label">Win Rate</span>
          <span class="metric-value">${(account.win_rate * 100).toFixed(1)}%</span>
        </div>
        <div class="card-metric">
          <span class="metric-label">Open Pos.</span>
          <span class="metric-value">${account.open_positions}</span>
        </div>
        <div class="card-metric">
          <span class="metric-label">DD Used</span>
          <span class="metric-value" style="color: ${getGaugeColor(account.drawdown_used_pct)}">
            ${(account.drawdown_used_pct * 100).toFixed(1)}%
          </span>
        </div>
        <div class="card-metric">
          <span class="metric-label">Trading Days</span>
          <span class="metric-value">${account.trading_days}</span>
        </div>
      </div>
    </div>
  `;
}

// ─── Risk Gauge Renderer ────────────────────────────────────────────────

function renderRiskGauges(account) {
  const ddPct = account.drawdown_used_pct * 100;
  const dailyPct = account.daily_loss_used_pct * 100;

  return `
    <div class="gauge-container">
      <div class="gauge-header">
        <span class="gauge-title">${account.firm_name} — Max Drawdown</span>
        <span class="gauge-value" style="color: ${getGaugeColor(account.drawdown_used_pct)}">
          ${ddPct.toFixed(1)}%
        </span>
      </div>
      <div class="gauge-bar">
        <div class="gauge-fill ${getGaugeClass(ddPct)}" style="width: ${Math.min(100, ddPct)}%"></div>
      </div>
      <div class="gauge-markers">
        <span class="gauge-marker">0%</span>
        <span class="gauge-marker" style="color: var(--accent-orange)">80%</span>
        <span class="gauge-marker" style="color: var(--accent-red)">90%</span>
        <span class="gauge-marker">100%</span>
      </div>
    </div>
    <div class="gauge-container">
      <div class="gauge-header">
        <span class="gauge-title">${account.firm_name} — Daily Loss</span>
        <span class="gauge-value" style="color: ${getGaugeColor(dailyPct / 100)}">
          ${dailyPct.toFixed(1)}%
        </span>
      </div>
      <div class="gauge-bar">
        <div class="gauge-fill ${getGaugeClass(dailyPct)}" style="width: ${Math.min(100, dailyPct)}%"></div>
      </div>
      <div class="gauge-markers">
        <span class="gauge-marker">0%</span>
        <span class="gauge-marker" style="color: var(--accent-orange)">70%</span>
        <span class="gauge-marker" style="color: var(--accent-red)">85%</span>
        <span class="gauge-marker">100%</span>
      </div>
    </div>
  `;
}

// ─── Engine Event Handler ───────────────────────────────────────────────

function handleEngineEvent(event) {
  switch (event.type) {
    case 'KILL_SWITCH_TRIGGERED':
      addEvent('error', `🚨 KILL SWITCH: ${event.reason}`);
      break;
    case 'DRAWDOWN_WARNING':
      addEvent('warning', `⚠️ Drawdown warning: ${(event.level * 100).toFixed(1)}% consumed`);
      break;
    case 'DRAWDOWN_CRITICAL':
      addEvent('error', `🔴 Drawdown CRITICAL: ${(event.level * 100).toFixed(1)}% consumed`);
      break;
    case 'DAILY_LOSS_WARNING':
      addEvent('warning', `⚠️ Daily loss: ${(event.used_pct * 100).toFixed(1)}% consumed`);
      break;
    case 'DAILY_LOSS_CRITICAL':
      addEvent('error', `🔴 Daily loss CRITICAL: ${(event.used_pct * 100).toFixed(1)}%`);
      break;
    case 'SIGNAL_GENERATED':
      addEvent('info', `📊 Signal: ${event.signal?.side} ${event.signal?.instrument} (conf: ${event.signal?.confidence})`);
      break;
    case 'POSITION_OPENED':
      addEvent('success', `📈 Opened: ${event.position?.side} ${event.position?.instrument} ${event.position?.lots} lots`);
      break;
    case 'POSITION_CLOSED':
      const pnl = event.trade?.realized_pnl;
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      addEvent(pnl >= 0 ? 'success' : 'warning', `📉 Closed: ${event.trade?.instrument} ${pnlStr}`);
      addTradeRow(event.trade);
      break;
    case 'DAILY_RESET':
      addEvent('info', `🔄 Daily reset — new limit: $${event.new_daily_limit?.toFixed(2)}`);
      break;
    case 'STRATEGY_BLOCKED':
      addEvent('warning', `🚫 Strategy blocked: ${event.strategy} — ${event.reason}`);
      break;
    case 'SESSION_BLACKOUT':
      addEvent('warning', `⏸️ Session blackout: ${event.reason}`);
      break;
    case 'CONSISTENCY_WARNING':
      addEvent('warning', `📏 Consistency: daily profit at ${(event.daily_pct * 100).toFixed(1)}% of total (threshold: ${(event.threshold * 100).toFixed(0)}%)`);
      break;
    default:
      addEvent('info', `Event: ${event.type}`);
  }
}

// ─── Event Log ──────────────────────────────────────────────────────────

function addEvent(level, message) {
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', { hour12: false });
  
  events.unshift({ time, level, message });
  if (events.length > MAX_EVENTS) events.pop();

  const log = document.getElementById('eventLog');
  log.innerHTML = events.map(e => `
    <div class="event-item ${e.level}">
      <span class="event-time">${e.time}</span>
      <span class="event-text">${e.message}</span>
    </div>
  `).join('');
}

// ─── Trade Row ──────────────────────────────────────────────────────────

function addTradeRow(trade) {
  if (!trade) return;
  
  const tbody = document.getElementById('tradesBody');
  const emptyRow = tbody.querySelector('.empty-row');
  if (emptyRow) emptyRow.remove();

  const pnlClass = trade.realized_pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
  const sideClass = trade.side === 'buy' ? 'side-buy' : 'side-sell';
  const pnlSign = trade.realized_pnl >= 0 ? '+' : '';

  const row = document.createElement('tr');
  row.innerHTML = `
    <td>${new Date(trade.closed_at).toLocaleTimeString('en-US', { hour12: false })}</td>
    <td>${trade.firm_id || '—'}</td>
    <td>${trade.instrument}</td>
    <td class="${sideClass}">${trade.side.toUpperCase()}</td>
    <td>${trade.lots}</td>
    <td>${trade.entry_price.toFixed(5)}</td>
    <td>${trade.exit_price.toFixed(5)}</td>
    <td class="${pnlClass}">${pnlSign}$${trade.realized_pnl.toFixed(2)}</td>
    <td>${trade.close_reason}</td>
  `;
  
  row.style.animation = 'fadeIn 0.3s ease';
  tbody.insertBefore(row, tbody.firstChild);

  // Keep max 50 rows
  while (tbody.children.length > 50) {
    tbody.removeChild(tbody.lastChild);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function updateSystemStatus(cls, text) {
  const badge = document.getElementById('systemStatus');
  badge.className = `status-badge ${cls}`;
  badge.querySelector('.status-text').textContent = text;
  
  const pulse = badge.querySelector('.pulse');
  pulse.style.background = cls === 'active' ? 'var(--accent-green)' : 'var(--accent-red)';
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getGaugeColor(pct) {
  if (pct >= 0.9) return 'var(--accent-red)';
  if (pct >= 0.7) return 'var(--accent-orange)';
  return 'var(--accent-green)';
}

function getGaugeClass(pct) {
  if (pct >= 90) return 'critical';
  if (pct >= 70) return 'warning';
  return 'safe';
}

// ─── Init ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  addEvent('info', 'Dashboard loaded — connecting to engine...');
  connect();
  
  // Fallback: try REST API if WebSocket fails
  setTimeout(async () => {
    if (reconnectAttempts > 2) {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        updateDashboard(data);
        addEvent('info', 'Loaded via REST API fallback');
      } catch (e) {
        addEvent('error', 'Unable to connect to engine');
      }
    }
  }, 5000);
});
