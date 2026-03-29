# Risk Management Rules — TRU-NEXUS

Reference files: `src/engine/position-sizer.ts`, `src/engine/drawdown-monitor.ts`,
`src/engine/daily-loss-monitor.ts`, `src/engine/kill-switch.ts`,
`src/engine/prop-fund-rules.ts`

---

## Position Sizing

All position sizes flow through `PositionSizer.calculate(request)`. The method
applies four independent constraints in order; the minimum result governs.

### Risk Caps by Account Type

| Account State        | Max Risk per Trade | Source constant          |
|---------------------|--------------------|--------------------------|
| Evaluation          | 0.5% initial bal   | `maxRiskPctEval = 0.005` |
| Funded (static DD)  | 1.0% initial bal   | `maxRiskPctFunded = 0.01`|
| Trailing drawdown   | 0.3% initial bal   | `maxRiskPctTrailing = 0.003`|

Signal confidence (0–100) scales risk: `adjustedRisk = cap × max(0.5, confidence/100)`.
A 50-confidence signal uses half the risk cap. Never pass confidence < 0 or > 100.

### Four-Constraint Minimum

1. **Risk cap** — account type × confidence multiplier
2. **50% daily headroom** — `remaining_daily_loss_allowance × 0.5`
3. **25% drawdown headroom** — `remaining_max_drawdown_headroom × 0.25`
4. **50% total exposure cap** — `open_risk_usd + new_risk <= 0.50 × account_equity`

If constraint 4 yields `remainingRiskBudget <= 0`, the sizer returns
`approved: false` with reason `'Total exposure cap: 50% of equity is fully committed'`.

### Lot Size Formula

```
rawLots = riskAmount / (stopDistancePips × pipValue)
lots    = floor(rawLots × 100) / 100   ← round DOWN to 0.01 micro lot
```

Minimum lot: 0.01. If the calculated size is below minimum, trade is rejected.

### Worst-Case Slippage Check

After sizing, the sizer adds `2 × ATR-14` to the stop distance and verifies the
worst-case loss still fits within daily headroom. If not, lots are reduced. If the
reduced size is still < 0.01, the trade is rejected.

### Instrument-Aware Pip Sizes

ALWAYS use the sizer's pip logic. Wrong pip size → 100x error in lot calculation.

| Instrument                    | Pip size |
|-------------------------------|----------|
| JPY pairs (USDJPY, EURJPY…)  | 0.01     |
| XAUUSD (Gold)                 | 0.10     |
| XAGUSD (Silver)               | 0.01     |
| BTCUSD                        | 1.00     |
| ETHUSD                        | 0.10     |
| USOIL                         | 0.01     |
| US30 / NAS100 / SPX500        | 1.00     |
| All other forex               | 0.0001   |

---

## Drawdown Monitor

Source: `src/engine/drawdown-monitor.ts`

### Three Drawdown Models

| Model               | Floor behavior                                    | Used by           |
|--------------------|---------------------------------------------------|-------------------|
| `static`           | Fixed: `initialBalance × (1 - maxDD%)`            | FTMO              |
| `trailing_eod`     | Ratchets up to `peakEquityEOD − trailAmount`      | Apex, TopStep     |
| `trailing_realtime`| Ratchets on every tick                            | FT+ $25k          |

Floor only moves UP — it never decreases. Do not write logic that lowers the floor.

### Warning Tiers

| Consumed % | State    | Action                               |
|------------|----------|--------------------------------------|
| < 80%      | Normal   | Full position sizes (multiplier 1.0) |
| 80–89%     | WARNING  | Half position sizes (multiplier 0.5) |
| 90–99%     | CRITICAL | No new positions (multiplier 0.0)   |
| 100%       | BREACH   | Kill switch fires                    |

`getPositionSizeMultiplier(equity)` returns 1.0 / 0.5 / 0.0. Always apply this
to the base size via `applyDrawdownReduction()`.

### One-Shot Emission Flags

`DrawdownMonitor` holds `hasEmittedWarning`, `hasEmittedCritical`, `hasEmittedBreach`.
These MUST remain in the code. They prevent event storms where a breached monitor
emits `KILL_SWITCH_TRIGGERED` on every 2-second tick. Remove them and the system
fills the error log and the kill switch re-triggers on already-flat positions.

