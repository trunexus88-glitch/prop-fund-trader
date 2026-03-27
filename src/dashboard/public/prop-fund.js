/**
 * TRU-NEXUS Prop Fund Readiness Renderer
 * Fetches /api/prop-fund-readiness and renders the readiness section.
 * Uses safe DOM construction (no innerHTML with external data).
 */

// ─── Fetch & Refresh ────────────────────────────────────────────────────────

async function fetchPropFundReadiness() {
  try {
    const res = await fetch('/api/prop-fund-readiness');
    if (!res.ok) return;
    const data = await res.json();
    renderPropFundReadiness(data);
  } catch (e) {
    // Non-critical; dashboard works without it
  }
}

// ─── Renderer (DOM API) ─────────────────────────────────────────────────────

function renderPropFundReadiness(r) {
  const container = document.getElementById('propFundReadiness');
  if (!container) return;

  // Clear existing content
  while (container.firstChild) container.removeChild(container.firstChild);

  const grid = createElement('div', 'pf-readiness');

  // ── Status Banner ──────────────────────────────────────────────────────────
  const statusClass = r.status === 'READY' ? 'ready'
                    : r.status === 'AT RISK' ? 'at-risk'
                    : 'not-ready';

  const banner = createElement('div', 'pf-status-banner ' + statusClass);

  const bannerLeft = createElement('div');

  const statusLabel = createElement('div', 'pf-status-label ' + statusClass);
  statusLabel.textContent = r.status;
  bannerLeft.appendChild(statusLabel);

  const daysNeeded = Math.max(0, 10 - r.daysTracked);
  const statusMsg = createElement('div');
  statusMsg.style.cssText = 'font-size:0.75rem;color:var(--text-muted);margin-top:0.25rem';
  if (r.status === 'READY') {
    statusMsg.textContent = '✅ All conditions met — ready to buy the $5K account';
  } else if (r.status === 'AT RISK') {
    statusMsg.textContent = '🚨 One or more limits breached — investigate before going live';
  } else if (daysNeeded > 0) {
    statusMsg.textContent = daysNeeded + ' more trading day' + (daysNeeded !== 1 ? 's' : '') + ' needed';
  } else if (r.netProfitable) {
    statusMsg.textContent = 'Profitable — consistency or limits need review';
  } else {
    statusMsg.textContent = 'Not yet profitable after fees';
  }
  bannerLeft.appendChild(statusMsg);
  banner.appendChild(bannerLeft);

  const bannerRight = createElement('div', 'pf-status-meta');
  bannerRight.appendChild(metaLine('Account:', '$5,000'));
  bannerRight.appendChild(metaLine('Days tracked:', r.daysTracked + ' / 10 min'));
  const pnlColor = r.totalPnL >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
  const pnlSign = r.totalPnL >= 0 ? '+' : '';
  bannerRight.appendChild(metaLine('Net P&L:', pnlSign + '$' + r.totalPnL.toFixed(2), pnlColor));
  banner.appendChild(bannerRight);

  grid.appendChild(banner);

  // ── Daily Loss Gauge ───────────────────────────────────────────────────────
  const dailyBarPct = Math.min(100, r.dailyLimitUsedPct * 100);
  const dailyBarClass = dailyBarPct >= 85 ? 'critical' : dailyBarPct >= 70 ? 'warning' : 'safe';
  const todaySign = r.todayPnL >= 0 ? '+' : '';

  grid.appendChild(buildGauge(
    'Daily Loss Used',
    todaySign + '$' + Math.abs(r.todayPnL).toFixed(2),
    dailyBarPct.toFixed(1) + '% of 3% limit',
    dailyBarPct,
    dailyBarClass,
    ['$0', '$125 (cutoff)', '$150 (limit)']
  ));

  // ── Drawdown Gauge ─────────────────────────────────────────────────────────
  const ddBarPct = Math.min(100, r.drawdownUsedPct * 100);
  const ddBarClass = ddBarPct >= 90 ? 'critical' : ddBarPct >= 80 ? 'warning' : 'safe';

  grid.appendChild(buildGauge(
    'Drawdown from Peak',
    'Peak: $' + r.peakEquity.toFixed(2),
    (r.drawdownFromPeakPct * 100).toFixed(2) + '% of 6% max',
    ddBarPct,
    ddBarClass,
    ['$0', '5% (reduce)', '6% (halt)']
  ));

  // ── Check Items ────────────────────────────────────────────────────────────
  const checks = createElement('div', 'pf-checks');
  checks.appendChild(pfCheck('Net Profitable', r.netProfitable));
  checks.appendChild(pfCheck('Daily Limit Never Breached', !r.dailyLimitBreachedEver));
  checks.appendChild(pfCheck('Drawdown Never Breached', !r.drawdownLimitBreachedEver));
  checks.appendChild(pfCheckStatus('Consistency Rule (15%)', r.consistencyStatus));
  checks.appendChild(pfCheck('10+ Trading Days', r.daysTracked >= 10));
  checks.appendChild(pfCheck("Today's Session Safe", r.dailyLimitUsedPct < 0.83));
  grid.appendChild(checks);

  container.appendChild(grid);
}

