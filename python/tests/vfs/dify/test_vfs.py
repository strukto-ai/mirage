import pytest
from pydantic import ValidationError

from mirage.types import VFSName
from mirage.vfs.dify import DifyConfig
from mirage.vfs.registry import REGISTRY, build_vfs


@pytest.mark.asyncio
async def test_dify_vfs_is_registered_and_redacts_api_key():
    assert VFSName.DIFY == "dify"
    assert REGISTRY["dify"].vfs_path == "mirage.vfs.dify:DifyVFS"
    assert REGISTRY["dify"].config_path == "mirage.vfs.dify:DifyConfig"

    vfs = build_vfs(
        "dify",
        {
            "api_key": "dataset-secret",
            "base_url": "https://api.dify.ai/v1/",
            "dataset_id": "dataset-1",
        },
    )

    assert vfs.name == VFSName.DIFY
    assert vfs.caches_reads is True
    assert vfs.SUPPORTS_SNAPSHOT is False
    assert vfs.config.base_url == "https://api.dify.ai/v1"
    assert vfs.config.slug_metadata_name == "slug"
    assert vfs.config.max_concurrency == 10
    assert vfs.config.request_timeout == 30.0
    assert vfs.config.retry_attempts == 4
    assert vfs.config.retry_max_delay == 30.0
    assert vfs.accessor.config is vfs.config

    state = vfs.get_state()
    assert state["type"] == VFSName.DIFY
    assert state["needs_override"] is True
    assert state["redacted_fields"] == ["api_key"]
    assert state["config"]["api_key"] == "<REDACTED>"
    assert state["config"]["dataset_id"] == "dataset-1"
    assert state["config"]["slug_metadata_name"] == "slug"
    assert state["config"]["max_concurrency"] == 10
    assert state["config"]["request_timeout"] == 30.0
    assert state["config"]["retry_attempts"] == 4
    assert state["config"]["retry_max_delay"] == 30.0


@pytest.mark.asyncio
async def test_dify_vfs_accepts_configured_slug_metadata_name():
    vfs = build_vfs(
        "dify",
        {
            "api_key": "dataset-secret",
            "base_url": "https://api.dify.ai/v1",
            "dataset_id": "dataset-1",
            "slug_metadata_name": "path",
        },
    )

    assert vfs.config.slug_metadata_name == "path"


@pytest.mark.parametrize(
    "field",
    [
        "max_concurrency",
        "request_timeout",
        "retry_attempts",
        "retry_max_delay",
    ],
)
def test_dify_config_rejects_non_positive_request_limits(field):
    values = {
        "api_key": "dataset-secret",
        "base_url": "https://api.dify.ai/v1",
        "dataset_id": "dataset-1",
        field: 0,
    }

    with pytest.raises(ValidationError):
        DifyConfig(**values)


@pytest.mark.asyncio
async def test_dify_vfs_registers_expected_commands_and_ops():
    vfs = build_vfs(
        "dify",
        {
            "api_key": "dataset-secret",
            "base_url": "https://api.dify.ai/v1",
            "dataset_id": "dataset-1",
        },
    )

    commands = {item.name for item in vfs.commands()}
    ops = {item.name for item in vfs.ops_list()}

    assert {"cat", "ls", "grep", "find", "head", "tail",
            "wc"}.issubset(commands)
    assert {"read", "readdir", "stat", "grep"}.issubset(ops)


@pytest.mark.asyncio
async def test_dify_vfs_close_closes_shared_client():
    vfs = build_vfs(
        "dify",
        {
            "api_key": "dataset-secret",
            "base_url": "https://api.dify.ai/v1",
            "dataset_id": "dataset-1",
        },
    )
    session = vfs.accessor.pool.get()

    await vfs.close()

    assert session.closed is True
    assert vfs.accessor.pool._session is None
