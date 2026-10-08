#!/usr/bin/env python3 -u
"""v8 "Trend Ensemble" research backtest.

Strategy (fixed, textbook parameters - NOTHING is optimized):
  score_i  = mean over L in LOOKBACKS of sign(close_t / close_{t-L} - 1)
  long-only: score clipped to [0, 1]
  weight_i = score_i * min(VOL_TARGET / vol30_i, 3) / N_active
  gross    = sum(|w|) capped at GROSS_CAP (pro-rata scale-down)
  rebalance daily at the UTC close, only when |target - held| > BAND * |target|
            (or the target is flat); trades at the next bar's close.

Costs: HL taker 0.045% + 2 bps slippage per unit of turnover (or maker
0.015% when --maker), funding from HL fundingHistory (hourly, 2023-05+)
and 10.95%/yr on longs before that (0.01%/8h baseline).

Data (cached under data/cache/, gitignored):
  - Binance spot daily klines 2020-01 -> today (deep history)
  - Hyperliquid perp daily candles (venue check on the overlap)
  - Hyperliquid hourly funding per coin

Usage:
  python3 research/trend_ensemble_backtest.py            # full report
  python3 research/trend_ensemble_backtest.py --refresh  # re-download data
Output: printed report + data/v8/report.json
"""
import argparse, json, math, os, time, urllib.request
from pathlib import Path
import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parents[1]
CACHE = REPO / "data" / "cache"
UNIVERSE = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "LINK", "AVAX", "ADA", "LTC", "SUI", "NEAR", "HYPE"]
START = "2020-01-01"

# ─── Base parameters (literature defaults, not fitted) ─────────────────────
BASE = dict(
    lookbacks=(14, 28, 56, 112),
    vol_look=30,
    vol_target=0.60,
    gross_cap=1.5,
    band=0.20,
    long_only=True,
    fee=0.00045 + 0.0002,
)
DEFAULT_FUNDING_PER_DAY = 0.0001 * 3  # 0.01% per 8h


# ─── Data ──────────────────────────────────────────────────────────────────
def _get(url, body=None):
    for attempt in range(5):
        try:
            if body is None:
                return json.load(urllib.request.urlopen(url, timeout=30))
            req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
            return json.load(urllib.request.urlopen(req, timeout=30))
        except Exception as e:  # noqa: BLE001
            if attempt == 4:
                raise
            time.sleep(2 + attempt * 3)


def fetch_binance_daily(coin):
    rows, start = [], int(pd.Timestamp(START, tz="UTC").timestamp() * 1000)
    while True:
        k = _get(f"https://data-api.binance.vision/api/v3/klines?symbol={coin}USDT&interval=1d&startTime={start}&limit=1000")
        if not isinstance(k, list) or not k:
            break
        rows += [[r[0], float(r[4]), float(r[7])] for r in k]
        if len(k) < 1000:
            break
        start = k[-1][0] + 1
    return rows


def fetch_hl_daily(coin):
    k = _get("https://api.hyperliquid.xyz/info", {"type": "candleSnapshot", "req": {
        "coin": coin, "interval": "1d", "startTime": 0, "endTime": int(time.time() * 1000)}})
    return [[c["t"], float(c["c"]), float(c["v"]) * float(c["c"])] for c in k]


def fetch_hl_funding(coin):
    out, start = [], 0
    while True:
        f = _get("https://api.hyperliquid.xyz/info", {"type": "fundingHistory", "coin": coin, "startTime": start})
        if not f:
            break
        out += [[x["time"], float(x["fundingRate"])] for x in f]
        if len(f) < 500:
            break
        start = f[-1]["time"] + 1
        time.sleep(0.25)
    return out


