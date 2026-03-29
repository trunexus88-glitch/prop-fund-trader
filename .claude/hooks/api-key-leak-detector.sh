#!/usr/bin/env bash
# .claude/hooks/api-key-leak-detector.sh
#
# PostToolUse hook — fires after Write, Edit, or MultiEdit tool calls.
# Scans the modified file for hardcoded secrets.
#
# Claude Code hook protocol:
#   stdin  : JSON with { tool_name, tool_input, tool_response }
#   stdout : optional message shown to Claude if exit != 0
#   exit 0 : allow
#   exit 2 : block + show stdout as error message

set -euo pipefail

PAYLOAD=$(cat)

# Extract the file path from the tool input
# Handles Edit (file_path), Write (file_path), MultiEdit (file_path)
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

# Skip files that are legitimately allowed to contain placeholder patterns
case "$FILE_PATH" in
  *.md|*.txt|*.example|*.env.example)
    exit 0
    ;;
  *CLAUDE.md|*/CLAUDE.md)
    exit 0
    ;;
esac

# Only scan TypeScript, JavaScript, JSON, and .env files
case "$FILE_PATH" in
  *.ts|*.js|*.json|*.env)
    ;;  # fall through to scan
  *)
    exit 0
    ;;
esac

if [[ ! -f "$FILE_PATH" ]]; then
  exit 0
fi

FOUND_SECRETS=0
MESSAGES=()

# ─── Pattern: Anthropic API keys (sk-ant-...) ────────────────────────────────
if grep -qP 'sk-ant-[A-Za-z0-9_-]{20,}' "$FILE_PATH" 2>/dev/null; then
  FOUND_SECRETS=1
  MESSAGES+=("ANTHROPIC API KEY detected (sk-ant-...)")
fi

# ─── Pattern: OpenAI / sk-proj keys ─────────────────────────────────────────
if grep -qP 'sk-proj-[A-Za-z0-9_-]{20,}' "$FILE_PATH" 2>/dev/null; then
  FOUND_SECRETS=1
  MESSAGES+=("OPENAI/SK-PROJ API KEY detected (sk-proj-...)")
fi

# ─── Pattern: Hardcoded API_KEY with actual value ────────────────────────────
# Matches API_KEY="actual_value" but not API_KEY="${VAR}" or API_KEY="your_key"
if grep -P '(?i)API_KEY\s*[=:]\s*["\x27][A-Za-z0-9_\-]{16,}["\x27]' "$FILE_PATH" 2>/dev/null | \
   grep -qvP '(?i)(your_|replace|example|placeholder|change.me|<|>|\$\{)'; then
  FOUND_SECRETS=1
  MESSAGES+=("Hardcoded API_KEY value detected (use process.env.API_KEY instead)")
fi

# ─── Pattern: Hardcoded SECRET or SECRET_KEY ────────────────────────────────
if grep -P '(?i)(SECRET|SECRET_KEY)\s*[=:]\s*["\x27][A-Za-z0-9_\-]{16,}["\x27]' "$FILE_PATH" 2>/dev/null | \
   grep -qvP '(?i)(your_|replace|example|placeholder|change.me|<|>|\$\{)'; then
  FOUND_SECRETS=1
  MESSAGES+=("Hardcoded SECRET value detected (use process.env.VARIABLE instead)")
fi

# ─── Pattern: Hardcoded PASSWORD (skip test files) ──────────────────────────
case "$FILE_PATH" in
  */tests/*|*/test/*|*spec*|*fixture*)
    ;;  # Allow test fixtures
  *)
    if grep -P '(?i)PASSWORD\s*[=:]\s*["\x27][A-Za-z0-9_\-!@#$%]{8,}["\x27]' "$FILE_PATH" 2>/dev/null | \
       grep -qvP '(?i)(your_|replace|example|placeholder|change.me|test_|mock_|<|>|\$\{)'; then
      FOUND_SECRETS=1
      MESSAGES+=("Hardcoded PASSWORD value detected")
    fi
    ;;
esac

# ─── Pattern: MT5 REST key hardcoded in source ──────────────────────────────
if grep -qP 'MT5_REST_KEY\s*=\s*["\x27][A-Za-z0-9_\-]{8,}["\x27]' "$FILE_PATH" 2>/dev/null; then
  FOUND_SECRETS=1
  MESSAGES+=("Hardcoded MT5_REST_KEY value in source (use process.env.MT5_REST_KEY)")
fi

# ─── Pattern: DASHBOARD_SECRET with real value ──────────────────────────────
if grep -P '(?i)DASHBOARD_SECRET\s*[=:]\s*["\x27][A-Za-z0-9_\-]{8,}["\x27]' "$FILE_PATH" 2>/dev/null | \
   grep -qvP '(?i)(change.me|your_|replace|placeholder)'; then
  FOUND_SECRETS=1
  MESSAGES+=("Hardcoded DASHBOARD_SECRET value detected")
fi

# ─── Output ───────────────────────────────────────────────────────────────────

if [[ $FOUND_SECRETS -eq 1 ]]; then
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  SECURITY BLOCK: Hardcoded secret detected                  ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  echo "File: ${FILE_PATH}"
  echo ""
  for msg in "${MESSAGES[@]}"; do
    echo "  ✗ $msg"
  done
  echo ""
  echo "Fix: Move all secrets to .env and reference via process.env.VARIABLE_NAME"
  echo "     Ensure .env is in .gitignore (never committed to git)"
  echo "     Use .env.example with placeholder values for documentation"
  exit 2
fi

exit 0
