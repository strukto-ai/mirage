import pytest

from mirage.resource.registry import REGISTRY, build_resource
from mirage.types import ResourceName


@pytest.mark.asyncio
async def test_chroma_resource_is_registered():
    assert ResourceName.CHROMA == "chroma"
    assert REGISTRY[
        "chroma"].resource_path == "mirage.resource.chroma:ChromaResource"
    assert REGISTRY[
        "chroma"].config_path == "mirage.resource.chroma:ChromaConfig"

    resource = await build_resource("chroma", {"collection_name": "docs"})

    assert resource.name == ResourceName.CHROMA
    assert resource.caches_reads is False
    assert resource.SUPPORTS_SNAPSHOT is False
    assert resource.config.collection_name == "docs"
    assert resource.config.slug_field == "page_slug"
    assert resource.accessor.config is resource.config


@pytest.mark.asyncio
async def test_chroma_resource_registers_expected_commands_and_ops():
    resource = await build_resource("chroma", {"collection_name": "docs"})

    commands = {item.name for item in resource.commands()}
    ops = {item.name for item in resource.ops_list()}

    assert {
        "cat", "ls", "grep", "find", "head", "tail", "tree", "chroma-query"
    }.issubset(commands)
    assert {"read", "readdir", "stat", "grep", "search"}.issubset(ops)
