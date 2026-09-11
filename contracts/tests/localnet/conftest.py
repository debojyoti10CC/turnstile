"""Shared fixtures for LocalNet (real-node) tests.

These tests exercise the deployed contract over algod/indexer instead of the
algorand-python-testing emulator. They require `algokit localnet start`
(Docker) to be running. If LocalNet is unreachable, every test in this
directory is skipped (not failed) so offline CI stays green.
"""
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

import pytest

try:
    from algokit_utils import AlgorandClient

    _algorand = AlgorandClient.default_localnet()
    _algorand.client.algod.status()
    LOCALNET_UP = True
except Exception:
    _algorand = None
    LOCALNET_UP = False


_HERE = pathlib.Path(__file__).resolve().parent


def pytest_collection_modifyitems(config, items):
    if LOCALNET_UP:
        return
    skip_localnet = pytest.mark.skip(reason="LocalNet is not reachable (docker/algokit localnet start)")
    for item in items:
        if _HERE in pathlib.Path(str(item.fspath)).resolve().parents:
            item.add_marker(skip_localnet)


@pytest.fixture(scope="session")
def algorand():
    if not LOCALNET_UP:
        pytest.skip("LocalNet is not reachable")
    return _algorand
