import json
from unittest.mock import AsyncMock

import pytest

from mirage.core.chroma import tree
from mirage.types import MountMode, ReadPolicy, ReadSpec, VFSName
from mirage.vfs.registry import REGISTRY, build_vfs
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from tests.core.chroma.conftest import FakeCollection
from tests.fixtures.mount_commands import mount_commands
from tests.fixtures.vfs_io import served


@pytest.mark.asyncio
async def test_chroma_vfs_is_registered():
    assert VFSName.CHROMA == "chroma"
    assert REGISTRY["chroma"].vfs_path == "mirage.vfs.chroma:ChromaVFS"
    assert REGISTRY["chroma"].config_path == "mirage.vfs.chroma:ChromaConfig"

    vfs = build_vfs("chroma", {"collection_name": "docs"})

    assert vfs.name == VFSName.CHROMA
    assert vfs.caches_reads is False
    assert vfs.supports_snapshot is False
    assert vfs.config.collection_name == "docs"
    assert vfs.config.slug_field == "page_slug"
    assert vfs.accessor.config is vfs.config


@pytest.mark.asyncio
async def test_chroma_vfs_registers_expected_commands_and_ops():
    vfs = build_vfs("chroma", {"collection_name": "docs"})

    commands = {item.name for item in mount_commands(vfs)}
    ops = served(vfs)

    assert {
        "cat",
        "ls",
        "grep",
        "find",
        "head",
        "tail",
        "tree",
        "chroma-query",
    }.issubset(commands)
    assert {"read", "readdir", "stat"}.issubset(ops)


# chroma lists from one tree document, so a refused listing refetches the
# whole tree. A burst through the dispatcher belongs to no shell command; fresh
# trusts its own refill for the window instead of refetching per call.
@pytest.mark.asyncio
async def test_an_ops_entry_point_burst_under_fresh_fetches_the_tree_once(
    monkeypatch,
):
    fetch = AsyncMock(wraps=tree.fetch_path_tree)
    monkeypatch.setattr(tree, "fetch_path_tree", fetch)
    collection = FakeCollection()
    collection.documents["__path_tree__"] = json.dumps(
        {
            f"guides/g{n}": {"size": 1, "created_at": None, "updated_at": None}
            for n in range(5)
        }
    )
    vfs = build_vfs("chroma", {"collection_name": "docs"})
    vfs.accessor._collection = collection
    ws = Workspace(
        {
            "/knowledge": Mount(
                vfs=vfs,
                mode=MountMode.READ,
                read=ReadSpec(policy=ReadPolicy.FRESH),
            )
        }
    )
    try:
        names = await ws.readdir("/knowledge/guides")
        assert len(names) == 5
        for name in names:
            await ws.stat(name)
        assert fetch.await_count == 1
    finally:
        await ws.close()
