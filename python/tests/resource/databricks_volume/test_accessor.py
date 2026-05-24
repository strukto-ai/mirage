from mirage.accessor import databricks_volume as accessor_module
from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.resource.databricks_volume import DatabricksVolumeConfig


class FakeWorkspaceClient:
    calls: list[dict] = []

    def __init__(self, **kwargs) -> None:
        self.calls.append(kwargs)
        self.files = object()


class FakeWorkspaceConfig:

    def __init__(self, **kwargs) -> None:
        for key, value in kwargs.items():
            setattr(self, key, value)


def test_accessor_passes_timeout_to_workspace_client(monkeypatch):
    FakeWorkspaceClient.calls = []
    monkeypatch.setattr(
        accessor_module,
        "WorkspaceClient",
        FakeWorkspaceClient,
    )
    monkeypatch.setattr(
        accessor_module,
        "WorkspaceConfig",
        FakeWorkspaceConfig,
    )
    config = DatabricksVolumeConfig(
        catalog="main",
        schema="default",
        volume="agent_files",
        host="https://example.cloud.databricks.com",
        token="secret",
        timeout=17,
    )
    accessor = DatabricksVolumeAccessor(config)
    assert accessor.files is not None
    sdk_config = FakeWorkspaceClient.calls[0]["config"]
    assert sdk_config.host == "https://example.cloud.databricks.com"
    assert sdk_config.token == "secret"
    assert sdk_config.http_timeout_seconds == 17
