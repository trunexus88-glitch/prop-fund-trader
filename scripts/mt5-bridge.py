#!/usr/bin/env python3
"""
TRU-NEXUS MT5 REST Bridge
══════════════════════════════════════════════════════════════════════════════
A minimal Flask server that wraps the MetaTrader5 Python library and exposes
the REST API that the MT5Adapter (src/adapters/mt5-adapter.ts) expects.

SETUP
─────
1. Install MetaTrader 5 terminal on Windows (required — MetaTrader5 Python
   library only works on Windows with the terminal installed and logged in).
2. pip install MetaTrader5 flask
3. Copy this file to any directory on the same Windows machine.
4. Set your .env (or export) the magic number if you changed it in mt5-adapter.ts
5. Run: python mt5-bridge.py

The server listens on 0.0.0.0:5050 by default.
Set PORT and API_KEY environment variables to override.

ENDPOINTS (matching MT5Adapter expectations)
────────────────────────────────────────────
GET  /account
GET  /positions
POST /order            { symbol, side, lots, sl, tp, magic, comment }
POST /close/<ticket>
POST /close-all        { magic }
POST /modify/<ticket>  { sl?, tp? }
GET  /price/<symbol>
GET  /candles/<symbol>/<timeframe>/<count>
"""

import os
import sys
from datetime import datetime, timezone

try:
    import MetaTrader5 as mt5
except ImportError:
    print("ERROR: MetaTrader5 package not found.")
    print("  pip install MetaTrader5")
    sys.exit(1)

try:
    from flask import Flask, jsonify, request, abort
except ImportError:
    print("ERROR: Flask not found.")
    print("  pip install flask")
    sys.exit(1)

app = Flask(__name__)
API_KEY = os.environ.get("API_KEY", "")
PORT    = int(os.environ.get("PORT", 5050))
MAGIC   = int(os.environ.get("MAGIC", 20260101))

# ── MT5 timeframe map ────────────────────────────────────────────────────────
TF_MAP = {
    "M1":  mt5.TIMEFRAME_M1,  "M3":  mt5.TIMEFRAME_M3,
    "M5":  mt5.TIMEFRAME_M5,  "M15": mt5.TIMEFRAME_M15,
    "M30": mt5.TIMEFRAME_M30, "H1":  mt5.TIMEFRAME_H1,
    "H2":  mt5.TIMEFRAME_H2,  "H4":  mt5.TIMEFRAME_H4,
    "H6":  mt5.TIMEFRAME_H6,  "H12": mt5.TIMEFRAME_H12,
    "D1":  mt5.TIMEFRAME_D1,  "W1":  mt5.TIMEFRAME_W1,
    "MN1": mt5.TIMEFRAME_MN1,
}

# ── Auth middleware ──────────────────────────────────────────────────────────
@app.before_request
def check_api_key():
    if API_KEY and request.headers.get("X-API-Key") != API_KEY:
        abort(401)

# ── MT5 init ─────────────────────────────────────────────────────────────────
def ensure_mt5():
    if not mt5.initialize():
        abort(503, description="MT5 terminal not connected")

# ─────────────────────────────────────────────────────────────────────────────

@app.route("/account")
def account():
    ensure_mt5()
    info = mt5.account_info()
    if info is None:
        abort(503, description="Cannot get account info")
    return jsonify({
        "balance":     info.balance,
        "equity":      info.equity,
        "margin_free": info.margin_free,
    })


@app.route("/positions")
def positions():
    ensure_mt5()
    raw = mt5.positions_get(group="*")
    result = []
    for p in (raw or []):
        result.append({
            "ticket":        p.ticket,
            "symbol":        p.symbol,
            "type":          "buy" if p.type == mt5.ORDER_TYPE_BUY else "sell",
            "lots":          p.volume,
            "open_price":    p.price_open,
            "sl":            p.sl,
            "tp":            p.tp,
            "profit":        p.profit,
            "open_time_utc": datetime.fromtimestamp(p.time, tz=timezone.utc).isoformat(),
        })
    return jsonify(result)


