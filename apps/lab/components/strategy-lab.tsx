"use client";

import { useEffect, useRef, useState } from "react";
import {
  BASE_LOOKBACKS,
  DEFAULT_SETTINGS,
  pct,
  toParams,
  type DailyData,
  type LabSettings,
  type WorkerResponse,
} from "@/lib/lab";
import { parseSettings, serializeSettings } from "@/lib/url-state";
import { RecorderChart } from "./recorder-chart";
import { PositionsMap } from "./positions-map";

const ALL_COINS = DEFAULT_SETTINGS.coins;
const YEARS = [2021, 2022, 2023, 2024, 2025, 2026];

function writeUrl(s: LabSettings) {
  const qs = serializeSettings(s);
  window.history.replaceState(null, "", qs ? `?${qs}#lab` : window.location.pathname + window.location.hash);
}

export function StrategyLab() {
  const [settings, setSettings] = useState<LabSettings>(DEFAULT_SETTINGS);
  const [data, setData] = useState<DailyData | null>(null);
  const [result, setResult] = useState<WorkerResponse | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const worker = useRef<Worker | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate from the shared URL once
    setSettings(parseSettings(window.location.search));
    fetch("/data/daily.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e: unknown) => setError(`Price data could not be loaded (${e instanceof Error ? e.message : e}). Reload the page to try again.`));
    const w = new Worker(new URL("../lib/backtest.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.id !== reqId.current) return; // a newer run superseded this one
      setResult(e.data);
      setBusy(false);
    };
    worker.current = w;
    return () => w.terminate();
  }, []);

  useEffect(() => {
    if (!data || !worker.current) return;
    reqId.current += 1;
    setBusy(true);
    worker.current.postMessage({ id: reqId.current, data, settings });
    writeUrl(settings);
  }, [data, settings]);

  const set = <K extends keyof LabSettings>(k: K, v: LabSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));
  const toggleCoin = (c: string) =>
    setSettings((s) => {
      const has = s.coins.includes(c);
      if (has && s.coins.length === 1) return s; // keep at least one coin
      return { ...s, coins: has ? s.coins.filter((x) => x !== c) : [...s.coins, c] };
    });
  const lookbacks = toParams(settings).lookbacks;
  const st = result?.stats;

  return (
    <div id="lab" className="scroll-mt-6">
      {error ? (
        <p role="alert" className="border-l-4 border-loss bg-white px-4 py-3 text-ink">{error}</p>
      ) : (
        <div className="graph-paper rounded-sm border border-grid-strong px-3 pt-4 pb-3 sm:px-5">
          <RecorderChart curve={result?.curve ?? []} busy={busy} />
        </div>
      )}

      <dl className="mt-6 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Yearly growth" value={st ? pct(st.cagr) : "…"} />
        <Stat label="Sharpe ratio" value={st ? st.sharpe.toFixed(2) : "…"} />
        <Stat label="Worst drawdown" value={st ? pct(st.maxDrawdown) : "…"} tone="loss" />
        <Stat label="Average exposure" value={st ? `${st.avgGross.toFixed(2)}×` : "…"} />
        <Stat label="Total return" value={st ? pct(st.totalReturn, 0) : "…"} />
        <Stat label="BTC held, same period" value={result ? pct(result.benchmarkReturn, 0) : "…"} muted />
      </dl>

      <div className="mt-8 grid gap-x-10 gap-y-6 md:grid-cols-2">
        <Slider
          label="Trend horizon"
          hint={`Looks back ${lookbacks.join(", ")} days`}
          min={0.5} max={2} step={0.25} value={settings.horizon}
          format={(v) => `${v}×`}
          onChange={(v) => set("horizon", v)}
        />
        <Slider
          label="Risk per coin"
          hint="Target yearly volatility, split across the coins"
          min={0.2} max={1.2} step={0.1} value={settings.volTarget}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => set("volTarget", v)}
        />
        <Slider
          label="Exposure cap"
          hint="Total position size as a multiple of equity"
          min={0.5} max={3} step={0.25} value={settings.grossCap}
          format={(v) => `${v}×`}
          onChange={(v) => set("grossCap", v)}
        />
        <Slider
          label="Rebalance threshold"
          hint="Skip trades smaller than this share of the target"
          min={0} max={0.5} step={0.05} value={settings.band}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => set("band", v)}
        />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-4">
        <fieldset className="flex flex-wrap items-center gap-1.5">
          <legend className="mb-2 text-sm font-medium">Coins</legend>
          {ALL_COINS.map((c) => {
            const on = settings.coins.includes(c);
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                onClick={() => toggleCoin(c)}
                className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                  on ? "border-ink bg-ink text-paper" : "border-grid-strong bg-white text-ink-soft hover:border-ink"
                }`}
              >
                {c}
              </button>
            );
          })}
        </fieldset>
        <label className="flex flex-col gap-2 text-sm font-medium">
          Start
          <select
            value={settings.startYear}
            onChange={(e) => set("startYear", Number(e.target.value))}
            className="rounded-sm border border-grid-strong bg-white px-2 py-1 font-normal"
          >
            {YEARS.map((y) => <option key={y} value={y}>Jan {y}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 self-end pb-1 text-sm font-medium">
          <input
            type="checkbox"
            checked={!settings.longOnly}
            onChange={(e) => set("longOnly", !e.target.checked)}
            className="size-4 accent-ink"
          />
          Allow short positions
        </label>
        <button
          type="button"
          onClick={() => setSettings(DEFAULT_SETTINGS)}
          className="self-end pb-1 text-sm text-ink-soft underline decoration-grid-strong underline-offset-4 hover:text-ink"
        >
          Reset to defaults
        </button>
      </div>

      <p className="mt-4 text-xs text-ink-faint">
        {result ? `Simulated ${result.curve.length.toLocaleString("en-US")} days in ${Math.round(result.ms)} ms, in your browser. ` : ""}
        Defaults are the live configuration ({BASE_LOOKBACKS.join("/")}-day lookbacks, 60% volatility target). Costs: 0.045% taker fee plus
        2 bps slippage per trade, funding at Hyperliquid&apos;s base rate. Prices: Hyperliquid daily closes
        {data ? ` up to ${new Date(data.days.at(-1)!).toISOString().slice(0, 10)}` : ""}.
      </p>

      {result && <PositionsMap positions={result.positions} coins={settings.coins} />}
    </div>
  );
}

function Stat({ label, value, tone, muted }: { label: string; value: string; tone?: "loss"; muted?: boolean }) {
  return (
    <div>
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className={`font-display text-3xl font-semibold tracking-tight ${tone === "loss" ? "text-loss" : muted ? "text-ink-faint" : "text-ink"}`}>
        {value}
      </dd>
    </div>
  );
}

function Slider(props: {
  label: string; hint: string; min: number; max: number; step: number; value: number;
  format: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between gap-4">
        <span className="font-medium">{props.label}</span>
        <span className="font-display text-lg font-semibold">{props.format(props.value)}</span>
      </span>
      <input
        type="range"
        min={props.min} max={props.max} step={props.step} value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="mt-2 w-full"
      />
      <span className="text-sm text-ink-soft">{props.hint}</span>
    </label>
  );
}