---

## Daily Loss Monitor

Source: `src/engine/daily-loss-monitor.ts`

### Daily Loss Basis Types

| Basis              | Limit calculated from                  |
|--------------------|----------------------------------------|
| `initial_balance`  | Always `initialBalance × dailyLossPct` |
| `current_balance`  | Balance at day reset × pct             |
| `equity_at_reset`  | Equity at day reset × pct              |

### Warning Thresholds

| Consumed % | State    | Action                              |
|------------|----------|-------------------------------------|
| < 70%      | Normal   | `can_open_new = true`               |
| 70–84%     | WARNING  | `can_open_new = false` (no new pos) |
| 85–99%     | CRITICAL | Flatten all positions               |
| 100%       | BREACH   | Kill switch fires                   |

**Critical:** daily loss includes FLOATING (unrealized) P&L from open positions.
`update(openPositions)` must be called with the CURRENT position list on every tick.
Calling it with an empty array when positions are open under-reports losses.

### Daily Reset

`performDailyReset(balance, equity)` fires when the UTC clock crosses
`daily_reset_utc` from the firm profile. This resets `closedPnlToday = 0` and
recalculates `dailyLimit` from the chosen basis. The one-shot flags reset too,
allowing the warning cycle to repeat the next day.

---

## Kill Switch

Source: `src/engine/kill-switch.ts`

### Trigger Conditions

Fires when `eventBus` receives `KILL_SWITCH_TRIGGERED`, emitted by:
- `DrawdownMonitor` — equity <= floor (100% consumed)
- `DailyLossMonitor` — daily loss >= daily limit

Target latency from trigger to all-positions-flat: **< 500ms** (local execution).

### Bypass Prevention

`isInLockout()` must be checked before ANY new order placement. When `true`,
no order may be submitted regardless of signal confidence or external commands.

`disarm()` sets `isArmed = false` (suppresses execute) but does NOT clear
`isTriggered`. Never call `disarm()` in production order flow.

### Reset Protocol

`reset(acknowledgment)` requires a non-empty string explaining why. Logged at WARN
level for audit. After reset, `isArmed` is automatically set back to `true`.

### Debounce Guard

`isExecuting` flag prevents concurrent `trigger()` calls from duplicating
`closeAllPositions()`. Do not remove this flag.

---

## Per-Firm Thresholds Reference

| Firm         | DD%  | DD Model           | Daily Limit | Consistency | Min Days |
|--------------|------|--------------------|-------------|-------------|----------|
| Apex $50k    | 5%   | trailing_eod       | None        | None        | 7        |
| FTMO $100k   | 10%  | static             | 5%          | None        | 4        |
| TopStep $50k | 6%   | trailing_eod       | 2%          | None        | 5        |
| FT+ $25k     | 6%   | trailing_realtime  | 4%          | 30%/day     | 1        |

All values are loaded from `src/firms/profiles/*.json` — never hardcode them.

---

## Code Patterns: Use vs. Avoid

**Use:**
```typescript
// Always read from monitor state objects
const ddState = drawdownMonitor.update(currentEquity);
const multiplier = drawdownMonitor.getPositionSizeMultiplier(currentEquity);
const sized = positionSizer.applyDrawdownReduction(baseSize, multiplier);

// Always pass open positions to daily monitor (not an empty array)
const dailyState = dailyLossMonitor.update(openPositions);
if (!dailyState.can_open_new) return; // block new trades at 70% consumed
```

**Avoid:**
```typescript
// NEVER compute drawdown independently
const ddPct = (peak - equity) / peak; // Shadow calculation — will drift

// NEVER hardcode lot sizes
const order = { lots: 0.1, ... }; // Bypasses all four constraints

// NEVER skip stop loss on new orders
const order = { instrument: 'EURUSD', side: 'buy', lots: 0.01 }; // Missing SL — illegal

// NEVER check kill switch only in some code paths
adapter.placeOrder(order); // Must be preceded by if (killSwitch.isInLockout()) return;
```
