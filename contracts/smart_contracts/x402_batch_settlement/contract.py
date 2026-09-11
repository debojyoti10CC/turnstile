"""x402 `batch-settlement` binding for the Algorand Virtual Machine (AVM).

Capital-backed, unidirectional payment channels. Mirrors the EVM binding
(specs/schemes/batch-settlement/scheme_batch_settlement_evm.md) with AVM-native
choices: ed25519 vouchers verified with ed25519verify_bare, ASA escrow held by
the application account, box storage per channel.

Design decisions (see docs/spec/scheme_batch_settlement_avm.md):
- Channel boxes are NEVER deleted. total_claimed must survive a drain + re-fund,
  otherwise old vouchers could be replayed against a re-opened channel.
- claim() only updates accounting; settle() sweeps a receiver's claimed funds
  for one asset in a single inner transfer (batch-friendly).
- Vouchers carry no expiry; the withdraw delay bounds the redemption window.
"""

import typing as t

from algopy import (
    Account,
    ARC4Contract,
    Asset,
    BoxMap,
    Bytes,
    Global,
    OpUpFeeSource,
    Txn,
    UInt64,
    arc4,
    ensure_budget,
    gtxn,
    itxn,
    op,
    size_of,
    subroutine,
    urange,
)

Bytes32: t.TypeAlias = arc4.StaticArray[arc4.Byte, t.Literal[32]]
Bytes64: t.TypeAlias = arc4.StaticArray[arc4.Byte, t.Literal[64]]

VOUCHER_PREFIX = b"x402-avm-bs-voucher-v1"
CHANNEL_PREFIX = b"x402-avm-bs-channel-v1"
MIN_WITHDRAW_DELAY = 900  # 15 minutes, same bound as EVM/SVM bindings
MAX_WITHDRAW_DELAY = 2_592_000  # 30 days
BOX_FLAT_MBR = 2_500
BOX_BYTE_MBR = 400
ASSET_OPT_IN_MBR = 100_000
ED25519_COST = 1_900
PER_ROW_OVERHEAD = 700


class ChannelConfig(arc4.Struct, frozen=True):
    payer: arc4.Address
    payer_authorizer: arc4.Address  # ed25519 public key that signs vouchers
    receiver: arc4.Address  # payTo
    receiver_authorizer: arc4.Address  # account allowed to claim / refund
    asset: arc4.UInt64
    withdraw_delay: arc4.UInt64  # seconds
    salt: Bytes32


class ChannelState(arc4.Struct):
    config: ChannelConfig
    balance: arc4.UInt64  # deposited - withdrawn - refunded
    total_claimed: arc4.UInt64  # cumulative, monotonic
    withdraw_requested_at: arc4.UInt64  # unix seconds, 0 if none
    withdraw_amount: arc4.UInt64


class Claim(arc4.Struct, frozen=True):
    channel_id: Bytes32
    max_claimable: arc4.UInt64
    signature: Bytes64
    total_claimed: arc4.UInt64


class ChannelView(arc4.Struct, frozen=True):
    balance: arc4.UInt64
    total_claimed: arc4.UInt64
    withdraw_requested_at: arc4.UInt64
    withdraw_amount: arc4.UInt64


