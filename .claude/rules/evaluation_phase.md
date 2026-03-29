# Evaluation Phase Rules — TRU-NEXUS

Reference files: `src/engine/prop-fund-rules.ts`,
`src/engine/consistency-enforcer.ts`, `src/engine/session-manager.ts`,
`src/firms/profiles/*.json`

---

## Phase Definitions

| Phase      | Capital at risk | Risk cap per trade | Primary concern            |
|------------|----------------|-------------------|----------------------------|
| Evaluation | Eval fee only  | 0.5% (eval cap)   | Staying within rules       |
| Funded     | Firm's capital | 1.0% (funded cap) | Growing account cleanly    |
| Live (Ph19)| Real capital   | Same as funded    | Execution quality, latency |

The `PositionSizer` uses `request.is_funded: boolean` to select the correct cap.
During evaluation, always pass `is_funded: false`.

---

## Evaluation-Phase Position Sizing

- Max risk: **0.5%** of initial balance per trade (not 1%)
- Trailing drawdown accounts (FT+): max risk **0.3%** regardless of phase
- Confidence multiplier still applies: a 50-confidence signal gets half the cap
- **Never increase lot size to "catch up" toward the profit target** — evaluation
  accounts fail on rule breaches, not on being too conservative

---

## Consistency Rule Enforcement

Source: `src/engine/consistency-enforcer.ts`

Applies to firms with `consistency_rule_pct` set (currently FT+ $25k = 30%).

```
todays_profit / total_challenge_profit <= consistency_rule_pct
```

| Consumed % of consistency limit | Action                             |
|---------------------------------|------------------------------------|
| < 70%                           | Normal sizing                      |
| 70–99%                          | Position size multiplier → 0.5     |
| >= 100% (limit hit)             | Position size multiplier → 0.25    |

The FT+ 30% rule: if total profit = $800, and you make $200 today (25%), you are
approaching the limit. At $240 (30%), you hit it.

**Internal target:** Never let a single day exceed 25% of total profit in any
account, even for firms with no formal consistency rule. This protects against
post-hoc enforcement by firms.

---

## News Blackout Windows

| Firm         | Blackout minutes | Notes                         |
|--------------|-----------------|-------------------------------|
| Apex $50k    | 0               | No restriction                |
| FTMO $100k   | 2 min before/after | NFP, FOMC, CPI, etc.       |
| TopStep $50k | 5 min before/after |                             |
| FT+ $25k     | 2 min before/after |                             |

During news blackout, `SessionManager.isSessionAllowed()` returns `false`.
Do not override this for "high-confidence" signals — news black swans are
precisely when the rule matters most.

---

## Minimum Trading Days

| Firm         | Min days | Notes                              |
|--------------|----------|------------------------------------|
| Apex $50k    | 7        | 7 separate trading days minimum    |
| FTMO $100k   | 4        | Very low minimum — do not rush     |
| TopStep $50k | 5        |                                    |
| FT+ $25k     | 1        | No minimum — still pace yourself   |

A "trading day" is a calendar day where at least one trade was opened AND closed.
Days where only the kill switch closed positions are loss days, not trading days.

---

## Profit Targets and Splits

| Firm         | Target | Basis          | Fee    | Split  |
|--------------|--------|----------------|--------|--------|
| Apex $50k    | 6%     | initial balance| ~$35   | 100%   |
| FTMO $100k   | 10%    | initial balance| ~$540  | 80%    |
| TopStep $50k | 6%     | initial balance| ~$49   | 90%    |
| FT+ $25k     | 8%     | initial balance| ~$99   | 80%    |

Do not try to "bank" the profit target in the final days with large positions.
Standard sizing throughout — the path matters, not just the destination.

---

## Weekend Position Rules

| Firm         | `weekend_holding` | Action required             |
|--------------|-------------------|-----------------------------|
| Apex $50k    | false             | Flatten before Fri 22:00 UTC|
| FTMO $100k   | true              | No action required          |
| TopStep $50k | false             | Flatten before Fri 22:00 UTC|
| FT+ $25k     | true              | No action required          |

`SessionManager` tracks this via `profile.weekend_holding` and emits
`SESSION_BLACKOUT` with reason `'weekend_close_required'` for non-holding firms.

---

## Minimum Hold Time

| Firm         | Min hold    | Purpose              |
|--------------|-------------|----------------------|
| Apex $50k    | 30 seconds  | Anti-HFT filter      |
| FTMO $100k   | 120 seconds | Anti-scalping filter |
| TopStep $50k | 30 seconds  |                      |
| FT+ $25k     | 60 seconds  |                      |

Do not close a position within `min_hold_time_seconds` of opening it, even if
stop loss is hit in that window. The firm will flag sub-minimum-hold trades.

---

## Phase 19 Go-Live Gate

All conditions must be simultaneously true before switching `TRADING_MODE=live`:

**Quantitative Gate (from `data/prop-fund-tracker.json`):**
- [ ] `trading_days_count >= 10`
- [ ] Win rate of all paper trades >= 45%
- [ ] Average realized R:R >= 1.8
- [ ] Total paper profit > 0
- [ ] No kill switch trigger in last 5 trading days
- [ ] Maximum single-day loss < 70% of daily limit across all days
- [ ] Consistency score: no day > 25% of total profit

**Operational Gate:**
- [ ] `.env` has `MT5_REST_URL` and `MT5_REST_KEY` populated
- [ ] MT5 bridge confirmed running at `MT5_REST_URL`
- [ ] `TRADING_MODE=live` set in `.env`

**Do not proceed to Phase 19 if any of the above is unchecked.**

---

## Evaluation Failure Post-Mortem Protocol

If an evaluation account is failed (drawdown breached or daily limit hit):

1. Record the `trigger_reason` from `KillSwitchState`
2. Check `data/prop-fund-tracker.json` for the losing trade sequence
3. Identify which of the four sizing constraints was bypassed or miscalculated
4. Do NOT immediately re-register for the same firm — diagnose first
5. Paper trade for a minimum of 3 more days with the corrected logic
6. Re-evaluate fee ROI: if a firm has failed twice, review signal quality
   before reinvesting the fee
7. Check whether the macro regime classifier flagged the session as high-risk —
   if it did and a trade was taken anyway, that is a signal filter bug

---

## Compounding Protocol (Post Phase 19)

From `src/engine/types.ts → CompoundingState`:
- 60% of gross payouts → `reinvestment_pool` (new evaluations)
- 40% of gross payouts → `personal_income`
- `safety_reserve` must remain funded at all times (target: 3 months of eval fees)

**Scaling rules:**
- Do not expand to a new firm evaluation while the `safety_reserve` is below target
- Do not run more concurrent evaluations than the reinvestment pool can cover
  without touching personal income
- Phase 21 ($150k funded capital) requires successful Phase 19 completion AND
  at least 2 funded accounts generating consistent payouts first
- Never approve a scaling plan that bypasses the safety reserve requirement,
  regardless of how promising a new firm appears
