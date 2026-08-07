import pytest

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.qdrant.readdir import _blob_size, readdir
from mirage.core.qdrant.render import blob_bytes, render_json, render_text
from mirage.types import PathSpec


def _ps(path: str) -> PathSpec:
    return PathSpec(virtual=path,
                    directory=path,
                    resource_path=path.strip("/"))


def _names(paths: list[str]) -> set[str]:
    return {p.rsplit("/", 1)[-1] for p in paths}


@pytest.mark.asyncio
async def test_root_lists_collection(accessor):
    out = await readdir(accessor, _ps("/"))
    assert _names(out) == {"animals"}


@pytest.mark.asyncio
async def test_collection_lists_groups(accessor):
    out = await readdir(accessor, _ps("/animals"))
    assert _names(out) == {"cat", "dog"}


@pytest.mark.asyncio
async def test_group_lists_next_level(accessor):
    out = await readdir(accessor, _ps("/animals/cat"))
    assert _names(out) == {"big", "small"}


@pytest.mark.asyncio
async def test_leaf_lists_row_files(accessor):
    out = await readdir(accessor, _ps("/animals/cat/big"))
    assert _names(out) == {"1.json", "1.txt", "1.png"}


@pytest.mark.asyncio
async def test_leaf_seeds_exact_rendered_sizes(accessor):
    index = RAMIndexCacheStore()
    await readdir(accessor, _ps("/animals/cat/big"), index)
    config = accessor.config
    row = {
        "label": "cat",
        "kind": "big",
        "name": "a big orange cat",
        "image_bytes": "UE5HLTE=",
        "id": 1,
    }
    json_lookup = await index.get("/animals/cat/big/1.json")
    assert json_lookup.entry is not None
    assert json_lookup.entry.size == len(render_json(row, config))
    txt_lookup = await index.get("/animals/cat/big/1.txt")
    assert txt_lookup.entry is not None
    assert txt_lookup.entry.size == len(render_text(row, config))
    blob_lookup = await index.get("/animals/cat/big/1.png")
    assert blob_lookup.entry is not None
    assert blob_lookup.entry.size == len(blob_bytes("UE5HLTE="))


def test_blob_size_leaves_undecodable_values_unknown():
    # An undecodable blob must leave that one size unknown rather than take
    # the whole directory listing down with it.
    assert _blob_size("UE5HLTE=") == 5
    assert _blob_size(42) is None
