import { sha512_256 } from '@noble/hashes/sha512';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(s: string): Uint8Array {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 char: ${ch}`);
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Uint8Array.from(out);
}

function base32Encode(b: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const byte of b) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Algorand address (58 chars) -> 32-byte public key, checksum verified. */
export function decodeAddress(addr: string): Uint8Array {
  if (addr.length !== 58) throw new Error('address must be 58 chars');
  const raw = base32Decode(addr);
  const pk = raw.slice(0, 32);
  const checksum = raw.slice(32, 36);
  const expect = sha512_256(pk).slice(-4);
  if (!expect.every((v, i) => v === checksum[i])) throw new Error('bad address checksum');
  return pk;
}

/** 32-byte public key -> Algorand address. Any ed25519 pubkey is a valid address. */
export function encodeAddress(pk: Uint8Array): string {
  if (pk.length !== 32) throw new Error('pk must be 32 bytes');
  const withSum = new Uint8Array(36);
  withSum.set(pk); withSum.set(sha512_256(pk).slice(-4), 32);
  return base32Encode(withSum);
}
