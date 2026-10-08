# @andreaaca/trend-ensemble

A daily time-series-momentum ensemble for crypto perps, with a backtester that runs in Node or the
browser and a paper-trading runner.

```bash
npm i @andreaaca/trend-ensemble
```

## The rule (no fitted parameters)

- `score = mean(sign(close / close[-L] - 1))` for L in 14, 28, 56, 112 days, long-only
- `weight = score * min(volTarget / vol30, 3) / N`, then gross exposure is capped
- rebalance daily, skipping trades smaller than 20% of the target

## Use it

```ts
import { DEFAULT_TREND_PARAMS, runBacktest, targetWeights } from '@andreaaca/trend-ensemble';

const { points, stats } = runBacktest(
  { days, closes: { BTC: btcCloses, ETH: ethCloses } }, // null for missing days
  DEFAULT_TREND_PARAMS,
  { startMs: Date.UTC(2021, 0, 1), recordWeights: true },
);
console.log(stats.cagr, stats.sharpe, stats.maxDrawdown);

const weights = targetWeights({ BTC: btcCloses, ETH: ethCloses }, DEFAULT_TREND_PARAMS);
```

`@andreaaca/trend-ensemble/shadow` (Node only) runs the strategy on a virtual book against live
Hyperliquid prices, charging fees and funding, and logs every day to JSONL.

The backtester reproduces the Python research engine (`research/` in the repo) to 1e-10 on real
data; see `test/parity.test.ts`.

MIT licensed. Not financial advice.
