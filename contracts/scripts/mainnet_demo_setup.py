"""Set up a payer + receiver account for a real MainNet demo transaction trail.

Real money, small amounts. Idempotent, safe to rerun.

1. Reads the deployer mnemonic from `contracts/.env.mainnet` (must already
   exist -- run `deploy_mainnet.py` first).
2. Generates (or reuses) PAYER_MNEMONIC / RECEIVER_MNEMONIC in the same
   gitignored file -- fresh keys, never touching any existing wallet.
3. Funds each with a small amount of ALGO from the deployer's own leftover
   balance (no new ALGO needed from the operator) and opts each into real
   Circle USDC (MainNet ASA 31566704), if not already done.
4. Exits with `needs_usdc` and the payer's address until the payer holds at
   least a small amount of real USDC, which the operator sends themselves
   from their own wallet -- this script never trades, swaps, or acquires
   USDC on anyone's behalf.

Run with: `python contracts/scripts/mainnet_demo_setup.py`
"""
from __future__ import annotations

import json
import os
import pathlib
import sys

from algokit_utils import (
    AlgoAmount,
    AlgorandClient,
    AssetOptInParams,
    PaymentParams,
)
from algosdk import account as algosdk_account
from algosdk import mnemonic as algosdk_mnemonic

ENV_PATH = pathlib.Path(__file__).resolve().parents[1] / ".env.mainnet"
USDC_ASSET_ID = 31566704

# Each needs 0.1 ALGO base min-balance + 0.1 ALGO for one ASA opt-in = 0.2
# ALGO real floor; funded slightly above that for txn fee headroom.
PAYER_FUNDING_MICRO_ALGO = 250_000
RECEIVER_FUNDING_MICRO_ALGO = 230_000
# Smallest amount worth demonstrating a real deposit + several vouchers +
# claim + settle with, in USDC atomic units (6 decimals) -- 1.00 USDC.
MIN_PAYER_USDC_ATOMIC = 1_000_000


def _read_env_file() -> dict[str, str]:
    if not ENV_PATH.exists():
        return {}
    out: dict[str, str] = {}
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip()
    return out


def _append_env_file(key: str, value: str) -> None:
    with ENV_PATH.open("a") as f:
        f.write(f"{key}={value}\n")


def _get_or_create_account(algorand: AlgorandClient, env: dict[str, str], role: str):
    key = f"{role.upper()}_MNEMONIC"
    existing = env.get(key) or os.environ.get(key)
    if existing:
        return algorand.account.from_mnemonic(mnemonic=existing)
    sk = algosdk_account.generate_account()[0]
    new_mnemonic = algosdk_mnemonic.from_private_key(sk)
    _append_env_file(key, new_mnemonic)
    return algorand.account.from_mnemonic(mnemonic=new_mnemonic)


def setup() -> dict:
    if not ENV_PATH.exists():
        print(json.dumps({"status": "error", "message": f"{ENV_PATH} not found -- run deploy_mainnet.py first"}, indent=2))
        return {"status": "error"}

    algorand = AlgorandClient.mainnet()
    env = _read_env_file()

    deployer_mnemonic = env.get("DEPLOYER_MNEMONIC")
    if not deployer_mnemonic:
        print(json.dumps({"status": "error", "message": "DEPLOYER_MNEMONIC missing from .env.mainnet"}, indent=2))
        return {"status": "error"}
    deployer = algorand.account.from_mnemonic(mnemonic=deployer_mnemonic)
    algorand.account.set_signer_from_account(deployer)

    payer = _get_or_create_account(algorand, env, "payer")
    receiver = _get_or_create_account(algorand, env, "receiver")
    algorand.account.set_signer_from_account(payer)
    algorand.account.set_signer_from_account(receiver)

    for acct, target_micro_algo in ((payer, PAYER_FUNDING_MICRO_ALGO), (receiver, RECEIVER_FUNDING_MICRO_ALGO)):
        info = algorand.account.get_information(acct.address)
        if info.amount.micro_algo < target_micro_algo:
            algorand.send.payment(
                PaymentParams(
                    sender=deployer.address,
                    receiver=acct.address,
                    amount=AlgoAmount(micro_algo=target_micro_algo - info.amount.micro_algo),
                )
            )

    for acct in (payer, receiver):
        info = algorand.account.get_information(acct.address)
        already_opted_in = any(a["asset-id"] == USDC_ASSET_ID for a in (info.assets or []))
        if not already_opted_in:
            algorand.send.asset_opt_in(AssetOptInParams(sender=acct.address, asset_id=USDC_ASSET_ID))

    payer_info = algorand.account.get_information(payer.address)
    payer_usdc = next((a["amount"] for a in (payer_info.assets or []) if a["asset-id"] == USDC_ASSET_ID), 0)

    deployer_balance = algorand.account.get_information(deployer.address).amount.micro_algo

    if payer_usdc < MIN_PAYER_USDC_ATOMIC:
        print(json.dumps({
            "status": "needs_usdc",
            "payer_address": payer.address,
            "receiver_address": receiver.address,
            "payer_current_usdc_atomic": payer_usdc,
            "usdc_needed_atomic": MIN_PAYER_USDC_ATOMIC,
            "deployer_remaining_micro_algo": deployer_balance,
            "instructions": (
                f"Payer and receiver accounts are funded with ALGO and opted into USDC. "
                f"Send at least {MIN_PAYER_USDC_ATOMIC / 1_000_000:.2f} USDC (real Circle USDC, "
                f"asset {USDC_ASSET_ID}) to {payer.address} from your own wallet, then rerun this "
                "script, or proceed straight to the demo script once it lands."
            ),
        }, indent=2))
        return {"status": "needs_usdc"}

    print(json.dumps({
        "status": "ready",
        "payer_address": payer.address,
        "receiver_address": receiver.address,
        "payer_usdc_atomic": payer_usdc,
        "deployer_remaining_micro_algo": deployer_balance,
    }, indent=2))
    return {"status": "ready"}


if __name__ == "__main__":
    summary = setup()
    json.dump(summary, sys.stdout, indent=2)
    print()
