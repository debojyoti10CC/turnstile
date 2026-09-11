// Deterministic golden vectors consumed by contracts/tests/test_vectors.py (cross-language parity).
import { writeFileSync } from 'node:fs';
import { channelId, encodeAddress, publicKeyOf, signVoucher, toHex, voucherMessage, type ChannelConfig } from '../src/index.js';

const seed = (b: number) => Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff);
const addr = async (b: number) => encodeAddress(await publicKeyOf(seed(b)));

const deployment = { genesisHash: Uint8Array.from({ length: 32 }, (_, i) => i), appId: 1001n /* first app id allocated by algorand-python-testing */ };
const signerSk = seed(7);
const cfg: ChannelConfig = {
  payer: await addr(1), payerAuthorizer: encodeAddress(await publicKeyOf(signerSk)),
  receiver: await addr(2), receiverAuthorizer: await addr(3),
  asset: 10458941n, withdrawDelay: 900n, salt: new Uint8Array(32).fill(9),
};
const cid = channelId(cfg, deployment);
const vouchers = [];
for (const max of [1n, 1000n, 123456789n, 0xffff_ffff_ffff_ffffn]) {
  vouchers.push({ maxClaimable: max.toString(), message: toHex(voucherMessage(deployment, cid, max)),
    signature: toHex(await signVoucher(signerSk, deployment, cid, max)) });
}
const out = {
  deployment: { genesisHash: toHex(deployment.genesisHash), appId: deployment.appId.toString() },
  config: { ...cfg, asset: cfg.asset.toString(), withdrawDelay: cfg.withdrawDelay.toString(), salt: toHex(cfg.salt) },
  signerSeed: toHex(signerSk), channelId: toHex(cid), vouchers,
};
writeFileSync(new URL('../test/vectors.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('wrote test/vectors.json', out.channelId);
