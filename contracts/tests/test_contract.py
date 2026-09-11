"""Offline unit tests using algorand-python-testing (no LocalNet needed).

These cover contract logic + invariants I1..I7. LocalNet integration tests
(fees, opcode budget, box refs, real signatures from the TS SDK) live in
tests/localnet/ and are written by Claude Code in Phase 1.
"""
import random
from collections.abc import Generator

import algosdk
import nacl.signing
import pytest
from algopy import Account, Bytes, UInt64, arc4
from algopy_testing import AlgopyTestContext, algopy_testing_context

from smart_contracts.x402_batch_settlement.contract import (
    VOUCHER_PREFIX,
    Bytes32,
    Bytes64,
    ChannelConfig,
    Claim,
    X402BatchSettlement,
)

GENESIS = bytes(range(32))
T0 = 1_800_000_000
DELAY = 900


@pytest.fixture()
def ctx() -> Generator[AlgopyTestContext, None, None]:
    with algopy_testing_context() as c:
        c.ledger.patch_global_fields(genesis_hash=Bytes(GENESIS), latest_timestamp=UInt64(T0))
        yield c


class World:
    def __init__(self, ctx: AlgopyTestContext):
        self.ctx = ctx
        self.app = X402BatchSettlement()
        self.app_acct = ctx.ledger.get_app(self.app).address
        self.app_id = int(ctx.ledger.get_app(self.app).id)
        self.asset = ctx.any.asset()
        self.payer = ctx.any.account()
        self.receiver = ctx.any.account()
        self.rauth = ctx.any.account()
        self.sk = nacl.signing.SigningKey.generate()
        self.pk = bytes(self.sk.verify_key)

    def config(self, salt: bytes = b"\x00" * 32, sk=None, delay=DELAY) -> ChannelConfig:
        pk = bytes((sk or self.sk).verify_key)
        return ChannelConfig(
            payer=arc4.Address(self.payer),
            payer_authorizer=arc4.Address(algosdk.encoding.encode_address(pk)),
            receiver=arc4.Address(self.receiver),
            receiver_authorizer=arc4.Address(self.rauth),
            asset=arc4.UInt64(self.asset.id),
            withdraw_delay=arc4.UInt64(delay),
            salt=Bytes32.from_bytes(salt),
        )

    def deposit(self, cfg: ChannelConfig, amount: int, sender=None, **xfer_over) -> bytes:
        mbr_needed = self.app.open_mbr(cfg)
        fields = dict(
            sender=sender or self.payer,
            asset_receiver=self.app_acct,
            xfer_asset=self.asset,
            asset_amount=UInt64(amount),
        )
        fields.update(xfer_over)
        xfer = self.ctx.any.txn.asset_transfer(**fields)
        mbr = self.ctx.any.txn.payment(receiver=self.app_acct, amount=UInt64(int(mbr_needed)))
        return self.app.deposit(cfg, xfer, mbr).bytes.value

    def voucher(self, cid: bytes, max_claimable: int, sk=None, app_id=None, genesis=None) -> bytes:
        msg = (
            VOUCHER_PREFIX
            + (genesis or GENESIS)
            + (app_id or self.app_id).to_bytes(8, "big")
            + cid
            + max_claimable.to_bytes(8, "big")
        )
        return (sk or self.sk).sign(msg).signature

    def claim(self, rows, sender=None) -> int:
        arr = arc4.DynamicArray[Claim](
            *[
                Claim(
                    channel_id=Bytes32.from_bytes(cid),
                    max_claimable=arc4.UInt64(mx),
                    signature=Bytes64.from_bytes(sig),
                    total_claimed=arc4.UInt64(tot),
                )
                for cid, mx, sig, tot in rows
            ]
        )
        with self.ctx.txn.create_group(active_txn_overrides={"sender": sender or self.rauth}):
            return int(self.app.claim(arr))

    def as_(self, sender, fn, *a):
        with self.ctx.txn.create_group(active_txn_overrides={"sender": sender}):
            return fn(*a)

    def view(self, cid: bytes):
        v = self.app.get_channel(Bytes32.from_bytes(cid))
        return int(v.balance.as_uint64()), int(v.total_claimed.as_uint64()), int(v.withdraw_requested_at.as_uint64()), int(v.withdraw_amount.as_uint64())


