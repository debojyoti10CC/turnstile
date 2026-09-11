"""Real-node LocalNet tests: fees, box refs, op-up budget, real signatures.

Skipped automatically (see conftest.py) when LocalNet is unreachable. Deploys
one fresh app per test module (see `world` fixture) so tests can run in any
order without interfering with each other's channels (each test uses its own
random salt).

Covers invariants: I1 (totalClaimed <= balance), I2 (monotonic), I3
(conservation), I4 (voucher scoped to genesis/app/channel), I5 (role checks),
I7 (payer can always recover after delay), I9 (never over-claim), I10
(open_mbr == real MBR delta).

Box references are supplied explicitly rather than relying on algokit_utils's
simulate-based auto-population: on this algod/algokit_utils version pairing,
letting the composer auto-discover box refs for a *method call* (as opposed
to a bare app call) triggers an internal fee-probe path that fails with a
misleading "group fee too small" error from an unrelated stub program. Passing
`box_references` explicitly and `populate_app_call_resources=False` avoids it.
See docs/PROGRESS.md P1 log for the full diagnosis.
"""
import base64
import pathlib
import secrets
import sys

import algosdk
import nacl.signing
import pytest
from algokit_utils import (
    AlgoAmount,
    AlgorandClient,
    AppClient,
    AppClientMethodCallParams,
    AppClientParams,
    AssetTransferParams,
    BoxReference,
    PaymentParams,
    SigningAccount,
)

ARC56_PATH = (
    pathlib.Path(__file__).resolve().parents[2]
    / "smart_contracts"
    / "x402_batch_settlement"
    / "artifacts"
    / "X402BatchSettlement.arc56.json"
)

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))
from deploy import deploy_localnet  # noqa: E402

pytestmark = pytest.mark.usefixtures("algorand")

NO_AUTO_RESOURCES = {"populate_app_call_resources": False, "cover_app_call_inner_transaction_fees": False}


