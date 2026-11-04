---
"@andreaaca/hl-exec": patch
---

Entries no longer drop a partial maker fill. When the taker IOC for the remainder is rejected (for example during a fast move), it is retried up to 3 times on a fresh book. If it never fills, `openLong`/`openShort` return what the ladder already bought, so the caller tracks and protects it, instead of returning null and leaving that position open and unmanaged. When maker and taker both fill, the result now covers the whole size.