def load_data(refresh=False):
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / "raw.json"
    if path.exists() and not refresh:
        raw = json.loads(path.read_text())
    else:
        raw = {"binance": {}, "hl": {}, "funding": {}}
        for c in UNIVERSE:
            print(f"  fetching {c}...", flush=True)
            raw["binance"][c] = fetch_binance_daily(c)
            raw["hl"][c] = fetch_hl_daily(c)
            raw["funding"][c] = fetch_hl_funding(c)
        path.write_text(json.dumps(raw))

    def frame(src):
        cols = {}
        for c, rows in src.items():
            if rows:
                s = pd.Series({pd.Timestamp(r[0], unit="ms").normalize(): r[1] for r in rows})
                cols[c] = s[~s.index.duplicated()]
        return pd.DataFrame(cols).sort_index()

    bn, hlp = frame(raw["binance"]), frame(raw["hl"])
    # Prefer Binance for depth; fill coins/dates Binance lacks with HL.
    px = bn.combine_first(hlp).loc[START:]
    fund = {}
    for c, rows in raw["funding"].items():
        if rows:
            s = pd.Series({pd.Timestamp(t, unit="ms"): r for t, r in rows})
            fund[c] = s.resample("1D").sum()
    fund = pd.DataFrame(fund).reindex(px.index)
    return px, hlp.loc[START:], fund


# ─── Engine ────────────────────────────────────────────────────────────────
def target_weights(px, p):
    rets = px.pct_change()
    score = sum(np.sign(px / px.shift(L) - 1) for L in p["lookbacks"]) / len(p["lookbacks"])
    if p["long_only"]:
        score = score.clip(lower=0)
    vol = rets.rolling(p["vol_look"]).std() * math.sqrt(365)
    raw = score * (p["vol_target"] / vol).clip(upper=3)
    n_active = px.notna().sum(1).clip(lower=1)
    w = raw.div(n_active, axis=0)
    gross = w.abs().sum(1)
    scale = (p["gross_cap"] / gross).clip(upper=1).fillna(0)
    return w.mul(scale, axis=0).fillna(0)


def simulate(px, fund, p, start=None, end=None):
    tgt = target_weights(px, p)
    rets = px.pct_change().fillna(0)
    idx = tgt.loc[start:end].index
    held = pd.Series(0.0, index=px.columns)
    eq, rows = 1.0, []
    for t in idx:
        # PnL over (t-1, t] on weights held going into t.
        r = rets.loc[t]
        f = fund.loc[t].fillna(np.nan) if t in fund.index else pd.Series(np.nan, index=px.columns)
        f = f.where(f.notna(), DEFAULT_FUNDING_PER_DAY)
        pnl = float((held * r).sum() - (held * f).sum())  # longs pay positive funding
        eq *= 1 + pnl
        # Held weights drift with prices until the next rebalance.
        held = held * (1 + r) / (1 + pnl)
        # Rebalance at t's close with the no-trade band.
        want = tgt.loc[t]
        diff = want - held
        need = (diff.abs() > p["band"] * want.abs()) | (want == 0)
        trade = diff.where(need, 0.0)
        turn = float(trade.abs().sum())
        eq *= 1 - turn * p["fee"]
        held = held + trade
        rows.append((t, eq, pnl, turn, float(held.abs().sum())))
    out = pd.DataFrame(rows, columns=["t", "eq", "ret", "turn", "gross"]).set_index("t")
    return out


def stats(res):
    daily = res["eq"].pct_change().fillna(res["eq"].iloc[0] - 1)
    yrs = len(res) / 365
    cagr = res["eq"].iloc[-1] ** (1 / yrs) - 1 if yrs > 0 else 0
    dd = (res["eq"] / res["eq"].cummax() - 1).min()
    sh = daily.mean() / daily.std() * math.sqrt(365) if daily.std() > 0 else 0
    by_year = (1 + daily).groupby(daily.index.year).prod() - 1
    return dict(cagr=cagr, sharpe=sh, maxdd=dd, turn_per_year=res["turn"].sum() / yrs,
                avg_gross=res["gross"].mean(), by_year={int(k): v for k, v in by_year.items()},
                final=res["eq"].iloc[-1])


