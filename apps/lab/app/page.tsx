import { StrategyLab } from "@/components/strategy-lab";
import { ExecutionLadder } from "@/components/execution-ladder";
import { CaseStudy } from "@/components/case-study";

const REPO = "https://github.com/AndreaAcanfora/hyperliquid-quant-stack";

export default function Home() {
  return (
    <main className="mx-auto max-w-[1100px] px-5 pb-24 sm:px-8">
      <header className="flex items-center justify-between gap-4 py-6 text-sm">
        <span className="font-display text-base font-semibold">Hyperliquid Quant Stack</span>
        <nav className="flex gap-5 text-ink-soft">
          <a href="#lab" className="hidden hover:text-ink sm:inline">Lab</a>
          <a href="#execution" className="hidden hover:text-ink sm:inline">Execution</a>
          <a href="#backtest-lied" className="hidden hover:text-ink sm:inline">Case study</a>
          <a href={REPO} className="hover:text-ink">GitHub</a>
        </nav>
      </header>

      <section className="pt-6 pb-8">
        <h1 className="max-w-[18ch] font-display text-[clamp(2.4rem,6vw,4.4rem)] leading-[1.02] font-semibold tracking-[-0.02em]">
          Drag a slider, rerun five years of crypto.
        </h1>
        <p className="mt-5 max-w-[60ch] text-lg leading-relaxed text-ink-soft">
          This is the trend-following strategy my trading bot runs on Hyperliquid, backtested live in your
          browser on 13 coins. Change how it reads trends and how much risk it takes, and watch the
          equity curve redraw.
        </p>
      </section>

      <StrategyLab />

      <section id="execution" className="mt-28 scroll-mt-6">
        <h2 className="font-display text-3xl font-semibold tracking-tight">How an order actually gets filled</h2>
        <p className="mt-3 mb-8 max-w-[64ch] text-lg leading-relaxed text-ink-soft">
          A signal is the easy part. The execution engine first offers to buy at the best bid, inching up a
          tick at a time, and only pays the spread for whatever is still missing. These three runs replay
          paths covered by its test suite, including two bugs found with real money.
        </p>
        <ExecutionLadder />
      </section>

      <section id="backtest-lied" className="mt-28 scroll-mt-6">
        <h2 className="font-display text-3xl font-semibold tracking-tight">The backtest said +87%</h2>
        <p className="mt-3 mb-8 max-w-[64ch] text-lg leading-relaxed text-ink-soft">
          What four months of live trading taught me about trusting a simulation.
        </p>
        <CaseStudy />
      </section>

      <section className="mt-28">
        <h2 className="font-display text-3xl font-semibold tracking-tight">Use the pieces</h2>
        <p className="mt-3 max-w-[64ch] text-lg leading-relaxed text-ink-soft">
          Both packages are on npm and power the live bot, so the code here is the code that trades.
        </p>
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <Package
            name="@andreaaca/hl-exec"
            body="Order execution for Hyperliquid perps: maker-first ladders, partial-fill-safe closes, native stop-loss and take-profit, fee and funding accounting, sub-accounts."
            code={`const hl = new HyperliquidExecutor({ credentials });
await hl.connect();
await hl.openLong('ETH-USD', 500, 'trend entry');`}
          />
          <Package
            name="@andreaaca/trend-ensemble"
            body="Target weights, a backtester that runs in Node or a Web Worker, and a paper-trading runner. Matches the Python research engine to ten decimals."
            code={`const { stats } = runBacktest(series, DEFAULT_TREND_PARAMS);
console.log(stats.sharpe, stats.maxDrawdown);`}
          />
        </div>
      </section>

      <footer className="mt-24 border-t border-grid-strong pt-6 text-sm text-ink-soft">
        Built by Andrea Acanfora. Source on <a href={REPO} className="underline underline-offset-4 hover:text-ink">GitHub</a>.
        Backtests are not predictions; the case study above is about exactly that.
      </footer>
    </main>
  );
}

function Package({ name, body, code }: { name: string; body: string; code: string }) {
  return (
    <div className="border-t-2 border-ink pt-4">
      <h3 className="font-display text-lg font-semibold">{name}</h3>
      <p className="mt-2 text-ink-soft">{body}</p>
      {/* Focusable so keyboard users can scroll long lines. */}
      <pre tabIndex={0} aria-label={`${name} example`} className="mt-4 overflow-x-auto rounded-sm bg-ink p-4 text-sm leading-relaxed text-paper">
        <code>{`npm i ${name}\n\n${code}`}</code>
      </pre>
    </div>
  );
}
