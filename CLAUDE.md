# TRU-NEXUS Autonomous Trading System — Claude Context

## Mission

Autonomously pass multiple prop firm evaluations and manage funded accounts,
scaling to $150,000 total funded capital within 6 months to generate $10,000/month
net income. The system operates on deterministic risk rules — the engine never
relies on AI inference for safety decisions.

**Current Phase:** 18 COMPLETE — paper trading live under real market conditions.
**Next Phase:** 19 — live execution with real capital (gate: 10+ trading days clean paper results).

---

## Financial Targets

| Metric                        | 6-Month Target                        |
|-------------------------------|---------------------------------------|
| Total funded capital          | $150,000 across multiple accounts     |
| Monthly net income            | $10,000 (after firm splits)           |
| Active evaluations            | Apex $50k, FTMO $100k, TopStep $50k   |
| Profit reinvestment           | 60% back into new evaluations         |
| Personal income               | 40% of gross payouts                  |
| Safety reserve                | 3 months of evaluation fees           |

**Scaling horizon (post-6-month):** $1.5M funded capital is a multi-year goal.
Do not approve scaling plans that jump from Phase 19 ($5k–$50k accounts) to
multi-hundred-thousand capital levels in a single step. Phase-proportionate sizing
applies to all code reviews and recommendations.

---

## Architecture Overview

```
src/
├── engine/                  ← DETERMINISTIC SAFETY LAYER (never touches AI)
│   ├── drawdown-monitor.ts  ← 3 models: static / trailing_eod / trailing_realtime
│   ├── daily-loss-monitor.ts← 3 bases: initial_balance / current_balance / equity_at_reset
│   ├── position-sizer.ts    ← ATR-based sizing, 4-constraint min, 50% exposure cap
│   ├── kill-switch.ts       ← Market-order flatten, <500ms target latency
│   ├── prop-fund-rules.ts   ← Per-firm constraint checking
│   ├── prop-fund-tracker.ts ← State persistence (data/prop-fund-tracker.json)
│   ├── session-manager.ts   ← News blackout, weekend rules, market sessions
│   ├── consistency-enforcer.ts ← Single-day profit % cap enforcement
│   ├── strategy-blacklist.ts← Regimes where strategy is blocked
│   ├── types.ts             ← All shared types (FirmProfile, Position, ClosedTrade…)
│   └── schema.ts            ← Zod validation for all engine inputs
│
├── strategy/                ← AI-ASSISTED SIGNAL LAYER (may use Claude)
│   ├── signal-generator.ts  ← RSI + EMA + S/R ensemble, min confidence 70, forward 70+
│   ├── indicators.ts        ← ATR-14, EMA-9/21/50/200, RSI-14, MACD, Bollinger
│   ├── regime-classifier.ts ← trending_up / trending_down / ranging / volatile / low_liq
│   ├── macro-regime-classifier.ts ← Intermarket correlation regime (DXY, USOIL, yields)
│   ├── correlation-limiter.ts ← Max correlated exposure per cluster
│   └── asset-clusters.ts    ← Instrument groupings for correlation engine
│
├── adapters/                ← PLATFORM LAYER
│   ├── paper-trader.ts      ← Primary test adapter — 1.5 pip spread simulation
│   └── mt5-adapter.ts       ← MT5 REST bridge (localhost:5050 by default)
│
├── firms/profiles/          ← FIRM CONFIGURATIONS (JSON, never hardcode thresholds)
│   ├── apex-50k.json        ← trailing_eod, 5% DD, no daily limit, futures
│   ├── ftmo-100k.json       ← static, 10% DD, 5% daily, min 4 days, mt5
│   ├── topstep-50k.json     ← trailing_eod, 6% DD, 2% daily, futures
│   ├── ft-plus-25k.json     ← trailing_realtime, 6% DD, 4% daily, 30% consistency
│   ├── fundednext-6k.json
│   ├── fxify-100k.json
│   ├── onefunded-5k.json
│   └── prop-fund-target.json← Phase 18 paper target ($5k, 3% daily, 6% trailing)
│
├── accounts/                ← MULTI-ACCOUNT ROUTING
│   └── account-manager.ts   ← Routes signals to correct adapter per firm
│
├── dashboard/               ← MONITORING (Express + WebSocket, port 3456)
│   └── server.ts
│
├── signals/                 ← Telegram signal monitor
├── core/                    ← System bootstrap, event bus wiring
└── utils/                   ← logger.ts, event-bus.ts
```