def test_voucher_message_matches_reference(ctx):
    w = World(ctx)
    cid = bytes(range(100, 132))
    got = w.app.voucher_message(Bytes32.from_bytes(cid), arc4.UInt64(12345)).native.value
    want = VOUCHER_PREFIX + GENESIS + w.app_id.to_bytes(8, "big") + cid + (12345).to_bytes(8, "big")
    assert got == want and len(got) == 22 + 32 + 8 + 32 + 8


def test_happy_path_claim_settle_conservation(ctx):  # I1 I2 I3
    w = World(ctx)
    cid = w.deposit(w.config(), 1_000_000)
    assert w.view(cid)[:2] == (1_000_000, 0)
    assert w.claim([(cid, 300, w.voucher(cid, 300), 250)]) == 250  # dynamic pricing: claim < ceiling
    assert w.view(cid)[1] == 250
    settled = int(w.app.settle(w.receiver, w.asset))
    assert settled == 250
    refunded = w.as_(w.rauth, w.app.refund, Bytes32.from_bytes(cid), UInt64(10**12))
    assert int(refunded) == 1_000_000 - 250
    assert settled + int(refunded) == 1_000_000


def test_top_up_and_config_binding(ctx):
    w = World(ctx)
    cfg = w.config()
    cid = w.deposit(cfg, 100)
    assert w.deposit(cfg, 50) == cid
    assert w.view(cid)[0] == 150


def test_stale_voucher_is_noop(ctx):  # I2
    w = World(ctx)
    cid = w.deposit(w.config(), 1000)
    w.claim([(cid, 500, w.voucher(cid, 500), 500)])
    assert w.claim([(cid, 400, w.voucher(cid, 400), 400)]) == 0
    assert w.view(cid)[1] == 500


def test_forged_signature_rejected(ctx):
    w = World(ctx)
    cid = w.deposit(w.config(), 1000)
    bad = bytearray(w.voucher(cid, 500)); bad[0] ^= 1
    with pytest.raises(AssertionError, match="bad voucher sig"):
        w.claim([(cid, 500, bytes(bad), 500)])


def test_wrong_signer_rejected(ctx):
    w = World(ctx)
    cid = w.deposit(w.config(), 1000)
    other = nacl.signing.SigningKey.generate()
    with pytest.raises(AssertionError, match="bad voucher sig"):
        w.claim([(cid, 500, w.voucher(cid, 500, sk=other), 500)])


def test_cross_channel_voucher_rejected(ctx):  # I4
    w = World(ctx)
    a = w.deposit(w.config(salt=b"\x01" * 32), 1000)
    b = w.deposit(w.config(salt=b"\x02" * 32), 1000)
    with pytest.raises(AssertionError, match="bad voucher sig"):
        w.claim([(b, 500, w.voucher(a, 500), 500)])


def test_cross_app_and_cross_network_rejected(ctx):  # I4
    w = World(ctx)
    cid = w.deposit(w.config(), 1000)
    with pytest.raises(AssertionError, match="bad voucher sig"):
        w.claim([(cid, 500, w.voucher(cid, 500, app_id=w.app_id + 1), 500)])
    with pytest.raises(AssertionError, match="bad voucher sig"):
        w.claim([(cid, 500, w.voucher(cid, 500, genesis=b"\xff" * 32), 500)])


def test_claim_above_balance_rejected(ctx):  # I1
    w = World(ctx)
    cid = w.deposit(w.config(), 1000)
    with pytest.raises(AssertionError, match="max_claimable > balance"):
        w.claim([(cid, 1001, w.voucher(cid, 1001), 1001)])


def test_total_above_ceiling_rejected(ctx):
    w = World(ctx)
    cid = w.deposit(w.config(), 1000)
    with pytest.raises(AssertionError, match="total > max_claimable"):
        w.claim([(cid, 500, w.voucher(cid, 500), 501)])


