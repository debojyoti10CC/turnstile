"""Deploy X402BatchSettlement to LocalNet (or any configured network).

- Creates the app from the committed ARC-56 artifact (no recompile needed).
- Funds the app account with base MBR + asset-opt-in MBR.
- Calls opt_in_asset(asset) so the escrow can hold the settlement asset.
- On LocalNet only: creates a mock 6-decimal "USDC" ASA and funds a payer +
  receiver test account with ALGO and the mock asset (opted in).

Run with: `python contracts/scripts/deploy.py` (from repo root or contracts/).
Prints a JSON summary (app_id, asset_id, account addresses) to stdout so other
scripts/tests can consume it.
"""
from __future__ import annotations

import json
import pathlib
import secrets
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

ARTIFACTS = pathlib.Path(__file__).resolve().parents[1] / "smart_contracts" / "x402_batch_settlement" / "artifacts"
ARC56_PATH = ARTIFACTS / "X402BatchSettlement.arc56.json"

APP_BASE_MBR = 100_000  # 0.1 ALGO base reserve for a bare account holding boxes
ASSET_OPT_IN_MBR = 100_000


def _get_factory(algorand: AlgorandClient, deployer_address: str) -> AppFactory:
    app_spec = json.loads(ARC56_PATH.read_text())
    # Unique app_name per call sidesteps AppFactory.deploy()'s update/replace
    # lookup entirely -- this script always creates a brand new app instance
    # (LocalNet test isolation; a real deploy would use a stable name).
    return AppFactory(
        AppFactoryParams(
            algorand=algorand,
            app_spec=json.dumps(app_spec),
            app_name=f"X402BatchSettlement-{secrets.token_hex(4)}",
            default_sender=deployer_address,
        )
    )


def deploy_localnet() -> dict:
    algorand = AlgorandClient.default_localnet()
    deployer = algorand.account.localnet_dispenser()
    payer = algorand.account.random()
    receiver = algorand.account.random()

    algorand.account.ensure_funded(payer.address, deployer, min_spending_balance=AlgoAmount(micro_algo=1_000_000_000))
    algorand.account.ensure_funded(receiver.address, deployer, min_spending_balance=AlgoAmount(micro_algo=1_000_000_000))

    asset_create = algorand.send.asset_create(
        AssetCreateParams(
            sender=deployer.address,
            total=10_000_000_000_000,  # 10M units at 6 decimals
            decimals=6,
            asset_name="Mock USDC",
            unit_name="mUSDC",
        )
    )
    asset_id = asset_create.confirmation["asset-index"]

    factory = _get_factory(algorand, deployer.address)
    app_client, deploy_result = factory.deploy()
    app_id = app_client.app_id
    app_address = app_client.app_address

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
            extra_fee=AlgoAmount(micro_algo=1_000),  # pools fee for the inner 0-fee AssetTransfer
        )
    )

    for acct in (payer, receiver):
        algorand.send.asset_opt_in(AssetOptInParams(sender=acct.address, asset_id=asset_id))

    algorand.send.asset_transfer(
        AssetTransferParams(
            sender=deployer.address,
            receiver=payer.address,
            asset_id=asset_id,
            amount=1_000_000_000,  # 1,000 mUSDC
        )
    )

    return {
        "app_id": app_id,
        "app_address": app_address,
        "asset_id": asset_id,
        "deployer": deployer.address,
        "payer": payer.address,
        "payer_private_key": payer.private_key,
        "receiver": receiver.address,
        "receiver_private_key": receiver.private_key,
    }


if __name__ == "__main__":
    summary = deploy_localnet()
    json.dump(summary, sys.stdout, indent=2)
    print()
