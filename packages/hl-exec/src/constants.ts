/** Hyperliquid tier-0 fee rates, used only to estimate a fee when the fill record is unavailable. */
export const HL_MAKER_FEE_RATE = 0.00015; // post-only (Alo) fills
export const HL_TAKER_FEE_RATE = 0.00045; // IOC fills

/** Remainders worth less than this (USD) count as filled: rounding dust no order can express. */
export const DUST_NOTIONAL_USD = 1;

/** Reduce-only IOC attempts on the remainder before a close is reported as failed. */
export const CLOSE_IOC_ATTEMPTS = 3;

/** Taker orders are priced this far past the far side of the book, so they cross even if it moves. */
export const TAKER_CROSS_BUFFER = 0.0025;

/** Taker price offset from the mark when the order book is unavailable. */
export const NO_BOOK_SLIPPAGE = 0.005;

/** A maker ladder that has moved this share of its size counts as filled; the rest is swept by IOC. */
export const MAKER_FILLED_SHARE = 0.9;