---

## IMMUTABLE Safety Rules

These rules are hard constraints. They apply in ALL contexts — paper, evaluation,
and funded. No PR, refactor, or new feature may weaken them.

**RULE-1: Kill switch cannot be bypassed.**
`KillSwitch.isInLockout() === true` MUST block all new order placement. No flag,
env variable, or function argument may override a triggered kill switch. The only
reset path is `KillSwitch.reset(acknowledgment)` with an explicit string.

**RULE-2: Every new order MUST have a stop loss.**
`OrderRequest.stop_loss` is required for all new position entries. No order may be
submitted with `stop_loss === 0`, `stop_loss === undefined`, or
`stop_loss === entry_price`. Stop distance must be > 0 pips after instrument-aware
pip conversion. `closePosition()` and `closeAllPositions()` are exempt — they
execute market orders to flatten and do not take a stop loss parameter.

**RULE-3: Position sizes are computed by PositionSizer, never hardcoded.**
Lot size must flow through `PositionSizer.calculate()`. The four constraints
(risk cap, 50% daily headroom, 25% drawdown headroom, 50% total exposure cap)
must all be applied. Hardcoded `lots: 0.1` or similar is a critical bug.

**RULE-4: Paper mode must be verified before any live order.**
The `TradingMode` must be read from `process.env.TRADING_MODE`. If it is not
explicitly `'live'`, the system MUST use `PaperTradingAdapter`. There is no
"I'll handle it in the UI" exception.

**RULE-5: DrawdownMonitor and DailyLossMonitor are the source of truth.**
No code path may compute drawdown or daily loss independently. All checks must
call `.update()` and read from the returned state object. Shadow calculations
are bugs waiting to diverge.

**RULE-6: Event bus one-shot emission flags must not be removed.**
Both monitors implement `hasEmittedWarning`, `hasEmittedCritical`,
`hasEmittedBreach` flags. These MUST remain in the code. Without them, a
breached monitor emits `KILL_SWITCH_TRIGGERED` on every 2-second tick, causing
an event storm that fills logs and re-triggers the already-flat kill switch.

**RULE-7: Firm profiles are loaded from JSON, never from inline objects.**
All threshold values (drawdown %, daily loss %, consistency rule) must be read
from `src/firms/profiles/<firm_id>.json`. Constants must not be duplicated into
TypeScript files, as this creates two diverging sources of truth.

**RULE-8: No secrets in source files.**
API keys, broker credentials, and tokens live exclusively in `.env`. Files
committed to git must use environment variable references only. `.env.example`
with placeholder strings is acceptable.

---

## Phase System

| Phase | Status    | Description                                      |
|-------|-----------|--------------------------------------------------|
| 1–17  | Complete  | Architecture, engine, strategy, adapters, tests  |
| 18    | COMPLETE  | Paper trading — 10+ day clean run required       |
| 19    | NEXT      | Live execution — real capital, one account first |
| 20    | Planned   | Multi-account parallelism + auto-compounding     |
| 21    | Planned   | Live scaling to $150k funded (6-month target)    |

**Phase 19 Gate Criteria (all must be green before go-live):**

Quantitative (from `data/prop-fund-tracker.json`):
- [ ] `trading_days_count >= 10`
- [ ] Win rate of all paper trades >= 45%
- [ ] Average realized R:R >= 1.8
- [ ] Total paper profit > 0
- [ ] No kill switch trigger in last 5 trading days
- [ ] Maximum single-day loss < 70% of daily limit on any day
- [ ] Consistency score: no day > 25% of total profit

Operational:
- [ ] `.env` has `MT5_REST_URL` and `MT5_REST_KEY` populated
- [ ] MT5 bridge confirmed running at `MT5_REST_URL`
- [ ] `TRADING_MODE=live` set in `.env`

**Do not proceed to Phase 19 if any of the above is unchecked.**

---

## Code Standards

