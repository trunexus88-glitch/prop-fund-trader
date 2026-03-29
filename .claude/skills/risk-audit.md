---
name: risk-audit
description: Full 8-rule compliance check on current branch — invokes RiskManager agent and issues GO/NO-GO
---

# /risk-audit — Full Risk Compliance Audit

## What This Does

Invokes the RiskManager agent to audit all engine and strategy files for compliance
with the 8 IMMUTABLE safety rules from `CLAUDE.md`. Issues a GO / NO-GO
recommendation for the current branch state.

---

## Execution Steps

**Step 1 — Identify changed files:**
```bash
git diff --name-only HEAD 2>/dev/null || git ls-files src/engine/ src/strategy/
```

**Step 2 — For each changed file in `src/engine/` or `src/strategy/`, apply
the RiskManager interrogation protocol from `.claude/agents/risk-manager.md`.**

**Step 3 — Run grep checks for each of the 8 IMMUTABLE rules:**

**RULE-1 (Kill switch bypass):**
```bash
grep -rn "isInLockout\(\)" src/ --include="*.ts"
grep -rn "placeOrder\|adapter\.place" src/ --include="*.ts" | grep -v "close"
```
Verify every `placeOrder` call site has a preceding `isInLockout()` check.
`closePosition`/`closeAllPositions` are exempt.

**RULE-2 (Stop loss required):**
```bash
grep -rn "stop_loss" src/ --include="*.ts"
grep -rn "OrderRequest" src/ --include="*.ts"
```
Verify no `OrderRequest` construction omits `stop_loss`.

**RULE-3 (PositionSizer required):**
```bash
grep -rn "\.calculate(" src/engine/position-sizer.ts
grep -rn "\blots\s*:" src/ --include="*.ts" | grep -v "position-sizer\|types\|test\|node_modules"
```
Flag any hardcoded `lots:` value outside position-sizer and test files.

**RULE-4 (Paper mode gate):**
```bash
grep -rn "TRADING_MODE" src/ --include="*.ts"
grep -rn "placeOrder" src/ --include="*.ts"
```
Verify every `placeOrder` path checks `TRADING_MODE`.

**RULE-5 (Monitor source of truth):**
```bash
grep -rn "drawdownMonitor\|dailyLossMonitor" src/ --include="*.ts"
```
Flag any manual drawdown percentage calculation outside the monitor files.

**RULE-6 (One-shot emission flags):**
```bash
grep -n "hasEmittedWarning\|hasEmittedCritical\|hasEmittedBreach" \
  src/engine/drawdown-monitor.ts src/engine/daily-loss-monitor.ts
```
All six flags must be present (3 in each file). Alert if any are missing.

**RULE-7 (No inline thresholds):**
```bash
grep -rn "0\.10\|0\.05\|0\.06\|0\.02\|0\.04\|0\.005\|0\.001" \
  src/engine/ src/strategy/ --include="*.ts" \
  | grep -v "comment\|test\|sizer\|types\|indicators\|atr\|ema"
```
Flag hardcoded drawdown/daily-loss percentages that should come from firm profile JSON.

**RULE-8 (No secrets in source):**
```bash
grep -rn "sk-ant-\|sk-proj-\|API_KEY=\|SECRET=" src/ --include="*.ts"
```
Any match here is a critical violation.

**Step 4 — Check Phase 19 gate metrics:**
```bash
cat data/prop-fund-tracker.json 2>/dev/null | python3 -m json.tool | head -50
```
Assess against Phase 19 quantitative criteria.

**Step 5 — Issue final report:**

---

## Output Format

```
=== TRU-NEXUS RISK AUDIT ===
Branch: [git branch name]
Date:   [date]

RULE COMPLIANCE:
  RULE-1 Kill switch bypass:       [PASS / FAIL]
  RULE-2 Stop loss required:       [PASS / FAIL]
  RULE-3 PositionSizer required:   [PASS / FAIL]
  RULE-4 Paper mode gate:          [PASS / FAIL]
  RULE-5 Monitor source of truth:  [PASS / FAIL]
  RULE-6 One-shot emission flags:  [PASS / FAIL]
  RULE-7 No inline thresholds:     [PASS / FAIL]
  RULE-8 No secrets in source:     [PASS / FAIL]

PHASE 19 GATE:
  ✓ / ✗  trading_days_count >= 10
  ✓ / ✗  Win rate >= 45%
  ✓ / ✗  Average R:R >= 1.8
  ✓ / ✗  Total profit > 0
  ✓ / ✗  No kill switch in last 5 days
  ✓ / ✗  Max daily loss < 70% of limit
  ✓ / ✗  Consistency < 25%

OPEN ISSUES:
  [file:line — description — severity: CRITICAL | HIGH | MEDIUM]

FINAL RECOMMENDATION: GO | NO-GO | CONDITIONAL GO
Conditions for GO: [if conditional — exact changes required]
```
