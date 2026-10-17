import pytest

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.core.databricks_volume.path import backend_path
from mirage.types import PathSpec
from mirage.vfs.databricks_volume import DatabricksVolumeConfig
from tests.fixtures.databricks_api import (
    FakeFiles,
)
from tests.fixtures.databricks_api import (
    databricks_http_cleanup as databricks_http_cleanup,
)


@pytest.fixture
def files() -> FakeFiles:
    return FakeFiles()


@pytest.fixture
def databricks_config(files: FakeFiles) -> DatabricksVolumeConfig:
    return DatabricksVolumeConfig(
        catalog="main",
        schema="default",
        volume="agent_files",
        root_path="/root",
        host=files.host,
        token="secret",
    )


@pytest.fixture
def remote_root(databricks_config: DatabricksVolumeConfig) -> str:
    return backend_path(databricks_config, PathSpec.from_str_path("/"))


@pytest.fixture
def accessor(databricks_config: DatabricksVolumeConfig):
    return DatabricksVolumeAccessor(databricks_config)
