---
name: backtest
description: Run the vitest test suite and summarize trading performance metrics from test output and data/ logs
---

# /backtest — Run Backtest Suite

## What This Does

Runs the full vitest test suite, reads `data/prop-fund-tracker.json` for historical
performance data, and outputs a structured performance summary with a Phase 19 Gate
assessment.

---

## Execution Steps

**Step 1 — Check data directory:**
```bash
ls -la data/
```

**Step 2 — Run the full test suite with verbose output:**
```bash
npm run test -- --reporter=verbose
```

**Step 3 — Read tracker data:**
```bash
cat data/prop-fund-tracker.json
```

**Step 4 — Compute and display performance metrics:**

Parse the tracker JSON and calculate:

| Metric                  | Source                              | Target         |
|------------------------|-------------------------------------|----------------|
| Total trading days     | `trading_days_count`                | >= 10          |
| Win rate               | wins / total trades                 | >= 45%         |
| Average R:R            | avg realized R:R from closed trades | >= 1.8         |
| Total P&L              | sum of `realized_pnl`               | > 0            |
| Max single-day loss    | worst day vs daily limit            | < 70% of limit |
| Max drawdown consumed  | peak `drawdownFromPeakPct`          | < 90%          |
| Kill switch triggers   | count of `killSwitchTriggered: true`| 0 in last 5 days|
| Consistency score      | max single day / total profit       | < 25%          |

**Step 5 — Phase 19 Gate assessment:**

Check each criterion:
- [ ] `trading_days_count >= 10`
- [ ] Win rate >= 45%
- [ ] Average R:R >= 1.8
- [ ] Total profit > 0
- [ ] No kill switch trigger in last 5 trading days
- [ ] Max single-day loss < 70% of daily limit
- [ ] Consistency: no day > 25% of total profit

---

## Expected Output Format

```
=== TRU-NEXUS BACKTEST RESULTS ===
Test suite: [PASS / FAIL — N tests, N failed]

Performance Metrics (from data/prop-fund-tracker.json):
  Trading days:      N         [TARGET: >= 10]
  Total trades:      N
  Win rate:          X.X%      [TARGET: >= 45%]
  Average R:R:       X.X       [TARGET: >= 1.8]
  Total P&L:        $X,XXX
  Max daily loss:   $XXX (XX% of limit)  [TARGET: < 70%]
  Max DD consumed:   XX%       [TARGET: < 90%]
  Kill switch fires: N         [TARGET: 0 in last 5 days]
  Consistency score: XX%       [TARGET: < 25%]

Phase 19 Gate Assessment:
  ✓ / ✗  trading_days_count >= 10
  ✓ / ✗  Win rate >= 45%
  ✓ / ✗  Average R:R >= 1.8
  ✓ / ✗  Total profit > 0
  ✓ / ✗  No kill switch in last 5 days
  ✓ / ✗  Max daily loss < 70% of limit
  ✓ / ✗  Consistency < 25%

PHASE 19 STATUS: READY / NOT READY
Missing criteria: [list unmet items if NOT READY]
```