def line(name, s, extra=""):
    yrs = " ".join(f"{y}:{v*100:+.0f}%" for y, v in s["by_year"].items())
    return (f"{name:42s} CAGR {s['cagr']*100:6.1f}%  Sharpe {s['sharpe']:4.2f}  MaxDD {s['maxdd']*100:6.1f}%  "
            f"gross {s['avg_gross']:.2f}x  turn/yr {s['turn_per_year']:5.1f}  {yrs}{extra}")


# ─── Report ────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()
    px, hlp, fund = load_data(args.refresh)
    print(f"Universe {list(px.columns)}  {px.index[0].date()} -> {px.index[-1].date()}")
    report = {}

    def run(name, p=BASE, data=px, start="2021-01-01", end=None, **kw):
        q = dict(p, **kw)
        s = stats(simulate(data, fund, q, start, end))
        report[name] = s
        print(line(name, s), flush=True)
        return s

    print("\n== Base ==")
    run("v8 base (13 coins)")
    run("v8 base, maker fees", fee=0.00015 + 0.0001)
    run("v8 base, costs x2", fee=BASE["fee"] * 2)
    run("v8 long/short", long_only=False)

    print("\n== Leverage / risk ==")
    for vt, cap in [(0.4, 1.0), (0.6, 1.5), (0.8, 2.0)]:
        run(f"vol_target {vt} cap {cap}", vol_target=vt, gross_cap=cap)

    print("\n== Robustness: lookbacks x0.5 / x1.5, band, vol window ==")
    run("lookbacks x0.5", lookbacks=tuple(max(2, L // 2) for L in BASE["lookbacks"]))
    run("lookbacks x1.5", lookbacks=tuple(int(L * 1.5) for L in BASE["lookbacks"]))
    for b in (0.0, 0.1, 0.3):
        run(f"band {b}", band=b)
    run("vol window 60", vol_look=60)

    print("\n== Universe: leave-one-out (hindsight check) ==")
    for c in ["BTC", "ETH", "SOL", "HYPE", "BNB"]:
        run(f"without {c}", data=px.drop(columns=[c]))
    run("majors only BTC/ETH/SOL", data=px[["BTC", "ETH", "SOL"]])
    run("bot coins ETH/SOL/BNB", data=px[["ETH", "SOL", "BNB"]])

    print("\n== Sub-periods ==")
    run("2021-2022", start="2021-01-01", end="2022-12-31")
    run("2023-2024", start="2023-01-01", end="2024-12-31")
    run("2025-2026 YTD", start="2025-01-01")
    run("live window 2026-05-20+", start="2026-05-20")

    print("\n== Venue check: HL perp candles vs Binance spot (overlap) ==")
    common = [c for c in px.columns if c in hlp.columns]
    hl_px = hlp[common].dropna(how="all")
    start = max(hl_px.dropna(thresh=5).index[0], pd.Timestamp("2023-01-01"))
    run("Binance data 2023+", data=px[common], start=start)
    run("HL data 2023+", data=hl_px, start=start)

    print("\n== Rolling 12m return of base ==")
    res = simulate(px, fund, BASE, "2021-01-01")
    roll = res["eq"] / res["eq"].shift(365) - 1
    q = roll.dropna()
    print(f"  12m windows: {len(q)}  positive {(q > 0).mean()*100:.0f}%  worst {q.min()*100:+.0f}%  median {q.median()*100:+.0f}%  best {q.max()*100:+.0f}%")
    report["rolling_12m"] = dict(pos_share=float((q > 0).mean()), worst=float(q.min()), median=float(q.median()))

    (CACHE / "report.json").write_text(json.dumps(report, indent=1, default=float))
    print(f"\nSaved {CACHE / 'report.json'}")


if __name__ == "__main__":
    main()
