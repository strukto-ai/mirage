from mirage.accessor.base import Accessor
from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.core.databricks_volume.client import HttpDatabricksFilesClient
from mirage.resource.databricks_volume import (DatabricksVolumeConfig,
                                               StaticTokenProvider)


def make_config(**overrides) -> DatabricksVolumeConfig:
    return DatabricksVolumeConfig(host="https://example.cloud.databricks.com",
                                  catalog="main",
                                  schema="default",
                                  volume="agent_files",
                                  **overrides)


def test_accessor_holds_the_config_and_the_client():
    config = make_config()
    client = HttpDatabricksFilesClient(config, StaticTokenProvider("secret"))
    accessor = DatabricksVolumeAccessor(config, client)

    assert isinstance(accessor, Accessor)
    assert accessor.config is config
    assert accessor.client is client


def test_accessor_keeps_no_token_of_its_own():
    config = make_config()
    accessor = DatabricksVolumeAccessor(
        config, HttpDatabricksFilesClient(config,
                                          StaticTokenProvider("secret")))

    assert not hasattr(accessor, "token")
    assert "secret" not in repr(vars(accessor))


def test_client_reads_the_configured_timeout():
    config = make_config(timeout=17)
    client = HttpDatabricksFilesClient(config, StaticTokenProvider("secret"))

    assert client.config.timeout == 17
