export function u64be(n: bigint): Uint8Array {
  if (n < 0n || n > 0xffff_ffff_ffff_ffffn) throw new RangeError('uint64 out of range');
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, false);
  return b;
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
export const fromHex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
export const toB64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
export const fromB64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));
export function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}
