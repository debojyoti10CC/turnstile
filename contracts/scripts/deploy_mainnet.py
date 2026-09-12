"""Deploy X402BatchSettlement to Algorand MainNet.

This is REAL MONEY. Read this before running it.

Idempotent flow, safe to rerun -- each step checks on-chain state before
acting, so a rerun after a partial failure just picks up where it left off:

1. No deployer mnemonic on disk yet -> generate a fresh account, save its
   mnemonic to the gitignored `contracts/.env.mainnet` (never printed, never
   committed -- CLAUDE.md rule 6), print its address and the exact amount to
   fund it with, and exit. Fund that address yourself, from your own wallet,
   by sending ALGO to the printed address -- this script never asks for or
   touches an existing wallet's mnemonic or private key.
2. Deployer mnemonic present but balance too low -> print the address and
   the amount still needed, exit. Rerun after topping up.
3. Deployer funded, but MAINNET_DEPLOY_CONFIRM=yes is not set -> refuses to
   deploy and explains why (a second, explicit opt-in specifically for
   MainNet, separate from just having funded the address).
4. Deployer funded and confirmed -> deploys the app from the already-tested,
   already-committed ARC-56 artifact (no recompile), funds its MBR, and
   opts it into real Circle USDC (MainNet ASA 31566704, @turnstile/core's
   USDC_ASA_ID.mainnet). Prints a JSON summary. Does NOT create any test
   accounts, does NOT move any USDC, and does NOT open a channel -- this
   script's only job is getting the contract itself live on-chain.

Run with: `python contracts/scripts/deploy_mainnet.py` (from repo root or
contracts/).
"""
from __future__ import annotations

import json
import os
import pathlib
import sys

from algokit_utils import (
    AlgoAmount,
    AlgorandClient,
    AppClientMethodCallParams,
    AppFactory,
    AppFactoryParams,
    FundAppAccountParams,
    PaymentParams,
)
from algosdk import account as algosdk_account
from algosdk import mnemonic as algosdk_mnemonic

ARTIFACTS = pathlib.Path(__file__).resolve().parents[1] / "smart_contracts" / "x402_batch_settlement" / "artifacts"
ARC56_PATH = ARTIFACTS / "X402BatchSettlement.arc56.json"
ENV_PATH = pathlib.Path(__file__).resolve().parents[1] / ".env.mainnet"

# Real Circle USDC on Algorand MainNet -- matches @turnstile/core's
# USDC_ASA_ID.mainnet. Override via MAINNET_ASSET_ID only if you have a
# specific reason to escrow a different ASA.
DEFAULT_MAINNET_USDC_ASSET_ID = 31566704

APP_BASE_MBR = 100_000
ASSET_OPT_IN_MBR = 100_000
# Deployer needs: its own 100_000 min-balance floor, plus the two MBR
# payments to the app account (200_000 + 100_000 -- mirrors the proven
# TestNet flow's fund_app_account + separate opt_in_asset mbr argument
# exactly, not re-derived, so nothing new is being trusted on a real-money
# deploy), plus a handful of ~1_000 microALGO txn fees. No sub-accounts are
# funded here (unlike deploy_testnet.py) -- this script only gets the
# contract itself on-chain.
MIN_DEPLOYER_BALANCE_MICRO_ALGO = 600_000


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


def _get_factory(algorand: AlgorandClient, deployer_address: str) -> AppFactory:
    app_spec = json.loads(ARC56_PATH.read_text())
    return AppFactory(
        AppFactoryParams(
            algorand=algorand,
            app_spec=json.dumps(app_spec),
            app_name="X402BatchSettlement-mainnet",
            default_sender=deployer_address,
        )
    )


