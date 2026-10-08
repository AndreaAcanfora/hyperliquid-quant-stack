import type { OrderStateValue } from './types.js';

/** Minimal logger; pass your own, the default is silent. */
export interface ExecutorLogger {
  log(level: 'info' | 'warning' | 'error', message: string): void;
}

export const SILENT_LOGGER: ExecutorLogger = { log: () => undefined };

/**
 * Optional sink for in-flight maker order state (e.g. a cache key a UI
 * reads to lock a manual "close" button). Failures must not throw.
 */
export interface OrderStateSink {
  publish(namespace: string, market: string, value: OrderStateValue, ttlSec: number): Promise<void>;
  clear(namespace: string, market: string): Promise<void>;
}

export interface ExecutorCredentials {
  /** Agent wallet private key (0x + 64 hex), approved by the account. */
  agentPrivateKey: string;
  /** Account (master) address the agent trades for (0x + 40 hex). */
  accountAddress: string;
  /** Sub-account to trade and query instead of the master account. */
  vaultAddress?: string;
}

export interface ExecutorOptions {
  /** Use HL testnet endpoints. Default false (mainnet). */
  testnet?: boolean;
  logger?: ExecutorLogger;
  orderStateSink?: OrderStateSink;
  /** Total maker-ladder time before the taker fallback. Default 240 s. */
  makerWaitMs?: number;
  /** How often the ladder checks the position for fills. Default 3 s. */
  makerPollMs?: number;
  /** Number of post-only steps in the ladder. Default 3. */
  makerSteps?: number;
  /** Cross leverage set once per coin before its first entry. Default 5. */
  crossLeverage?: number;
  /** Credentials used by `connect()`; or call `connectWithCredentials`. */
  credentials?: ExecutorCredentials;
}