def test_only_receiver_side_can_claim_or_refund(ctx):  # I5
    w = World(ctx)
    cid = w.deposit(w.config(), 1000)
    with pytest.raises(AssertionError, match="not receiver"):
        w.claim([(cid, 500, w.voucher(cid, 500), 500)], sender=w.payer)
    with pytest.raises(AssertionError, match="not receiver"):
        w.as_(w.payer, w.app.refund, Bytes32.from_bytes(cid), UInt64(1))
    # receiver itself is also allowed
    assert w.claim([(cid, 500, w.voucher(cid, 500), 500)], sender=w.receiver) == 500


def test_only_payer_side_can_withdraw(ctx):  # I5
    w = World(ctx)
    cid = w.deposit(w.config(), 1000)
    with pytest.raises(AssertionError, match="not payer"):
        w.as_(w.rauth, w.app.initiate_withdraw, Bytes32.from_bytes(cid), UInt64(1))
    hot = Account(algosdk.encoding.encode_address(w.pk))
    w.as_(hot, w.app.initiate_withdraw, Bytes32.from_bytes(cid), UInt64(1))  # payer_authorizer allowed


def test_withdraw_delay_and_claim_window(ctx):  # I6 I7
    w = World(ctx)
    cid = w.deposit(w.config(), 1000)
    cb = Bytes32.from_bytes(cid)
    w.as_(w.payer, w.app.initiate_withdraw, cb, UInt64(1000))
    with pytest.raises(AssertionError, match="withdraw delay"):
        w.as_(w.payer, w.app.finalize_withdraw, cb)
    # receiver claims inside the window (I8 happy case)
    w.claim([(cid, 400, w.voucher(cid, 400), 400)])
    ctx.ledger.patch_global_fields(latest_timestamp=UInt64(T0 + DELAY))
    out = int(w.as_(w.payer, w.app.finalize_withdraw, cb))
    assert out == 600  # capped at unclaimed escrow
    assert w.view(cid) == (400, 400, 0, 0)
    # after drain, the old voucher cannot claim more (I6)
    with pytest.raises(AssertionError, match="max_claimable > balance"):
        w.claim([(cid, 500, w.voucher(cid, 500), 500)])


def test_payer_recovers_if_receiver_offline(ctx):  # I7
    w = World(ctx)
    cid = w.deposit(w.config(), 1000)
    cb = Bytes32.from_bytes(cid)
    w.as_(w.payer, w.app.initiate_withdraw, cb, UInt64(1000))
    ctx.ledger.patch_global_fields(latest_timestamp=UInt64(T0 + DELAY))
    assert int(w.as_(w.payer, w.app.finalize_withdraw, cb)) == 1000


def test_refund_caps_pending_withdraw(ctx):
    w = World(ctx)
    cid = w.deposit(w.config(), 1000)
    cb = Bytes32.from_bytes(cid)
    w.as_(w.payer, w.app.initiate_withdraw, cb, UInt64(800))
    w.as_(w.rauth, w.app.refund, cb, UInt64(500))
    assert w.view(cid)[3] == 500  # 1000-500 left, withdraw capped to 500
    w.as_(w.rauth, w.app.refund, cb, UInt64(500))
    assert w.view(cid)[2:] == (0, 0)  # fully drained -> withdraw cancelled


def test_refund_then_refund_reopen_cannot_replay(ctx):
    w = World(ctx)
    cfg = w.config()
    cid = w.deposit(cfg, 1000)
    w.claim([(cid, 700, w.voucher(cid, 700), 700)])
    w.as_(w.rauth, w.app.refund, Bytes32.from_bytes(cid), UInt64(300))
    w.deposit(cfg, 1000)  # same channel re-funded
    assert w.view(cid)[:2] == (1700, 700)  # total_claimed survived
    assert w.claim([(cid, 700, w.voucher(cid, 700), 700)]) == 0


def test_withdraw_delay_bounds(ctx):
    w = World(ctx)
    with pytest.raises(AssertionError, match="withdraw delay range"):
        w.deposit(w.config(delay=899), 10)
    with pytest.raises(AssertionError, match="withdraw delay range"):
        w.deposit(w.config(delay=2_592_001), 10)


