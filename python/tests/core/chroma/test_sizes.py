import pytest

from mirage.cache.index import IndexEntry, RAMIndexCacheStore
from mirage.core.chroma.read import read
from mirage.core.chroma.sizes import ensure_dir_sizes
from mirage.core.chroma.stat import stat
from mirage.core.chroma.tree import CHROMA_TREE
from tests.core.chroma.conftest import FakeCollection, accessor_for


@pytest.mark.asyncio
async def test_stat_size_matches_read(
    chroma_accessor, chroma_index, quickstart_path
):
    result = await stat(chroma_accessor, quickstart_path, chroma_index)
    body = await read(chroma_accessor, quickstart_path, chroma_index)

    assert result.size == len(body)
    # The producer's own number stays visible, but never as the size.
    assert result.extra["source_size"] == 12


@pytest.mark.asyncio
async def test_stat_sizes_the_whole_directory_in_one_scan(
    chroma_accessor, chroma_collection, chroma_index, quickstart_path
):
    await CHROMA_TREE.ensure(chroma_accessor, chroma_index, "/knowledge")
    before = len(chroma_collection.get_calls)

    await stat(chroma_accessor, quickstart_path, chroma_index)
    scans = len(chroma_collection.get_calls) - before
    await stat(chroma_accessor, quickstart_path, chroma_index)

    assert scans == 1
    # The second stat is served from the index, so no further scan happens.
    assert len(chroma_collection.get_calls) - before == 1


@pytest.mark.asyncio
async def test_stat_sizes_a_chunkless_page_as_empty(
    chroma_accessor, chroma_collection, chroma_index, quickstart_path
):
    chroma_collection.chunks["guides/quickstart"] = []

    result = await stat(chroma_accessor, quickstart_path, chroma_index)
    body = await read(chroma_accessor, quickstart_path, chroma_index)

    assert result.size == len(body) == 0


@pytest.mark.asyncio
async def test_several_chunkless_pages_cost_one_scan():
    collection = FakeCollection()
    accessor = accessor_for(collection)
    index = RAMIndexCacheStore()
    names = ["a", "b", "c"]
    await index.set_dir(
        "/knowledge/guides",
        [
            (
                name,
                IndexEntry(
                    id=f"guides/{name}",
                    name=name,
                    resource_type="file",
                    extra={"slug": f"guides/{name}"},
                ),
            )
            for name in names
        ],
    )

    for _ in names:
        await ensure_dir_sizes(accessor, "/knowledge/guides", index)

    for name in names:
        lookup = await index.get(f"/knowledge/guides/{name}")
        assert lookup.entry is not None and lookup.entry.size == 0
    assert len(collection.get_calls) == 1
