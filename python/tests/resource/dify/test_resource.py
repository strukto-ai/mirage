import pytest
from pydantic import ValidationError

from mirage.resource.dify import DifyConfig
from mirage.resource.registry import REGISTRY, build_resource
from mirage.types import ResourceName


def test_dify_resource_is_registered_and_redacts_api_key():
    assert ResourceName.DIFY == "dify"
    assert REGISTRY[
        "dify"].resource_path == "mirage.resource.dify:DifyResource"
    assert REGISTRY["dify"].config_path == "mirage.resource.dify:DifyConfig"

    resource = build_resource(
        "dify",
        {
            "api_key": "dataset-secret",
            "base_url": "https://api.dify.ai/v1/",
            "dataset_id": "dataset-1",
        },
    )

    assert resource.name == ResourceName.DIFY
    assert resource.caches_reads is True
    assert resource.SUPPORTS_SNAPSHOT is False
    assert resource.config.base_url == "https://api.dify.ai/v1"
    assert resource.config.slug_metadata_name == "slug"
    assert resource.config.max_concurrency == 10
    assert resource.config.request_timeout == 30.0
    assert resource.config.retry_attempts == 4
    assert resource.config.retry_max_delay == 30.0
    assert resource.accessor.config is resource.config

    state = resource.get_state()
    assert state["type"] == ResourceName.DIFY
    assert state["needs_override"] is True
    assert state["redacted_fields"] == ["api_key"]
    assert state["config"]["api_key"] == "<REDACTED>"
    assert state["config"]["dataset_id"] == "dataset-1"
    assert state["config"]["slug_metadata_name"] == "slug"
    assert state["config"]["max_concurrency"] == 10
    assert state["config"]["request_timeout"] == 30.0
    assert state["config"]["retry_attempts"] == 4
    assert state["config"]["retry_max_delay"] == 30.0


def test_dify_resource_accepts_configured_slug_metadata_name():
    resource = build_resource(
        "dify",
        {
            "api_key": "dataset-secret",
            "base_url": "https://api.dify.ai/v1",
            "dataset_id": "dataset-1",
            "slug_metadata_name": "path",
        },
    )

    assert resource.config.slug_metadata_name == "path"


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


def test_dify_resource_registers_expected_commands_and_ops():
    resource = build_resource(
        "dify",
        {
            "api_key": "dataset-secret",
            "base_url": "https://api.dify.ai/v1",
            "dataset_id": "dataset-1",
        },
    )

    commands = {item.name for item in resource.commands()}
    ops = {item.name for item in resource.ops_list()}

    assert {"cat", "ls", "grep", "find", "head", "tail",
            "wc"}.issubset(commands)
    assert {"read", "readdir", "stat", "grep"}.issubset(ops)


@pytest.mark.asyncio
async def test_dify_resource_close_closes_shared_client():
    resource = build_resource(
        "dify",
        {
            "api_key": "dataset-secret",
            "base_url": "https://api.dify.ai/v1",
            "dataset_id": "dataset-1",
        },
    )
    client = resource.accessor.get_client()

    await resource.close()

    assert client.is_closed is True
    assert resource.accessor._client is None