@app.route("/order", methods=["POST"])
def place_order():
    ensure_mt5()
    data   = request.json or {}
    symbol = data.get("symbol")
    side   = data.get("side")          # "buy" | "sell"
    lots   = float(data.get("lots", 0.01))
    sl     = float(data.get("sl", 0))
    tp     = float(data.get("tp", 0))
    magic  = int(data.get("magic", MAGIC))
    comment = str(data.get("comment", "tru-nexus"))[:31]

    if not symbol or side not in ("buy", "sell"):
        abort(400, description="symbol and side (buy|sell) required")

    action    = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL
    price_raw = mt5.symbol_info_tick(symbol)
    if price_raw is None:
        abort(404, description=f"Symbol {symbol} not found or market closed")

    price = price_raw.ask if side == "buy" else price_raw.bid

    request_dict = {
        "action":       mt5.TRADE_ACTION_DEAL,
        "symbol":       symbol,
        "volume":       lots,
        "type":         action,
        "price":        price,
        "sl":           sl,
        "tp":           tp,
        "deviation":    10,
        "magic":        magic,
        "comment":      comment,
        "type_time":    mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request_dict)
    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        err = result.comment if result else mt5.last_error()
        abort(500, description=f"Order failed: {err}")

    # Fetch the opened position to return
    pos_list = mt5.positions_get(ticket=result.order)
    if not pos_list:
        # Some brokers don't immediately reflect — return synthetic
        return jsonify({
            "ticket":        result.order,
            "symbol":        symbol,
            "type":          side,
            "lots":          lots,
            "open_price":    result.price,
            "sl":            sl,
            "tp":            tp,
            "profit":        0.0,
            "open_time_utc": datetime.now(tz=timezone.utc).isoformat(),
        })

    p = pos_list[0]
    return jsonify({
        "ticket":        p.ticket,
        "symbol":        p.symbol,
        "type":          "buy" if p.type == mt5.ORDER_TYPE_BUY else "sell",
        "lots":          p.volume,
        "open_price":    p.price_open,
        "sl":            p.sl,
        "tp":            p.tp,
        "profit":        p.profit,
        "open_time_utc": datetime.fromtimestamp(p.time, tz=timezone.utc).isoformat(),
    })