**Language:** TypeScript strict mode, ES2022 target, `"type": "module"`.
All new files are `.ts`. Never add `.js` source files.

**Validation:** All external inputs (broker responses, env vars, JSON configs)
must be validated through Zod schemas defined in `src/engine/schema.ts` before
any engine component receives them.

**Event bus:** Inter-component communication uses the singleton `eventBus` from
`src/utils/event-bus.ts`. Direct method calls between engine components are
permitted only for synchronous queries. State mutations triggered by another
component's decision must go through the event bus so the dashboard and logger
pick them up.

**Logging:** Use the named loggers:
- `riskLogger` — all engine/ safety decisions
- `tradeLogger` — all order placement and position changes
- `signalLogger` — all signal generation and rejection

**Error handling:** Async errors in adapters must be caught and re-thrown with
context. A failed `closeAllPositions()` must log
`'Kill switch flatten FAILED — MANUAL INTERVENTION REQUIRED'` and still mark
`isTriggered = true` to prevent any new orders.

**Pip sizes:** Always use `PositionSizer.getPipSize(instrument)`. JPY pairs = 0.01,
Gold = 0.10, standard forex = 0.0001. A wrong pip size causes a 100x error in
position size.

**ATR stops:** Stop loss distance = `atr_14 × 1.5`. Take profit = `atr_14 × 2.5`.
Never place a stop tighter than 0.5 ATR.

**Macro filter (mandatory for all new signals):** Any new signal generation logic
must query `RegimeState` from `src/strategy/macro-regime-classifier.ts` before
returning `approved: true`. Signals that ignore DXY/USOIL/yields macro weather
are incomplete — see `.claude/agents/quantitative-reviewer.md` Check 8.

---

## Key File Locations by Concern

| Concern                        | File                                           |
|-------------------------------|------------------------------------------------|
| Add/modify risk thresholds    | `src/firms/profiles/<firm>.json`               |
| Change position sizing logic  | `src/engine/position-sizer.ts`                 |
| Change drawdown behavior      | `src/engine/drawdown-monitor.ts`               |
| Change daily loss behavior    | `src/engine/daily-loss-monitor.ts`             |
| Modify kill switch            | `src/engine/kill-switch.ts`                    |
| Add new indicators            | `src/strategy/indicators.ts`                   |
| Add new signal logic          | `src/strategy/signal-generator.ts`             |
| Macro regime state            | `src/strategy/macro-regime-classifier.ts`      |
| Correlation cluster limits    | `src/strategy/correlation-limiter.ts`          |
| Add new broker adapter        | `src/adapters/` (implement `TradingAdapter`)   |
| Add new firm profile          | `src/firms/profiles/<firm_id>.json`            |
| Session/news blackout rules   | `src/engine/session-manager.ts`                |
| Consistency enforcement       | `src/engine/consistency-enforcer.ts`           |
| Dashboard WebSocket           | `src/dashboard/server.ts`                      |
| All shared types              | `src/engine/types.ts`                          |
| Runtime state persistence     | `data/prop-fund-tracker.json`                  |

---

## Running the System

```bash
npm run dev        # Development mode with file watching
npm run paper      # Paper trading (TRADING_MODE=paper enforced)
npm run test       # Vitest test suite
npm run dashboard  # Dashboard only at http://localhost:3456
npm run build      # Compile to dist/
```

Dashboard: http://localhost:3456

---

## .claude Rules

This project uses modular context files in `.claude/rules/`. Load them when
working on the relevant area:

- `.claude/rules/risk_management.md` — when touching engine/ or position sizing
- `.claude/rules/execution.md` — when touching adapters/ or order flow
- `.claude/rules/evaluation_phase.md` — when discussing phase gates or firm rules

Specialist reviewer agents are in `.claude/agents/`. Invoke them explicitly:
- `RiskManager` — before any PR touching engine/ or position sizing
- `QuantitativeReviewer` — before any PR touching strategy/ or indicators
- `ExecutionAuditor` — before any PR touching adapters/ or order routing

Slash command skills:
- `/backtest` — run test suite and get Phase 19 gate assessment
- `/paper-trade` — validate environment and start paper mode
- `/risk-audit` — full 8-rule compliance check on current branch
