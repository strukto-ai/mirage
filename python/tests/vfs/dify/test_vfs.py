from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from mirage.core.dify import search, tree
from mirage.types import PathSpec, SearchQuery, VFSName
from mirage.utils.key_prefix import mount_key
from mirage.vfs.dify import DifyConfig, DifyVFS
from mirage.vfs.registry import REGISTRY, build_vfs
from tests.fixtures.mount_commands import mount_commands
from tests.fixtures.vfs_io import StubAccessor, served, vfs_over
from tests.vfs.dify.conftest import document


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
    assert vfs.supports_snapshot is False
    assert vfs.config.base_url == "https://api.dify.ai/v1"
    assert vfs.config.slug_metadata_name == "slug"
    assert vfs.config.max_concurrency == 10
    assert vfs.config.timeout == 30
    assert vfs.config.retry_attempts == 4
    assert vfs.config.retry_max_delay == 30.0
    assert vfs.accessor.config is vfs.config

    state = vfs.get_state()
    assert state["type"] == VFSName.DIFY
    assert state["needs_override"] is True
    assert "redacted_fields" not in state
    assert state["config"]["api_key"] == "<REDACTED>"
    assert state["config"]["dataset_id"] == "dataset-1"
    assert state["config"]["slug_metadata_name"] == "slug"
    assert state["config"]["max_concurrency"] == 10
    assert state["config"]["timeout"] == 30
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
        "timeout",
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

    commands = {item.name for item in mount_commands(vfs)}
    ops = served(vfs)

    assert {"cat", "ls", "grep", "find", "head", "tail", "wc"}.issubset(
        commands
    )
    assert {"read", "readdir", "stat"}.issubset(ops)


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


def accessor() -> StubAccessor:
    return StubAccessor(config=SimpleNamespace(slug_metadata_name="slug"))


async def _list_documents(config):
    return [
        document("doc-1", "API", "guides/api.md"),
        document("doc-2", "Auth", "guides/auth.md"),
    ]


@pytest.mark.asyncio
async def test_search_resolves_globs_and_passes_multiple_documents(
    monkeypatch,
):

    calls: list[tuple[list[PathSpec], dict]] = []

    async def search_segments(accessor, query, paths, **kwargs):
        calls.append((paths, kwargs))
        return [("/knowledge/a", "api"), ("/knowledge/b", "auth")]

    monkeypatch.setattr(tree, "list_all_documents", _list_documents)
    monkeypatch.setattr(search, "search_segments", search_segments)

    # The store resolves a glob scope itself, as a batch ranking does.
    hits = await vfs_over(DifyVFS, accessor()).search_many(
        [
            PathSpec(
                vfs_path=mount_key("/knowledge/guides/*.md", "/knowledge"),
                virtual="/knowledge/guides/*.md",
                directory="/knowledge/guides",
                pattern="*.md",
                resolved=False,
            )
        ],
        SearchQuery("login", options={"method": "semantic"}),
    )
    stdout = "".join(record + "\n" for _, record in hits or []).encode()

    assert stdout == b"api\nauth\n"
    assert [path.virtual for path in calls[0][0]] == [
        "/knowledge/guides/api.md",
        "/knowledge/guides/auth.md",
    ]
    assert calls[0][1]["mount_prefix"] == "/knowledge"