@app.route("/close/<int:ticket>", methods=["POST"])
def close_position(ticket):
    ensure_mt5()
    pos_list = mt5.positions_get(ticket=ticket)
    if not pos_list:
        abort(404, description=f"Position {ticket} not found")

    p       = pos_list[0]
    price_raw = mt5.symbol_info_tick(p.symbol)
    if price_raw is None:
        abort(503, description="Cannot get price for close")

    close_price = price_raw.bid if p.type == mt5.ORDER_TYPE_BUY else price_raw.ask
    close_type  = mt5.ORDER_TYPE_SELL if p.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY

    request_dict = {
        "action":       mt5.TRADE_ACTION_DEAL,
        "symbol":       p.symbol,
        "volume":       p.volume,
        "type":         close_type,
        "position":     ticket,
        "price":        close_price,
        "deviation":    10,
        "magic":        p.magic,
        "comment":      "tru-nexus-close",
        "type_time":    mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(request_dict)
    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        err = result.comment if result else mt5.last_error()
        abort(500, description=f"Close failed: {err}")

    now = datetime.now(tz=timezone.utc).isoformat()
    return jsonify({
        "ticket":        ticket,
        "symbol":        p.symbol,
        "type":          "buy" if p.type == mt5.ORDER_TYPE_BUY else "sell",
        "lots":          p.volume,
        "open_price":    p.price_open,
        "close_price":   close_price,
        "sl":            p.sl,
        "tp":            p.tp,
        "profit":        p.profit,
        "open_time_utc": datetime.fromtimestamp(p.time, tz=timezone.utc).isoformat(),
        "close_time_utc": now,
        "reason":        "manual",
    })


@app.route("/close-all", methods=["POST"])
def close_all():
    ensure_mt5()
    data   = request.json or {}
    magic  = int(data.get("magic", MAGIC))
    raw    = mt5.positions_get(group="*")
    closed = []
    for p in (raw or []):
        if magic != 0 and p.magic != magic:
            continue
        try:
            resp = close_position(p.ticket).get_json()
            resp["reason"] = "kill_switch"
            closed.append(resp)
        except Exception as ex:
            app.logger.warning(f"Could not close {p.ticket}: {ex}")
    return jsonify(closed)


@app.route("/modify/<int:ticket>", methods=["POST"])
def modify_position(ticket):
    ensure_mt5()
    data = request.json or {}
    pos_list = mt5.positions_get(ticket=ticket)
    if not pos_list:
        abort(404, description=f"Position {ticket} not found")

    p = pos_list[0]
    sl = float(data.get("sl", p.sl))
    tp = float(data.get("tp", p.tp))

    request_dict = {
        "action":   mt5.TRADE_ACTION_SLTP,
        "symbol":   p.symbol,
        "position": ticket,
        "sl":       sl,
        "tp":       tp,
    }
    result = mt5.order_send(request_dict)
    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        err = result.comment if result else mt5.last_error()
        abort(500, description=f"Modify failed: {err}")

    return jsonify({
        "ticket":        p.ticket,
        "symbol":        p.symbol,
        "type":          "buy" if p.type == mt5.ORDER_TYPE_BUY else "sell",
        "lots":          p.volume,
        "open_price":    p.price_open,
        "sl":            sl,
        "tp":            tp,
        "profit":        p.profit,
        "open_time_utc": datetime.fromtimestamp(p.time, tz=timezone.utc).isoformat(),
    })


@app.route("/price/<symbol>")
def price(symbol):
    ensure_mt5()
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        abort(404, description=f"Symbol {symbol} not found")
    return jsonify({"bid": tick.bid, "ask": tick.ask})


@app.route("/candles/<symbol>/<timeframe>/<int:count>")
def candles(symbol, timeframe, count):
    ensure_mt5()
    tf = TF_MAP.get(timeframe.upper())
    if tf is None:
        abort(400, description=f"Unknown timeframe: {timeframe}")

    rates = mt5.copy_rates_from_pos(symbol, tf, 0, count)
    if rates is None or len(rates) == 0:
        abort(404, description=f"No candle data for {symbol} {timeframe}")

    result = []
    for r in rates:
        result.append({
            "time":        datetime.fromtimestamp(r["time"], tz=timezone.utc).isoformat(),
            "open":        float(r["open"]),
            "high":        float(r["high"]),
            "low":         float(r["low"]),
            "close":       float(r["close"]),
            "tick_volume": int(r["tick_volume"]),
        })
    return jsonify(result)


# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"[TRU-NEXUS MT5 Bridge] Initializing MetaTrader5 connection…")
    if not mt5.initialize():
        print(f"ERROR: Could not connect to MT5 terminal: {mt5.last_error()}")
        print("  Make sure MetaTrader5 terminal is running and logged in.")
        sys.exit(1)

    info = mt5.account_info()
    if info:
        print(f"[TRU-NEXUS MT5 Bridge] Connected — Account #{info.login} | Balance: {info.balance:.2f} {info.currency}")
    else:
        print(f"[TRU-NEXUS MT5 Bridge] Warning: could not read account info")

    print(f"[TRU-NEXUS MT5 Bridge] Listening on http://0.0.0.0:{PORT}")
    if API_KEY:
        print(f"[TRU-NEXUS MT5 Bridge] API key auth enabled")
    else:
        print(f"[TRU-NEXUS MT5 Bridge] WARNING: No API key set — bridge is unauthenticated!")

    app.run(host="0.0.0.0", port=PORT, debug=False)
