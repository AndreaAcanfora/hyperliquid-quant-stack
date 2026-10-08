---
"@andreaaca/hl-exec": minor
---

Split the executor into modules and export the pure helpers (`stepPrice`, `priceTick`, `formatPrice`, `formatSize`, `toMarket`, `toInterval`, `aggregateFills`, `mergeTradeResults`, `constants`). Entries and exits now share one maker ladder that reposts only the unfilled remainder. The maker fee estimate is HL tier 0 (0.015%).

Breaking: `mainAddress` is now `accountAddress`, `makerCloseMaxWaitMs` is `makerWaitMs` (plus new `makerPollMs` and `makerSteps` options), and `getCandles` returns typed `Candle` objects with numeric prices and `volume` instead of `baseTokenVolume`.
