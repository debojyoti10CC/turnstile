/** Scheme + network constants for x402 batch-settlement on the AVM. */
export const SCHEME = 'batch-settlement' as const;

/** Domain-separation prefixes. MUST match contract.py byte-for-byte. */
export const VOUCHER_PREFIX = new TextEncoder().encode('x402-avm-bs-voucher-v1'); // 22 bytes
export const CHANNEL_PREFIX = new TextEncoder().encode('x402-avm-bs-channel-v1'); // 22 bytes

/** CAIP-2 ids per specs/schemes/exact/scheme_exact_algo.md (first 32 chars of url-safe b64 genesis hash). */
export const CAIP2 = {
  mainnet: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k',
  testnet: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe',
} as const;

export const WITHDRAW_DELAY_MIN = 900; // 15 min
export const WITHDRAW_DELAY_MAX = 2_592_000; // 30 days

/** Encoded sizes (ARC-4 static struct). */
export const CONFIG_BYTES = 32 * 4 + 8 + 8 + 32; // 176
export const VOUCHER_MESSAGE_BYTES = 22 + 32 + 8 + 32 + 8; // 102

/** Full genesis hashes (base64) — used in channelId / voucher messages. Source: @x402/avm constants. */
export const GENESIS_HASH_B64 = {
  mainnet: 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
  testnet: 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
} as const;

/** Circle USDC ASA ids. Source: @x402/avm constants (verify before mainnet). */
export const USDC_ASA_ID = { mainnet: 31566704n, testnet: 10458941n } as const;
export const USDC_DECIMALS = 6;
