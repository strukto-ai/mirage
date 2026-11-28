import pytest

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.vfs.databricks_volume import DatabricksVolumeConfig
from tests.fixtures.databricks_volume import ROOT, DatabricksVolume, volume

__all__ = ["volume"]


@pytest.fixture
def databricks_config() -> DatabricksVolumeConfig:
    return DatabricksVolumeConfig(
        catalog="main",
        schema="default",
        volume="agent_files",
        root_path="/root",
        host="https://dbc.example.com",
        token="secret",
    )


@pytest.fixture
def remote_root() -> str:
    return ROOT


@pytest.fixture
def accessor(volume: DatabricksVolume) -> DatabricksVolumeAccessor:
    return volume.accessor()
