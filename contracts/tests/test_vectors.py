"""Cross-language parity: channel ids, voucher bytes and signatures produced by
@turnstile/core (TS) must be reproduced / accepted by the contract.
Regenerate vectors with `pnpm -F @turnstile/core vectors` and copy to this folder."""
import json
import pathlib

from algopy import Account, Bytes, UInt64, arc4
from algopy_testing import algopy_testing_context

from smart_contracts.x402_batch_settlement.contract import Bytes32, Bytes64, ChannelConfig, Claim, X402BatchSettlement

V = json.loads((pathlib.Path(__file__).parent / "vectors.json").read_text())


def test_ts_vectors_accepted_by_contract():
    with algopy_testing_context() as ctx:
        ctx.ledger.patch_global_fields(
            genesis_hash=Bytes(bytes.fromhex(V["deployment"]["genesisHash"])), latest_timestamp=UInt64(1)
        )
        app = X402BatchSettlement()
        assert int(ctx.ledger.get_app(app).id) == int(V["deployment"]["appId"]), "vectors must use emulator app id"
        c = V["config"]
        cfg = ChannelConfig(
            payer=arc4.Address(c["payer"]),
            payer_authorizer=arc4.Address(c["payerAuthorizer"]),
            receiver=arc4.Address(c["receiver"]),
            receiver_authorizer=arc4.Address(c["receiverAuthorizer"]),
            asset=arc4.UInt64(int(c["asset"])),
            withdraw_delay=arc4.UInt64(int(c["withdrawDelay"])),
            salt=Bytes32.from_bytes(bytes.fromhex(c["salt"])),
        )
        assert app.channel_id(cfg).bytes.value.hex() == V["channelId"]
        cid = Bytes32.from_bytes(bytes.fromhex(V["channelId"]))
        for v in V["vouchers"]:
            assert app.voucher_message(cid, arc4.UInt64(int(v["maxClaimable"]))).native.value.hex() == v["message"]

        app_acct = ctx.ledger.get_app(app).address
        asset = ctx.any.asset(asset_id=int(c["asset"]))
        xfer = ctx.any.txn.asset_transfer(
            sender=Account(c["payer"]), asset_receiver=app_acct, xfer_asset=asset, asset_amount=UInt64(10**6)
        )
        mbr = ctx.any.txn.payment(receiver=app_acct, amount=app.open_mbr(cfg))
        assert app.deposit(cfg, xfer, mbr).bytes.value.hex() == V["channelId"]
        v = V["vouchers"][1]  # maxClaimable 1000, signed in TS
        row = Claim(
            channel_id=cid,
            max_claimable=arc4.UInt64(int(v["maxClaimable"])),
            signature=Bytes64.from_bytes(bytes.fromhex(v["signature"])),
            total_claimed=arc4.UInt64(800),
        )
        with ctx.txn.create_group(active_txn_overrides={"sender": Account(c["receiverAuthorizer"])}):
            assert int(app.claim(arc4.DynamicArray[Claim](row))) == 800
