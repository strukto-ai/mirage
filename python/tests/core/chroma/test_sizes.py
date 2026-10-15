import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.core.chroma.sizes import ensure_dir_sizes
from mirage.types import FileStat, FileType
from mirage.vfs.chroma import ChromaVFS
from tests.core.chroma.conftest import FakeCollection, accessor_for
from tests.fixtures.mounted import Mounted


@pytest.mark.asyncio
async def test_stat_size_matches_read(chroma_accessor, quickstart_path):
    mount = Mounted(ChromaVFS, chroma_accessor, "/knowledge")
    result = await mount.stat(quickstart_path)
    body = await mount.read(quickstart_path)

    assert result.size == len(body)
    # The producer's own number stays visible, but never as the size.
    assert result.extra["source_size"] == 12


@pytest.mark.asyncio
async def test_stat_sizes_the_whole_directory_in_one_scan(
    chroma_accessor, chroma_collection, quickstart_path
):
    mount = Mounted(ChromaVFS, chroma_accessor, "/knowledge")
    await mount.readdir("/guides")
    before = len(chroma_collection.get_calls)

    await mount.stat(quickstart_path)
    scans = len(chroma_collection.get_calls) - before
    await mount.stat(quickstart_path)

    assert scans == 1
    # The second stat is served from the sized row, so no further scan
    # happens.
    assert len(chroma_collection.get_calls) - before == 1


@pytest.mark.asyncio
async def test_stat_sizes_a_chunkless_page_as_empty(
    chroma_accessor, chroma_collection, quickstart_path
):
    chroma_collection.chunks["guides/quickstart"] = []
    mount = Mounted(ChromaVFS, chroma_accessor, "/knowledge")

    result = await mount.stat(quickstart_path)
    body = await mount.read(quickstart_path)

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
                FileStat(
                    name=name,
                    type=FileType.FILE,
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
