# Execution Rules — TRU-NEXUS

Reference files: `src/adapters/paper-trader.ts`, `src/adapters/mt5-adapter.ts`,
`src/engine/types.ts` (TradingAdapter interface), `src/engine/session-manager.ts`

---

## Trading Mode Gate (CRITICAL)

Every order path must verify `TRADING_MODE` before touching a live adapter.

```typescript
const mode = process.env.TRADING_MODE as 'paper' | 'live';
if (mode !== 'live') {
  // Use PaperTradingAdapter — no exceptions
}
```

There is no flag, UI override, or runtime switch that bypasses this. The mode is
set at process startup from `.env`. Changing it requires restarting the process.

---

## TradingAdapter Interface

All adapters implement `TradingAdapter` from `src/engine/types.ts`.

| Method                              | Blocking conditions                       |
|-------------------------------------|-------------------------------------------|
| `placeOrder(order)`                 | Kill switch triggered; paper mode if not live |
| `closePosition(positionId)`         | None — always allowed (used by kill switch) |
| `closeAllPositions()`               | None — kill switch uses this directly      |
| `modifyPosition(id, sl?, tp?)`      | Kill switch triggered                     |

`placeOrder()` must validate:
- `order.stop_loss !== 0`
- `order.stop_loss !== order.price`

If either fails, reject and log at ERROR level — do not throw, as a thrown error
in the kill switch path could leave positions open.

---

## OrderRequest Requirements

Every `OrderRequest` submitted to an adapter must contain:

```typescript
{
  instrument: string,      // e.g., 'EURUSD', 'XAUUSD'
  side: 'buy' | 'sell',
  type: 'market' | 'limit' | 'stop',
  lots: number,            // >= 0.01, computed by PositionSizer
  stop_loss: number,       // != 0, != entry price, correct side of trade
  take_profit?: number,    // Optional but recommended (ATR × 2.5 default)
  signal_id?: string       // Reference to originating TradeSignal.id
}
```

---

## PaperTradingAdapter Behavior

Source: `src/adapters/paper-trader.ts`

- Spread simulation: 1.5 pips (`spread = 0.00015` for non-JPY pairs)
- Fill price for buy orders: `ask = midPrice + spread/2`
- Fill price for sell orders: `bid = midPrice − spread/2`
- P&L is updated in memory — no external calls
- `isConnected()` returns `this.connected` (set true on `connect()`)
- Price callbacks registered via `onPriceUpdate()` are stored in `_priceCallbacks`
  map — always call `connect()` before registering callbacks

---

## MT5 Adapter

Source: `src/adapters/mt5-adapter.ts`

Required environment variables:
```
MT5_REST_URL=http://localhost:5050   # No trailing slash
MT5_REST_KEY=                        # Optional — empty = no auth
MT5_SYMBOL_SUFFIX=                   # e.g., 'm' for EURUSDm brokers
```

REST bridge endpoints (bridge must be running before adapter connects):
```
GET  /account                          → { balance, equity, margin_free }
GET  /positions                        → BridgePosition[]
POST /order                            → BridgePosition
POST /close/:ticket                    → BridgeClosedTrade
POST /close-all                        → BridgeClosedTrade[]
GET  /price/:symbol                    → { bid, ask }
GET  /candles/:symbol/:timeframe/:n    → Candle[]
```

The `MT5_SYMBOL_SUFFIX` must be appended in `placeOrder()`, `getPrice()`, AND
`getCandles()` — not just one of them. Missing it in any one method causes
"symbol not found" errors for that specific call.

Ticket-to-position-id mapping: bridge returns `ticket` (integer), adapter maps
to `mt5_<ticket>`. Clear this map when `closeAllPositions()` runs.

---

## Race Condition Prevention

**Problem:** Two concurrent signal evaluations may both pass all risk checks if
they read the same stale `openPositions` snapshot. Both submit orders before
either position's unrealized P&L is reflected in the daily monitor. Combined risk
may exceed the daily limit.

**Required pattern — serialization lock:**
```typescript
// Acquire a position lock before evaluating any signal
const lockAcquired = await positionLock.acquire();
if (!lockAcquired) return; // Another evaluation is in progress
try {
  const positions = await adapter.getOpenPositions(); // Fresh from broker
  const dailyState = dailyLossMonitor.update(positions);
  if (!dailyState.can_open_new) return;
  // ... size and place order
} finally {
  positionLock.release();
}
```

Do not evaluate signals in parallel coroutines without a serialization lock.
If a lock is absent, flag as CRITICAL in any code review.

---

## Slippage Handling

Worst-case slippage assumption: **2 × ATR-14** beyond the stop price.
`PositionSizer` already accounts for this in the worst-case check.

For live MT5 orders, use `ORDER_FILLING_IOC` or equivalent broker filling mode.
Do not use `ORDER_FILLING_FOK` on forex pairs — partial fills are preferable to
full rejection during fast markets.

---

## Session Lifecycle

Source: `src/engine/session-manager.ts`

Market sessions (UTC):
| Session  | Open  | Close |
|----------|-------|-------|
| Asian    | 00:00 | 09:00 |
| London   | 07:00 | 16:00 |
| New York | 13:00 | 22:00 |

**News blackout** — enforced by `SessionManager`. The window is
`news_blackout_mins` before and after each high-impact event. During blackout:
- No new orders
- Existing positions are held unless kill switch fires

**Weekend holding** depends on `profile.weekend_holding`:
- `false` (Apex, TopStep): flatten before Friday 22:00 UTC
- `true` (FTMO, FT+): positions may be carried over the weekend

`SessionManager` emits `SESSION_BLACKOUT` on the event bus when entering a
blackout window. Subscribe to this in the order routing layer.

---

## Error Recovery

If `closeAllPositions()` throws during kill switch execution:
1. Log `'Kill switch flatten FAILED — MANUAL INTERVENTION REQUIRED'` at ERROR
2. Set `isTriggered = true` anyway — this blocks all new orders
3. Do NOT retry automatically — retries may interact badly with partial fills
4. Emit `LOCKOUT_ACTIVATED` on the event bus (dashboard will show alert)

Manual intervention checklist:
- Log into broker platform directly
- Confirm all positions are closed
- Call `killSwitch.reset('manual intervention — positions verified flat')`
- Restart the process if the adapter connection is in an unknown state

---

## Adding a New Adapter

1. Create `src/adapters/<platform>-adapter.ts`
2. Implement all methods of `TradingAdapter` from `src/engine/types.ts`
3. The `name` and `platform` readonly properties must match the firm profile's
   `platform` field
4. Apply `MT5_SYMBOL_SUFFIX` equivalent for any broker-specific symbol formatting
5. Add an entry in `src/accounts/account-manager.ts` to select the adapter by
   firm `platform` field
6. Write tests in `tests/` — mock the HTTP layer, not the adapter itself
7. Test paper mode → live mode gate explicitly in your tests
