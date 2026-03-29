---
name: paper-trade
description: Validate environment configuration, start paper trading mode, and confirm dashboard is live
---

# /paper-trade — Start Paper Trading

## What This Does

Validates that the environment is correctly configured for paper mode, launches
the paper trading process, and confirms the dashboard is broadcasting on port 3456.

---

## Execution Steps

**Step 1 — Check TRADING_MODE in .env:**
```bash
grep TRADING_MODE .env 2>/dev/null || echo "TRADING_MODE not set — will default to paper"
```

- If `TRADING_MODE=live` → **STOP**. Output: "Cannot start paper trade — TRADING_MODE is set to live. Change to 'paper' or remove the line to use default."
- If `TRADING_MODE=paper` or absent → proceed

**Step 2 — Check for existing process:**
```bash
pgrep -f "tsx src/index.ts" 2>/dev/null && echo "WARNING: existing process running" || echo "No existing process"
```

If an existing process is running, warn before starting a new one — they share
the same tracker file and dashboard port.

**Step 3 — Review current tracker state:**
```bash
cat data/prop-fund-tracker.json 2>/dev/null || echo "No tracker file — will be created on first run"
```

**Step 4 — Start paper trading:**
```bash
npm run paper
```

**Step 5 — In a separate terminal, confirm dashboard is live:**
```bash
curl -s http://localhost:3456/api/status 2>/dev/null || echo "Dashboard not yet responding — wait 5s"
```

**Step 6 — Monitor startup logs for initialization confirmation.**

Expected log lines (should appear within 10 seconds of start):
- `Kill switch initialized and armed`
- `Position sizer initialized`
- `Daily loss monitor initialized`
- `Drawdown monitor initialized`
- `Paper trading adapter initialized`

If any of these are missing, check for startup errors in the log output.

---

## Expected Status Report

```
Paper trading: [RUNNING / FAILED]
Dashboard:     http://localhost:3456  [UP / DOWN]
Kill switch:   [ARMED]
Trading mode:  PAPER (confirmed)
Tracker file:  data/prop-fund-tracker.json [EXISTS / WILL BE CREATED]
```

---

## Safety Notes

- If `TRADING_MODE` is absent from `.env`, paper mode is the **default behavior**.
  This is intentional — the system fails safe to paper, never live.
- Do not run `npm run paper` and `npm run dev` simultaneously — they share port 3456
  and `data/prop-fund-tracker.json`.
- The dashboard at `http://localhost:3456` shows live P&L, drawdown gauges, and
  kill switch state. Keep it open during any paper session.
- The kill switch armed state is confirmed by looking for `"isArmed": true` in the
  dashboard's `/api/status` response.