def deploy_mainnet() -> dict:
    algorand = AlgorandClient.mainnet()
    env = _read_env_file()

    deployer_mnemonic = env.get("DEPLOYER_MNEMONIC") or os.environ.get("DEPLOYER_MNEMONIC")
    if not deployer_mnemonic:
        sk = algosdk_account.generate_account()[0]
        deployer_mnemonic = algosdk_mnemonic.from_private_key(sk)
        deployer_address = algosdk_account.address_from_private_key(sk)
        _append_env_file("DEPLOYER_MNEMONIC", deployer_mnemonic)
        print(json.dumps({
            "status": "needs_funding",
            "network": "mainnet",
            "deployer_address": deployer_address,
            "amount_needed_algo": MIN_DEPLOYER_BALANCE_MICRO_ALGO / 1_000_000,
            "instructions": (
                f"Send at least {MIN_DEPLOYER_BALANCE_MICRO_ALGO / 1_000_000:.2f} ALGO to "
                f"{deployer_address} from your own wallet (this is a fresh key this script "
                "generated -- it never touches your existing wallet's mnemonic or private key), "
                "then rerun this script. Breakdown: 0.1 ALGO deployer min-balance floor + "
                "0.3 ALGO app account MBR (base + USDC opt-in) + ~0.2 ALGO fee/rounding headroom. "
                f"The deployer's mnemonic was saved to {ENV_PATH} (gitignored) -- do not share "
                "or commit it; it only ever holds enough ALGO to deploy this one contract."
            ),
        }, indent=2))
        return {"status": "needs_funding"}

    deployer = algorand.account.from_mnemonic(mnemonic=deployer_mnemonic)
    balance = algorand.account.get_information(deployer.address).amount.micro_algo
    if balance < MIN_DEPLOYER_BALANCE_MICRO_ALGO:
        print(json.dumps({
            "status": "needs_funding",
            "network": "mainnet",
            "deployer_address": deployer.address,
            "current_balance_micro_algo": balance,
            "needed_micro_algo": MIN_DEPLOYER_BALANCE_MICRO_ALGO,
            "instructions": f"Top up {deployer.address} and rerun.",
        }, indent=2))
        return {"status": "needs_funding"}

    if os.environ.get("MAINNET_DEPLOY_CONFIRM") != "yes":
        print(json.dumps({
            "status": "needs_confirmation",
            "network": "mainnet",
            "deployer_address": deployer.address,
            "current_balance_micro_algo": balance,
            "instructions": (
                "Deployer is funded and ready. This script will not deploy to MainNet without "
                "an explicit, separate confirmation: rerun with MAINNET_DEPLOY_CONFIRM=yes set. "
                "This is real money and an unaudited contract -- see CLAUDE.md and "
                "docs/DECISIONS.md before setting that flag."
            ),
        }, indent=2))
        return {"status": "needs_confirmation"}

    algorand.account.set_signer_from_account(deployer)

    asset_id = int(os.environ.get("MAINNET_ASSET_ID", DEFAULT_MAINNET_USDC_ASSET_ID))

    factory = _get_factory(algorand, deployer.address)
    app_client, _deploy_result = factory.deploy()
    app_id = app_client.app_id
    app_address = app_client.app_address

    app_already_opted_in = any(
        a["asset-id"] == asset_id for a in (algorand.account.get_information(app_address).assets or [])
    )
    if not app_already_opted_in:
        app_client.send.fund_app_account(
            FundAppAccountParams(sender=deployer.address, amount=AlgoAmount(micro_algo=APP_BASE_MBR + ASSET_OPT_IN_MBR))
        )

        mbr_pay = algorand.create_transaction.payment(
            PaymentParams(sender=deployer.address, receiver=app_address, amount=AlgoAmount(micro_algo=ASSET_OPT_IN_MBR))
        )
        app_client.send.call(
            AppClientMethodCallParams(
                sender=deployer.address,
                method="opt_in_asset",
                args=[asset_id, mbr_pay],
                asset_references=[asset_id],
                extra_fee=AlgoAmount(micro_algo=1_000),
            )
        )

    return {
        "status": "deployed",
        "network": "mainnet",
        "app_id": app_id,
        "app_address": app_address,
        "asset_id": asset_id,
        "deployer": deployer.address,
        "mnemonic_written_to": str(ENV_PATH),
        "note": (
            "The contract is live and opted into USDC. No channel has been opened and no USDC "
            "has moved -- that requires a payer, a receiver, and a real USDC deposit, which is a "
            "separate, deliberate step."
        ),
    }


if __name__ == "__main__":
    summary = deploy_mainnet()
    json.dump(summary, sys.stdout, indent=2)
    print()