// ─── DOM Helpers ─────────────────────────────────────────────────────────────

function createElement(tag, className) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

function metaLine(label, value, valueColor) {
  const line = createElement('div');
  line.style.fontSize = '0.75rem';
  const labelSpan = document.createElement('span');
  labelSpan.textContent = label + ' ';
  labelSpan.style.color = 'var(--text-muted)';
  const valueSpan = document.createElement('strong');
  valueSpan.textContent = value;
  valueSpan.style.color = valueColor || 'var(--text-primary)';
  line.appendChild(labelSpan);
  line.appendChild(valueSpan);
  return line;
}

function buildGauge(labelText, rightText, valueText, pct, barClass, markers) {
  const block = createElement('div', 'pf-gauge-block');

  const labelRow = createElement('div', 'pf-gauge-label');
  const labelLeft = document.createElement('span');
  labelLeft.textContent = labelText;
  const labelRight = document.createElement('span');
  labelRight.textContent = rightText;
  labelRight.style.color = 'var(--text-primary)';
  labelRow.appendChild(labelLeft);
  labelRow.appendChild(labelRight);
  block.appendChild(labelRow);

  const valueEl = createElement('div', 'pf-gauge-value');
  valueEl.textContent = valueText;
  const valColor = barClass === 'critical' ? 'var(--accent-red)'
                 : barClass === 'warning'  ? 'var(--accent-orange)'
                 : 'var(--accent-green)';
  valueEl.style.color = valColor;
  block.appendChild(valueEl);

  const track = createElement('div', 'pf-bar-track');
  const fill = createElement('div', 'pf-bar-fill ' + barClass);
  fill.style.width = Math.min(100, pct) + '%';
  track.appendChild(fill);
  block.appendChild(track);

  const markerRow = createElement('div', 'pf-bar-markers');
  markers.forEach(function(m) {
    const s = document.createElement('span');
    s.textContent = m;
    markerRow.appendChild(s);
  });
  block.appendChild(markerRow);

  return block;
}

function pfCheck(label, passed) {
  const item = createElement('div', 'pf-check-item');
  const dot = createElement('div', 'pf-check-dot ' + (passed ? 'pass' : 'fail'));
  const text = document.createElement('span');
  text.textContent = label;
  item.appendChild(dot);
  item.appendChild(text);
  return item;
}

function pfCheckStatus(label, status) {
  const cls = status === 'ok' ? 'pass' : status === 'warning' ? 'warn' : 'fail';
  const item = createElement('div', 'pf-check-item');
  const dot = createElement('div', 'pf-check-dot ' + cls);
  const text = document.createElement('span');
  text.textContent = label;
  item.appendChild(dot);
  item.appendChild(text);
  return item;
}

// ─── Init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
  fetchPropFundReadiness();
  setInterval(fetchPropFundReadiness, 30000);
});
