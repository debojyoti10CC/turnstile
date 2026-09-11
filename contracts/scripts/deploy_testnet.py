"""Deploy X402BatchSettlement to Algorand TestNet.

Idempotent two-step flow, safe to rerun:

1. No deployer mnemonic on disk yet -> generate a fresh account, save its
   mnemonic to the gitignored `contracts/.env.testnet` (never printed, never
   committed -- see CLAUDE.md rule 6), print its address, and exit. The
   operator funds that address from the public TestNet dispenser
   (https://bank.testnet.algorand.network/) and reruns this script.
2. Deployer mnemonic present but balance too low -> print the address and
   the amount still needed, exit. Rerun after topping up.
3. Deployer funded -> create a mock 6-decimal USDC-like ASA (unless
   TESTNET_ASSET_ID is set, to reuse an existing one), deploy the app, fund
   its MBR, opt it into the asset, then carve out and fund a payer + receiver
   sub-account from the deployer's own balance (their mnemonics are appended
   to the same gitignored file). Prints a JSON summary to stdout.

Run with: `python contracts/scripts/deploy_testnet.py` (from repo root or
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
    AssetCreateParams,
    AssetOptInParams,
    AssetTransferParams,
    FundAppAccountParams,
    PaymentParams,
)
from algosdk import account as algosdk_account
from algosdk import mnemonic as algosdk_mnemonic

ARTIFACTS = pathlib.Path(__file__).resolve().parents[1] / "smart_contracts" / "x402_batch_settlement" / "artifacts"
ARC56_PATH = ARTIFACTS / "X402BatchSettlement.arc56.json"
ENV_PATH = pathlib.Path(__file__).resolve().parents[1] / ".env.testnet"

APP_BASE_MBR = 100_000
ASSET_OPT_IN_MBR = 100_000
# Deployer needs: app creation fee + APP_BASE_MBR + ASSET_OPT_IN_MBR + asset
# creation fee/MBR + opt-in call fee + funding two sub-accounts (2 ALGO each,
# which covers their own asset-opt-in MBR and transaction fees) + headroom.
MIN_DEPLOYER_BALANCE_MICRO_ALGO = 1_000_000
SUB_ACCOUNT_FUNDING_MICRO_ALGO = 2_000_000


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
            app_name="X402BatchSettlement-testnet",
            default_sender=deployer_address,
        )
    )


def deploy_testnet() -> dict:
    algorand = AlgorandClient.testnet()
    env = _read_env_file()

    deployer_mnemonic = env.get("DEPLOYER_MNEMONIC") or os.environ.get("DEPLOYER_MNEMONIC")
    if not deployer_mnemonic:
        sk = algosdk_account.generate_account()[0]
        deployer_mnemonic = algosdk_mnemonic.from_private_key(sk)
        deployer_address = algosdk_account.address_from_private_key(sk)
        _append_env_file("DEPLOYER_MNEMONIC", deployer_mnemonic)
        print(json.dumps({
            "status": "needs_funding",
            "deployer_address": deployer_address,
            "instructions": (
                f"Fund {deployer_address} with at least "
                f"{MIN_DEPLOYER_BALANCE_MICRO_ALGO / 1_000_000:.0f} ALGO via "
                "https://bank.testnet.algorand.network/ (paste the address), "
                "then rerun this script. The mnemonic was saved to "
                f"{ENV_PATH} (gitignored) -- do not share or commit it."
            ),
        }, indent=2))
        return {"status": "needs_funding"}

    deployer = algorand.account.from_mnemonic(mnemonic=deployer_mnemonic)
    balance = algorand.account.get_information(deployer.address).amount.micro_algo
    if balance < MIN_DEPLOYER_BALANCE_MICRO_ALGO:
        print(json.dumps({
            "status": "needs_funding",
            "deployer_address": deployer.address,
            "current_balance_micro_algo": balance,
            "instructions": (
                f"Balance is {balance} microALGO; need at least "
                f"{MIN_DEPLOYER_BALANCE_MICRO_ALGO}. Top up via "
                "https://bank.testnet.algorand.network/ and rerun."
            ),
        }, indent=2))
        return {"status": "needs_funding"}

    algorand.account.set_signer_from_account(deployer)

    existing_asset_id = env.get("TESTNET_ASSET_ID") or os.environ.get("TESTNET_ASSET_ID")
    if existing_asset_id:
        asset_id = int(existing_asset_id)
    else:
        asset_create = algorand.send.asset_create(
            AssetCreateParams(
                sender=deployer.address,
                total=10_000_000_000_000,
                decimals=6,
                asset_name="Mock USDC",
                unit_name="mUSDC",
            )
        )
        asset_id = asset_create.confirmation["asset-index"]
        _append_env_file("TESTNET_ASSET_ID", str(asset_id))

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

    def _carve_out_account(role: str) -> tuple:
        existing = env.get(f"{role.upper()}_MNEMONIC") or os.environ.get(f"{role.upper()}_MNEMONIC")
        if existing:
            acct = algorand.account.from_mnemonic(mnemonic=existing)
        else:
            sk = algosdk_account.generate_account()[0]
            new_mnemonic = algosdk_mnemonic.from_private_key(sk)
            _append_env_file(f"{role.upper()}_MNEMONIC", new_mnemonic)
            acct = algorand.account.from_mnemonic(mnemonic=new_mnemonic)
        algorand.account.ensure_funded(
            acct.address,
            deployer,
            min_spending_balance=AlgoAmount(micro_algo=SUB_ACCOUNT_FUNDING_MICRO_ALGO),
        )
        return acct

    payer = _carve_out_account("payer")
    receiver = _carve_out_account("receiver")

    for acct in (payer, receiver):
        info = algorand.account.get_information(acct.address)
        already_opted_in = any(a["asset-id"] == asset_id for a in (info.assets or []))
        if not already_opted_in:
            algorand.send.asset_opt_in(AssetOptInParams(sender=acct.address, asset_id=asset_id))

    algorand.send.asset_transfer(
        AssetTransferParams(
            sender=deployer.address,
            receiver=payer.address,
            asset_id=asset_id,
            amount=1_000_000_000,
        )
    )

    return {
        "status": "deployed",
        "network": "testnet",
        "app_id": app_id,
        "app_address": app_address,
        "asset_id": asset_id,
        "deployer": deployer.address,
        "payer": payer.address,
        "receiver": receiver.address,
        "mnemonics_written_to": str(ENV_PATH),
    }


if __name__ == "__main__":
    summary = deploy_testnet()
    json.dump(summary, sys.stdout, indent=2)
    print()
