#!/usr/bin/env bash
# .claude/hooks/stop-loss-enforcer.sh
#
# PostToolUse hook — fires after Write or Edit on files in src/engine/ or
# src/strategy/. Checks that new order-placement functions include stop_loss
# and that kill-switch guards are present.
#
# IMPORTANT EXCLUSIONS:
#   closePosition, closeAllPositions, modifyPosition — these are kill-switch
#   and flatten operations that use market orders. They do NOT take a stop_loss
#   parameter. Checking them for stop_loss would produce constant false-positive
#   warnings when editing kill-switch.ts.
#
# Claude Code hook protocol:
#   exit 0 : allow silently
#   exit 1 : allow but show stdout as warning to Claude
#   exit 2 : block (not used here — pattern matching has edge cases)

set -euo pipefail

PAYLOAD=$(cat)

FILE_PATH=$(echo "$PAYLOAD" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    inp = data.get('tool_input', {})
    path = inp.get('file_path') or inp.get('path') or ''
    print(path)
except Exception:
    print('')
" 2>/dev/null || echo "")

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Only run on engine and strategy TypeScript files
case "$FILE_PATH" in
  */src/engine/*.ts|*/src/strategy/*.ts)
    ;;
  *)
    exit 0
    ;;
esac

if [[ ! -f "$FILE_PATH" ]]; then
  exit 0
fi

WARNINGS=()

# ─── Check 1: Order-placement functions without stop_loss reference ───────────
#
# Scan for functions that place NEW orders. Explicitly exclude close/flatten
# operations (closePosition, closeAllPositions, modifyPosition) because those
# are kill-switch operations that use market orders — no stop_loss required.
#
# Functions checked: placeOrder, submitOrder, openPosition, openTrade,
#                    createOrder, buildOrder
# Functions excluded: closePosition, closeAllPositions, modifyPosition

ORDER_FUNCTIONS=$(grep -nP \
  '(?<!close)(placeOrder|submitOrder|openPosition|openTrade|createOrder|buildOrder)\s*[\(\{]' \
  "$FILE_PATH" 2>/dev/null || true)

if [[ -n "$ORDER_FUNCTIONS" ]]; then
  if ! grep -qP 'stop_loss' "$FILE_PATH" 2>/dev/null; then
    WARNINGS+=("File contains order-placement calls but no 'stop_loss' reference found.")
    WARNINGS+=("Every new OrderRequest requires a non-zero stop_loss (CLAUDE.md RULE-2).")
    WARNINGS+=("Affected lines:")
    while IFS= read -r line; do
      WARNINGS+=("  $line")
    done <<< "$ORDER_FUNCTIONS"
  fi
fi

# ─── Check 2: OrderRequest-like objects missing stop_loss field ───────────────
#
# Looks for objects with 'instrument:' (likely an OrderRequest) that also have
# 'lots:' or 'side:' but no 'stop_loss:'. Position snapshots typically don't
# have 'lots:' so this narrows the false-positive surface.

INSTRUMENT_COUNT=$(grep -cP 'instrument\s*:' "$FILE_PATH" 2>/dev/null || echo 0)
LOTS_COUNT=$(grep -cP '\blots\s*:' "$FILE_PATH" 2>/dev/null || echo 0)
SL_COUNT=$(grep -cP 'stop_loss\s*:' "$FILE_PATH" 2>/dev/null || echo 0)

if [[ "$INSTRUMENT_COUNT" -gt 0 && "$LOTS_COUNT" -gt 0 && "$SL_COUNT" -eq 0 ]]; then
  WARNINGS+=("File has ${INSTRUMENT_COUNT} 'instrument:' and ${LOTS_COUNT} 'lots:' field(s) but zero 'stop_loss:' fields.")
  WARNINGS+=("If these are OrderRequest objects, stop_loss is required (RULE-2).")
fi

# ─── Check 3: placeOrder calls without kill switch guard ─────────────────────
#
# Any NEW order placement (placeOrder / adapter.place) must check
# killSwitch.isInLockout() before submitting. If placeOrder is called but
# isInLockout() is never checked in this file, warn.
#
# Note: closeAllPositions and closePosition are called BY the kill switch —
# they must NOT be blocked by isInLockout() and are excluded here.

ORDER_CALL=$(grep -nP '(?<!close)(placeOrder|adapter\.place)\b' "$FILE_PATH" 2>/dev/null || true)
KILL_CHECK=$(grep -nP 'isInLockout\(\)' "$FILE_PATH" 2>/dev/null || true)

if [[ -n "$ORDER_CALL" && -z "$KILL_CHECK" ]]; then
  WARNINGS+=("File calls order placement but does not check killSwitch.isInLockout().")
  WARNINGS+=("All new order paths must guard against a triggered kill switch (RULE-1).")
  WARNINGS+=("Affected order calls:")
  while IFS= read -r line; do
    WARNINGS+=("  $line")
  done <<< "$ORDER_CALL"
fi

# ─── Output ───────────────────────────────────────────────────────────────────

if [[ ${#WARNINGS[@]} -gt 0 ]]; then
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  STOP-LOSS ENFORCER: Potential safety gap detected           ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  echo "File: ${FILE_PATH}"
  echo ""
  for w in "${WARNINGS[@]}"; do
    echo "  ⚠  $w"
  done
  echo ""
  echo "See CLAUDE.md RULE-1 (kill switch) and RULE-2 (stop loss required)."
  echo "Note: closePosition/closeAllPositions are exempt — they are flatten ops."
  exit 1  # Warn but do not block — pattern matching has edge cases
fi

exit 0
