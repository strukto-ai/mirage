import pytest

from mirage.types import VFSName
from mirage.vfs.registry import REGISTRY, build_vfs


@pytest.mark.asyncio
async def test_chroma_vfs_is_registered():
    assert VFSName.CHROMA == "chroma"
    assert REGISTRY["chroma"].vfs_path == "mirage.vfs.chroma:ChromaVFS"
    assert REGISTRY["chroma"].config_path == "mirage.vfs.chroma:ChromaConfig"

    vfs = build_vfs("chroma", {"collection_name": "docs"})

    assert vfs.name == VFSName.CHROMA
    assert vfs.caches_reads is False
    assert vfs.SUPPORTS_SNAPSHOT is False
    assert vfs.config.collection_name == "docs"
    assert vfs.config.slug_field == "page_slug"
    assert vfs.accessor.config is vfs.config


@pytest.mark.asyncio
async def test_chroma_vfs_registers_expected_commands_and_ops():
    vfs = build_vfs("chroma", {"collection_name": "docs"})

    commands = {item.name for item in vfs.commands()}
    ops = {item.name for item in vfs.ops_list()}

    assert {
        "cat", "ls", "grep", "find", "head", "tail", "tree", "chroma-query"
    }.issubset(commands)
    assert {"read", "readdir", "stat", "grep", "search"}.issubset(ops)