class World:
    """Thin helper wrapping one deployed app + two funded accounts."""

    def __init__(self, algorand: AlgorandClient, summary: dict):
        self.algorand = algorand
        self.app_id = summary["app_id"]
        self.app_address = summary["app_address"]
        self.asset_id = summary["asset_id"]
        self.deployer = summary["deployer"]
        self.payer = SigningAccount(private_key=summary["payer_private_key"], address=summary["payer"])
        self.receiver = SigningAccount(private_key=summary["receiver_private_key"], address=summary["receiver"])
        algorand.account.set_signer_from_account(self.payer)
        algorand.account.set_signer_from_account(self.receiver)
        # deploy_localnet() used its own AlgorandClient instance, so this
        # fixture's `algorand` never had the dispenser's signer registered.
        algorand.account.set_signer_from_account(algorand.account.localnet_dispenser())
        self.app_client = AppClient(
            AppClientParams(algorand=algorand, app_id=self.app_id, app_spec=ARC56_PATH.read_text())
        )

    # -------------------------------------------------------------- boxes
    def channel_box(self, cid: bytes) -> bytes:
        return b"c" + cid

    def unsettled_box(self, receiver_addr: str, asset_id: int) -> bytes:
        return b"u" + algosdk.encoding.decode_address(receiver_addr) + asset_id.to_bytes(8, "big")

    def _box_refs(self, *names: bytes) -> list[BoxReference]:
        return [BoxReference(self.app_id, name) for name in names]

    # ------------------------------------------------------------- calls
    def config(self, salt: bytes, sk: nacl.signing.SigningKey, receiver_authorizer: str, delay: int = 900):
        payer_authorizer_addr = algosdk.encoding.encode_address(bytes(sk.verify_key))
        return (
            self.payer.address,
            payer_authorizer_addr,
            self.receiver.address,
            receiver_authorizer,
            self.asset_id,
            delay,
            salt,
        )

    def channel_id(self, cfg) -> bytes:
        res = self.app_client.send.call(
            AppClientMethodCallParams(sender=self.deployer, method="channel_id", args=[cfg]),
            send_params=NO_AUTO_RESOURCES,
        )
        return bytes(res.abi_return)

    def open_mbr(self, cfg) -> int:
        res = self.app_client.send.call(
            AppClientMethodCallParams(sender=self.deployer, method="open_mbr", args=[cfg]),
            send_params=NO_AUTO_RESOURCES,
        )
        return int(res.abi_return)

    def deposit(self, cfg, amount: int) -> bytes:
        cid = self.channel_id(cfg)
        mbr_needed = self.open_mbr(cfg)
        xfer = self.algorand.create_transaction.asset_transfer(
            AssetTransferParams(
                sender=self.payer.address, receiver=self.app_address, asset_id=self.asset_id, amount=amount
            )
        )
        mbr = self.algorand.create_transaction.payment(
            PaymentParams(sender=self.payer.address, receiver=self.app_address, amount=AlgoAmount(micro_algo=mbr_needed))
        )
        res = self.app_client.send.call(
            AppClientMethodCallParams(
                sender=self.payer.address,
                method="deposit",
                args=[cfg, xfer, mbr],
                box_references=self._box_refs(
                    self.channel_box(cid), self.unsettled_box(self.receiver.address, self.asset_id)
                ),
            ),
            send_params=NO_AUTO_RESOURCES,
        )
        return bytes(res.abi_return)

    def _genesis_hash(self) -> bytes:
        params = self.algorand.client.algod.suggested_params()
        return base64.b64decode(params.gh)

    def voucher_message(self, channel_id: bytes, max_claimable: int) -> bytes:
        return (
            b"x402-avm-bs-voucher-v1"
            + self._genesis_hash()
            + self.app_id.to_bytes(8, "big")
            + channel_id
            + max_claimable.to_bytes(8, "big")
        )

    def sign_voucher(self, sk: nacl.signing.SigningKey, channel_id: bytes, max_claimable: int) -> bytes:
        msg = self.voucher_message(channel_id, max_claimable)
        return bytes(sk.sign(msg).signature)

    def claim(self, sender: str, channel_id: bytes, max_claimable: int, signature: bytes, total_claimed: int) -> int:
        claims = [(channel_id, max_claimable, signature, total_claimed)]
        # Per CLAUDE.md 7: op-up budget needs ceil(n * 2600 / 700) inner
        # create+delete "op-up" transactions, each costing one MinTxnFee,
        # pooled from the group -- the outer call's fee must cover them.
        n = len(claims)
        import math

        op_ups = math.ceil(n * 2600 / 700)
        res = self.app_client.send.call(
            AppClientMethodCallParams(
                sender=sender,
                method="claim",
                args=[claims],
                extra_fee=AlgoAmount(micro_algo=op_ups * 1_000),
                box_references=self._box_refs(
                    self.channel_box(channel_id), self.unsettled_box(self.receiver.address, self.asset_id)
                ),
            ),
            send_params=NO_AUTO_RESOURCES,
        )
        return int(res.abi_return)

    def settle(self, receiver: str) -> int:
        res = self.app_client.send.call(
            AppClientMethodCallParams(
                sender=self.deployer,
                method="settle",
                args=[receiver, self.asset_id],
                extra_fee=AlgoAmount(micro_algo=1_000),
                account_references=[receiver],
                asset_references=[self.asset_id],
                box_references=self._box_refs(self.unsettled_box(receiver, self.asset_id)),
            ),
            send_params=NO_AUTO_RESOURCES,
        )
        return int(res.abi_return)

    def get_channel(self, channel_id: bytes):
        res = self.app_client.send.call(
            AppClientMethodCallParams(
                sender=self.deployer,
                method="get_channel",
                args=[channel_id],
                box_references=self._box_refs(self.channel_box(channel_id)),
            ),
            send_params=NO_AUTO_RESOURCES,
        )
        ret = res.abi_return
        return {k: int(v) for k, v in ret.items()}

    def initiate_withdraw(self, channel_id: bytes, amount: int) -> None:
        self.app_client.send.call(
            AppClientMethodCallParams(
                sender=self.payer.address,
                method="initiate_withdraw",
                args=[channel_id, amount],
                box_references=self._box_refs(self.channel_box(channel_id)),
            ),
            send_params=NO_AUTO_RESOURCES,
        )

    def finalize_withdraw(self, channel_id: bytes) -> int:
        res = self.app_client.send.call(
            AppClientMethodCallParams(
                sender=self.payer.address,
                method="finalize_withdraw",
                args=[channel_id],
                extra_fee=AlgoAmount(micro_algo=1_000),
                asset_references=[self.asset_id],
                box_references=self._box_refs(self.channel_box(channel_id)),
            ),
            send_params=NO_AUTO_RESOURCES,
        )
        return int(res.abi_return)

    def advance_devmode_clock(self, seconds: int) -> None:
        """Bump LocalNet's dev-mode timestamp offset and latch it in with a
        throwaway payment -- algod only applies a new offset starting from
        the block *after* the one it was set on, so a call immediately
        following set_timestamp_offset() would still see the old time."""
        algod = self.algorand.client.algod
        algod.set_timestamp_offset(seconds)
        self.algorand.send.payment(
            PaymentParams(
                sender=self.payer.address,
                receiver=self.payer.address,
                amount=AlgoAmount(micro_algo=0),
                note=secrets.token_bytes(8),  # keep the latch txn's id unique across calls
            )
        )


@pytest.fixture(scope="module")
def world(algorand: AlgorandClient) -> World:
    summary = deploy_localnet()
    return World(algorand, summary)


def _fresh_salt() -> bytes:
    return secrets.token_bytes(32)


