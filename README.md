# Hyperliquid Quant Stack

[![CI](https://github.com/AndreaAcanfora/hyperliquid-quant-stack/actions/workflows/ci.yml/badge.svg)](https://github.com/AndreaAcanfora/hyperliquid-quant-stack/actions/workflows/ci.yml)
[![hl-exec on npm](https://img.shields.io/npm/v/@andreaaca/hl-exec?label=%40andreaaca%2Fhl-exec)](https://www.npmjs.com/package/@andreaaca/hl-exec)
[![trend-ensemble on npm](https://img.shields.io/npm/v/@andreaaca/trend-ensemble?label=%40andreaaca%2Ftrend-ensemble)](https://www.npmjs.com/package/@andreaaca/trend-ensemble)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

The open-source half of the trading bot I run on [Hyperliquid](https://hyperliquid.xyz): the order
execution engine, a trend-following strategy you can backtest in your browser, and the story of a
backtest that was off by a factor of fourteen.

**Live demo: [hyperliquid-quant-stack.vercel.app](https://hyperliquid-quant-stack.vercel.app)**

![The Lab: drag a slider and five years of backtest redraw in your browser](docs/img/lab.png)

## What's inside

| Path | What it is |
|---|---|
| [`apps/lab`](apps/lab) | Next.js app. Strategy Lab (backtest in a Web Worker, shareable URL state), position map, an animated replay of how orders get filled, and the case study below. Unit tests, plus Playwright and axe on desktop and mobile. |
| [`packages/hl-exec`](packages/hl-exec) | `@andreaaca/hl-exec`: production order execution for Hyperliquid perps. 69 tests against a faked venue. |
| [`packages/trend-ensemble`](packages/trend-ensemble) | `@andreaaca/trend-ensemble`: target weights, a backtester that runs anywhere, and a paper-trading runner. Matches the Python research engine to 1e-10. |
| [`research`](research) | The Python robustness study the strategy's parameters come from. |

The live bot imports both packages from npm, so the code here is the code that trades.

```mermaid
flowchart LR
  HL[("Hyperliquid API")]
  subgraph repo["this repo"]
    HX["@andreaaca/hl-exec<br/>orders, TP/SL, fills, funding"]
    TE["@andreaaca/trend-ensemble<br/>weights, backtest, paper runner"]
    Lab["apps/lab<br/>Next.js on Vercel"]
    Py["research/<br/>Python study"]
  end
  Bot["live bot<br/>(private)"]
  Bot -->|npm| HX
  Bot -->|npm| TE
  HX -->|signed orders| HL
  HL -->|daily candles, refreshed hourly| Lab
  TE -->|runBacktest in a Web Worker| Lab
  Py -.->|parity test to 1e-10| TE
```

## The backtest said +87%

After four months of live trading, the bot's own backtest engine said the same period should have
returned **+87%**. The account had made **+6%**.

Matching trades one by one showed they weren't even running the same strategy: only **9 of 53**
simulated entries had a live counterpart. The engine read spot-exchange volume while the bot trades
perpetuals, and it built its 30-minute bars by counting rows of 1-minute data, so every gap in the
data shifted the bars off the clock. With volume-gated signals, both differences matter.

So I built a replay that runs the bot's real signal code over the venue's own historical candles. It
reproduces **46 of 48** live entries, and it is now the only backtest I trust. Run against it, the
most heavily optimised strategy (143 tuned parameters) lost money out of sample. Removing two noisy
signals made it profitable, and that was confirmed on years it had never been tuned on.

The trend ensemble in this repo goes the other way: six textbook parameters, none fitted, the same
result on two independent data sources, and a TypeScript port that reproduces the Python research
engine exactly. It is what the Lab runs.

![What the strategy held, week by week](docs/img/positions.png)

## Execution, not just signals

`HyperliquidExecutor` is what turns a signal into a position without leaking money:

- **Maker-first ladder.** It posts at the best bid, steps one tick closer per interval, then
  crosses the spread only for the size still missing. An earlier version re-sent the full size after
  a partial fill and could double a position. That is now a regression test.
- **Closes that can't silently fail.** Reduce-only orders are retried on the on-chain remainder.
  When a share is still open, the client throws `CloseFailedError` instead of returning "nothing to
  close", so the caller keeps the position, its stop-loss and its take-profit.
- **Native TP/SL.** Hyperliquid acknowledges trigger orders without an order id, so the ids are
  recovered from the open-orders book. Without that they can't be cancelled or audited.
- **Accounting.** Fees come from real fills (WebSocket cache, REST fallback), and funding comes from
  the venue's history. Leverage is set per coin, and sub-accounts are signed with the same agent key.

![Order fill replay](docs/img/execution.png)

## Run it

```bash
pnpm install
pnpm build                        # the two packages (the Lab imports their dist)
pnpm test                         # unit tests: packages and Lab
pnpm --filter lab dev             # http://localhost:3000
pnpm --filter lab test:e2e        # Playwright + axe on a production build
python3 research/trend_ensemble_backtest.py   # the research report (needs numpy, pandas)
```

The Lab's prices come from `/api/daily`, which reads Hyperliquid's public candles and regenerates
at most once an hour, so the latest daily close shows up without a redeploy.

```ts
import { HyperliquidExecutor } from '@andreaaca/hl-exec';
import { DEFAULT_TREND_PARAMS, runBacktest } from '@andreaaca/trend-ensemble';
```

## What's not here

The bot's other two strategies, their parameters, the multi-tenant SaaS around it, and anything
tied to a real account stay private. This repo shows the reusable parts and the method.

Nothing here is financial advice. Backtests are not predictions; the case study above is about
exactly that.

## Contributing and releases

See [CONTRIBUTING.md](CONTRIBUTING.md). Releases are automated: every change to a package carries a
changeset, and merging the generated "Release packages" PR publishes to npm from GitHub Actions with
trusted publishing, so no npm token exists anywhere.

## License

MIT
