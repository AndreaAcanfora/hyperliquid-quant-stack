# @andreaaca/hl-exec

Production order execution for Hyperliquid perpetuals, extracted from a bot that trades with real money.

```bash
npm i @andreaaca/hl-exec
```

```ts
import { CloseFailedError, HyperliquidExecutor } from '@andreaaca/hl-exec';

const hl = new HyperliquidExecutor({
  credentials: {
    agentPrivateKey: process.env.HL_AGENT_KEY!,   // agent approved via ApproveAgent
    accountAddress: process.env.HL_ACCOUNT!,
    // vaultAddress: '0x…'                         // trade a sub-account instead
  },
  makerWaitMs: 240_000, // maker ladder before the taker fallback
  crossLeverage: 5,
  logger: { log: (level, msg) => console.log(level, msg) },
});
await hl.connect();

const fill = await hl.openLong('ETH-USD', 500, 'trend entry');      // maker-first
await hl.placeTPSL('ETH-USD', 'LONG', fill!.size, 3300, 2400);      // native triggers
try {
  await hl.closePosition('ETH-USD', 'FLAT', { expectedSide: 'LONG', expectedSize: fill!.size });
} catch (err) {
  if (err instanceof CloseFailedError) {
    // still open: keep tracking it, TP/SL are still resting, retry later
  }
}
```

## Behaviour

| Concern | What happens |
|---|---|
| Entries | Post-only ladder anchored on the L2 best bid/offer, one tick more aggressive per step; the taker IOC is sized to the unfilled remainder only. Leftover resting orders are swept on exit. |
| Exits | `FLAT`/`MH` reasons use the maker ladder, everything else goes straight to a reduce-only IOC. Partial fills are retried on the on-chain remainder (3 attempts). |
| Failure | `CloseFailedError` (with `filledSize` / `remainingSize`) when a share stays open; `null` only means "nothing to close". |
| TP/SL | `positionTpsl` trigger orders; the SL limit allows 5% slippage past the trigger so a fast move can't leave it unfilled. Oids are resolved from the open-orders book when HL acks with `waitingForTrigger`. |
| Accounting | `getFillsForOrder`, `getFillsByTime`, `getFundingSince`, `getFundingRates`; unified-margin aware `getBalance`. |
| Hooks | `logger` and an `orderStateSink` (publish in-flight maker state, e.g. to lock a UI button). |

MIT licensed. Not financial advice.