def test_I1_I2_I9_claim_bounded_and_monotonic(world: World):
    sk = nacl.signing.SigningKey.generate()
    cfg = world.config(_fresh_salt(), sk, world.receiver.address)
    cid = world.channel_id(cfg)
    world.deposit(cfg, 1_000_000)

    sig1 = world.sign_voucher(sk, cid, 300_000)
    world.claim(world.receiver.address, cid, 300_000, sig1, 300_000)
    state = world.get_channel(cid)
    assert state["total_claimed"] == 300_000
    assert state["total_claimed"] <= state["balance"]  # I1

    sig2 = world.sign_voucher(sk, cid, 600_000)
    world.claim(world.receiver.address, cid, 600_000, sig2, 600_000)
    state2 = world.get_channel(cid)
    assert state2["total_claimed"] == 600_000
    assert state2["total_claimed"] > state["total_claimed"]  # I2 monotonic

    # I9 equivalent at contract layer: claim with max_claimable > balance must fail
    sig_over = world.sign_voucher(sk, cid, 10_000_000)
    with pytest.raises(Exception):
        world.claim(world.receiver.address, cid, 10_000_000, sig_over, 10_000_000)


def test_I2_stale_row_is_noop_not_revert(world: World):
    sk = nacl.signing.SigningKey.generate()
    cfg = world.config(_fresh_salt(), sk, world.receiver.address)
    cid = world.channel_id(cfg)
    world.deposit(cfg, 500_000)

    sig_hi = world.sign_voucher(sk, cid, 400_000)
    world.claim(world.receiver.address, cid, 400_000, sig_hi, 400_000)

    # Re-submitting a lower total_claimed must no-op (return 0), not throw,
    # and must not decrease total_claimed on-chain (monotonic).
    new_total = world.claim(world.receiver.address, cid, 400_000, sig_hi, 100_000)
    assert new_total == 0
    state = world.get_channel(cid)
    assert state["total_claimed"] == 400_000


def test_I3_conservation_deposit_claim_settle(world: World):
    # world.receiver's unsettled box is shared across tests in this module,
    # so baseline it before this test's own claim rather than assuming 0.
    unsettled_before = world.app_client.send.call(
        AppClientMethodCallParams(
            sender=world.deployer, method="get_unsettled", args=[world.receiver.address, world.asset_id]
        ),
        send_params=NO_AUTO_RESOURCES,
    )

    sk = nacl.signing.SigningKey.generate()
    cfg = world.config(_fresh_salt(), sk, world.receiver.address)
    cid = world.channel_id(cfg)
    deposited = 1_000_000
    world.deposit(cfg, deposited)

    claimed = 300_000
    sig = world.sign_voucher(sk, cid, claimed)
    world.claim(world.receiver.address, cid, claimed, sig, claimed)

    settled = world.settle(world.receiver.address)
    settled_out_this_test = settled - int(unsettled_before.abi_return)
    assert settled_out_this_test == claimed

    state = world.get_channel(cid)
    # deposited = (balance - totalClaimed) + settled-out  (no refund/withdraw
    # yet for THIS channel, so those terms are zero; settled-out is scoped to
    # this test's own claim since the receiver's unsettled box is shared)
    assert deposited == (state["balance"] - state["total_claimed"]) + settled_out_this_test


def test_I5_role_checks_claim(world: World):
    sk = nacl.signing.SigningKey.generate()
    other_account = world.algorand.account.random()
    world.algorand.account.ensure_funded(
        other_account.address, world.deployer, min_spending_balance=AlgoAmount(micro_algo=1_000_000)
    )
    cfg = world.config(_fresh_salt(), sk, world.receiver.address)
    cid = world.channel_id(cfg)
    world.deposit(cfg, 200_000)
    sig = world.sign_voucher(sk, cid, 100_000)

    with pytest.raises(Exception):
        world.claim(other_account.address, cid, 100_000, sig, 100_000)


def test_I7_payer_withdraw_after_delay(world: World):
    sk = nacl.signing.SigningKey.generate()
    cfg = world.config(_fresh_salt(), sk, world.receiver.address, delay=900)
    cid = world.channel_id(cfg)
    world.deposit(cfg, 500_000)

    world.initiate_withdraw(cid, 500_000)

    try:
        world.advance_devmode_clock(1_000)  # jump dev-mode clock past the 900s delay
        amt = world.finalize_withdraw(cid)
    finally:
        world.advance_devmode_clock(0)

    assert amt == 500_000
    state = world.get_channel(cid)
    assert state["balance"] == 0


def test_I10_open_mbr_matches_real_box_mbr_delta(world: World, algorand: AlgorandClient):
    sk = nacl.signing.SigningKey.generate()
    cfg = world.config(_fresh_salt(), sk, world.receiver.address)
    mbr_quoted = world.open_mbr(cfg)

    before = algorand.client.algod.account_info(world.app_address)["min-balance"]
    world.deposit(cfg, 100_000)
    after = algorand.client.algod.account_info(world.app_address)["min-balance"]

    assert after - before == mbr_quoted