class X402BatchSettlement(ARC4Contract):
    def __init__(self) -> None:
        self.channels = BoxMap(Bytes, ChannelState, key_prefix=b"c")
        self.unsettled = BoxMap(Bytes, UInt64, key_prefix=b"u")

    # ------------------------------------------------------------------ setup
    @arc4.abimethod
    def opt_in_asset(self, asset: Asset, mbr: gtxn.PaymentTransaction) -> None:
        """Permissionless: anyone may pay the MBR to let the escrow hold an ASA."""
        assert not Global.current_application_address.is_opted_in(asset), "already opted in"
        assert mbr.receiver == Global.current_application_address, "mbr receiver"
        assert mbr.amount >= ASSET_OPT_IN_MBR, "mbr amount"
        itxn.AssetTransfer(
            xfer_asset=asset,
            asset_receiver=Global.current_application_address,
            asset_amount=0,
            fee=0,
        ).submit()

    # --------------------------------------------------------------- views
    @arc4.abimethod(readonly=True)
    def channel_id(self, config: ChannelConfig) -> Bytes32:
        return Bytes32.from_bytes(self._channel_id(config))

    @arc4.abimethod(readonly=True)
    def voucher_message(self, channel_id: Bytes32, max_claimable: arc4.UInt64) -> arc4.DynamicBytes:
        return arc4.DynamicBytes(self._voucher_message(channel_id.bytes, max_claimable.as_uint64()))

    @arc4.abimethod(readonly=True)
    def get_channel(self, channel_id: Bytes32) -> ChannelView:
        st = self.channels[channel_id.bytes].copy()
        return ChannelView(
            balance=st.balance,
            total_claimed=st.total_claimed,
            withdraw_requested_at=st.withdraw_requested_at,
            withdraw_amount=st.withdraw_amount,
        )

    @arc4.abimethod(readonly=True)
    def get_unsettled(self, receiver: Account, asset: Asset) -> UInt64:
        return self.unsettled.get(self._unsettled_key(receiver, asset), default=UInt64(0))

    @arc4.abimethod(readonly=True)
    def open_mbr(self, config: ChannelConfig) -> UInt64:
        return self._open_mbr(config)

    # ------------------------------------------------------------- deposits
    @arc4.abimethod
    def deposit(
        self,
        config: ChannelConfig,
        xfer: gtxn.AssetTransferTransaction,
        mbr: gtxn.PaymentTransaction,
    ) -> Bytes32:
        """Create the channel on first deposit, top it up afterwards.

        The app-call sender may be anyone (e.g. a fee-paying facilitator); the
        asset transfer MUST be signed by config.payer. When the channel box (or
        the receiver's unsettled box) does not exist yet, `mbr` must cover it;
        otherwise `mbr` may be a 0-amount payment.
        """
        cid = self._channel_id(config)
        self._check_deposit_xfer(config, xfer)
        assert mbr.receiver == Global.current_application_address, "mbr receiver"
        assert mbr.amount >= self._open_mbr(config), "mbr amount"

        if cid in self.channels:
            st = self.channels[cid].copy()
            assert st.config == config, "config mismatch"
            st.balance = arc4.UInt64(st.balance.as_uint64() + xfer.asset_amount)
            self.channels[cid] = st.copy()
        else:
            delay = config.withdraw_delay.as_uint64()
            assert delay >= MIN_WITHDRAW_DELAY and delay <= MAX_WITHDRAW_DELAY, "withdraw delay range"
            assert config.payer != config.receiver, "payer == receiver"
            self.channels[cid] = ChannelState(
                config=config.copy(),
                balance=arc4.UInt64(xfer.asset_amount),
                total_claimed=arc4.UInt64(0),
                withdraw_requested_at=arc4.UInt64(0),
                withdraw_amount=arc4.UInt64(0),
            )
            ukey = self._unsettled_key(config.receiver.native, Asset(config.asset.as_uint64()))
            if ukey not in self.unsettled:
                self.unsettled[ukey] = UInt64(0)
        return Bytes32.from_bytes(cid)

    # ---------------------------------------------------------------- claims
    @arc4.abimethod
    def claim(self, claims: arc4.DynamicArray[Claim]) -> UInt64:
        """Batch-claim vouchers. Accounting only; funds move in settle().

        Rows whose total_claimed does not exceed the on-chain value are no-ops,
        so a settler can safely retry a batch.
        Returns the total newly claimed amount.
        """
        n = claims.length
        ensure_budget(n * (ED25519_COST + PER_ROW_OVERHEAD), OpUpFeeSource.GroupCredit)
        total = UInt64(0)
        for i in urange(n):
            row = claims[i].copy()
            cid = row.channel_id.bytes
            st = self.channels[cid].copy()
            cfg = st.config.copy()
            assert (
                Txn.sender == cfg.receiver_authorizer.native or Txn.sender == cfg.receiver.native
            ), "not receiver"
            max_c = row.max_claimable.as_uint64()
            new_total = row.total_claimed.as_uint64()
            assert new_total <= max_c, "total > max_claimable"
            assert max_c <= st.balance.as_uint64(), "max_claimable > balance"
            if new_total > st.total_claimed.as_uint64():
                msg = self._voucher_message(cid, max_c)
                assert op.ed25519verify_bare(msg, row.signature.bytes, cfg.payer_authorizer.bytes), "bad voucher sig"
                delta = new_total - st.total_claimed.as_uint64()
                st.total_claimed = arc4.UInt64(new_total)
                self.channels[cid] = st.copy()
                ukey = self._unsettled_key(cfg.receiver.native, Asset(cfg.asset.as_uint64()))
                self.unsettled[ukey] += delta
                total += delta
        return total

    @arc4.abimethod
    def settle(self, receiver: Account, asset: Asset) -> UInt64:
        """Permissionless sweep of claimed funds to the receiver."""
        ukey = self._unsettled_key(receiver, asset)
        amount = self.unsettled[ukey]
        assert amount > 0, "nothing to settle"
        self.unsettled[ukey] = UInt64(0)
        itxn.AssetTransfer(xfer_asset=asset, asset_receiver=receiver, asset_amount=amount, fee=0).submit()
        return amount

    # ----------------------------------------------------- refunds / exits
    @arc4.abimethod
    def refund(self, channel_id: Bytes32, amount: UInt64) -> UInt64:
        """Cooperative refund by the receiver side. Caps to unclaimed escrow."""
        cid = channel_id.bytes
        st = self.channels[cid].copy()
        cfg = st.config.copy()
        assert (
            Txn.sender == cfg.receiver_authorizer.native or Txn.sender == cfg.receiver.native
        ), "not receiver"
        available = st.balance.as_uint64() - st.total_claimed.as_uint64()
        amt = amount if amount < available else available
        assert amt > 0, "refund no balance"
        st.balance = arc4.UInt64(st.balance.as_uint64() - amt)
        # cap (or cancel) a pending timed withdrawal to what is still unclaimed
        if st.withdraw_requested_at.as_uint64() > 0:
            left = st.balance.as_uint64() - st.total_claimed.as_uint64()
            if left == 0:
                st.withdraw_requested_at = arc4.UInt64(0)
                st.withdraw_amount = arc4.UInt64(0)
            elif st.withdraw_amount.as_uint64() > left:
                st.withdraw_amount = arc4.UInt64(left)
        self.channels[cid] = st.copy()
        self._pay(cfg.payer.native, cfg.asset.as_uint64(), amt)
        return amt

    @arc4.abimethod
    def initiate_withdraw(self, channel_id: Bytes32, amount: UInt64) -> UInt64:
        cid = channel_id.bytes
        st = self.channels[cid].copy()
        cfg = st.config.copy()
        self._assert_payer_side(cfg)
        available = st.balance.as_uint64() - st.total_claimed.as_uint64()
        assert amount > 0 and amount <= available, "withdraw amount"
        st.withdraw_requested_at = arc4.UInt64(Global.latest_timestamp)
        st.withdraw_amount = arc4.UInt64(amount)
        self.channels[cid] = st.copy()
        return Global.latest_timestamp + cfg.withdraw_delay.as_uint64()

    @arc4.abimethod
    def finalize_withdraw(self, channel_id: Bytes32) -> UInt64:
        cid = channel_id.bytes
        st = self.channels[cid].copy()
        cfg = st.config.copy()
        self._assert_payer_side(cfg)
        requested = st.withdraw_requested_at.as_uint64()
        assert requested > 0, "no withdraw pending"
        assert Global.latest_timestamp >= requested + cfg.withdraw_delay.as_uint64(), "withdraw delay"
        available = st.balance.as_uint64() - st.total_claimed.as_uint64()
        want = st.withdraw_amount.as_uint64()
        amt = want if want < available else available
        st.balance = arc4.UInt64(st.balance.as_uint64() - amt)
        st.withdraw_requested_at = arc4.UInt64(0)
        st.withdraw_amount = arc4.UInt64(0)
        self.channels[cid] = st.copy()
        if amt > 0:
            self._pay(cfg.payer.native, cfg.asset.as_uint64(), amt)
        return amt

    # ------------------------------------------------------------- helpers
    @subroutine
    def _channel_id(self, config: ChannelConfig) -> Bytes:
        return op.sha256(
            Bytes(CHANNEL_PREFIX)
            + Global.genesis_hash
            + op.itob(Global.current_application_id.id)
            + config.bytes
        )

    @subroutine
    def _voucher_message(self, cid: Bytes, max_claimable: UInt64) -> Bytes:
        return (
            Bytes(VOUCHER_PREFIX)
            + Global.genesis_hash
            + op.itob(Global.current_application_id.id)
            + cid
            + op.itob(max_claimable)
        )

    @subroutine
    def _unsettled_key(self, receiver: Account, asset: Asset) -> Bytes:
        return receiver.bytes + op.itob(asset.id)

    @subroutine
    def _open_mbr(self, config: ChannelConfig) -> UInt64:
        required = UInt64(0)
        cid = self._channel_id(config)
        if cid not in self.channels:
            required += BOX_FLAT_MBR + BOX_BYTE_MBR * (1 + 32 + size_of(ChannelState))
        ukey = self._unsettled_key(config.receiver.native, Asset(config.asset.as_uint64()))
        if ukey not in self.unsettled:
            required += BOX_FLAT_MBR + BOX_BYTE_MBR * (1 + 40 + 8)
        return required

    @subroutine
    def _check_deposit_xfer(self, config: ChannelConfig, xfer: gtxn.AssetTransferTransaction) -> None:
        assert xfer.xfer_asset.id == config.asset.as_uint64(), "asset mismatch"
        assert xfer.asset_receiver == Global.current_application_address, "xfer receiver"
        assert xfer.sender == config.payer.native, "xfer sender != payer"
        assert xfer.asset_amount > 0, "zero deposit"
        assert xfer.asset_close_to == Global.zero_address, "close_to set"
        assert xfer.rekey_to == Global.zero_address, "rekey set"
        assert xfer.asset_sender == Global.zero_address, "clawback not allowed"

    @subroutine
    def _assert_payer_side(self, cfg: ChannelConfig) -> None:
        assert Txn.sender == cfg.payer.native or Txn.sender == cfg.payer_authorizer.native, "not payer"

    @subroutine
    def _pay(self, receiver: Account, asset_id: UInt64, amount: UInt64) -> None:
        itxn.AssetTransfer(
            xfer_asset=Asset(asset_id), asset_receiver=receiver, asset_amount=amount, fee=0
        ).submit()