@pytest.mark.parametrize(
    "over,err",
    [
        ("sender", "xfer sender != payer"),
        ("asset_close_to", "close_to set"),
        ("rekey_to", "rekey set"),
        ("asset_sender", "clawback not allowed"),
    ],
)
def test_malicious_deposit_groups(ctx, over, err):
    w = World(ctx)
    evil = w.ctx.any.account()
    kwargs = {}
    if over == "sender":
        with pytest.raises(AssertionError, match=err):
            w.deposit(w.config(), 10, sender=evil)
        return
    kwargs[over] = evil
    with pytest.raises(AssertionError, match=err):
        w.deposit(w.config(), 10, **kwargs)


def test_insufficient_mbr_rejected(ctx):
    w = World(ctx)
    cfg = w.config()
    xfer = ctx.any.txn.asset_transfer(sender=w.payer, asset_receiver=w.app_acct, xfer_asset=w.asset, asset_amount=UInt64(10))
    mbr = ctx.any.txn.payment(receiver=w.app_acct, amount=UInt64(1))
    with pytest.raises(AssertionError, match="mbr amount"):
        w.app.deposit(cfg, xfer, mbr)


def test_batch_claim_multiple_channels(ctx):
    w = World(ctx)
    cids = [w.deposit(w.config(salt=bytes([i]) * 32), 1000) for i in range(1, 5)]
    rows = [(c, 100 * (i + 1), w.voucher(c, 100 * (i + 1)), 100 * (i + 1)) for i, c in enumerate(cids)]
    assert w.claim(rows) == 100 + 200 + 300 + 400
    assert int(w.app.get_unsettled(w.receiver, w.asset)) == 1000
    assert int(w.app.settle(w.receiver, w.asset)) == 1000
    with pytest.raises(AssertionError, match="nothing to settle"):
        w.app.settle(w.receiver, w.asset)


def test_fuzz_conservation(ctx):  # I1 I2 I3 under random op sequences
    rnd = random.Random(402)
    w = World(ctx)
    cfg = w.config()
    cid = w.deposit(cfg, 1000)
    cb = Bytes32.from_bytes(cid)
    deposited, paid_out, refunded, signed = 1000, 0, 0, 0
    now = T0
    for _ in range(300):
        bal, claimed, req, _amt = w.view(cid)
        op_ = rnd.choice(["dep", "claim", "stale", "refund", "wd", "fin", "tick", "settle"])
        try:
            if op_ == "dep":
                a = rnd.randint(1, 500); w.deposit(cfg, a); deposited += a
            elif op_ == "claim" and bal > claimed:
                mx = rnd.randint(claimed + 1, bal); tot = rnd.randint(claimed, mx)
                w.claim([(cid, mx, w.voucher(cid, mx), tot)]); signed = max(signed, mx)
            elif op_ == "stale" and claimed > 0:
                assert w.claim([(cid, claimed, w.voucher(cid, claimed), claimed)]) == 0
            elif op_ == "refund" and bal > claimed:
                refunded += int(w.as_(w.rauth, w.app.refund, cb, UInt64(rnd.randint(1, bal - claimed))))
            elif op_ == "wd" and bal > claimed:
                w.as_(w.payer, w.app.initiate_withdraw, cb, UInt64(rnd.randint(1, bal - claimed)))
            elif op_ == "fin" and req:
                if now >= req + DELAY:
                    refunded += int(w.as_(w.payer, w.app.finalize_withdraw, cb))
            elif op_ == "tick":
                now += rnd.randint(1, 600); ctx.ledger.patch_global_fields(latest_timestamp=UInt64(now))
            elif op_ == "settle" and int(w.app.get_unsettled(w.receiver, w.asset)) > 0:
                paid_out += int(w.app.settle(w.receiver, w.asset))
        except AssertionError as e:
            pytest.fail(f"unexpected revert in {op_}: {e}")
        nb, nc, _, _ = w.view(cid)
        assert nc <= nb, "I1"
        assert nc >= claimed, "I2"
        unsettled = int(w.app.get_unsettled(w.receiver, w.asset))
        # I3: deposited == escrow_unclaimed + claimed(unsettled + paid) + refunded
        assert deposited == (nb - nc) + unsettled + paid_out + refunded, "I3"
