import pytest

from mirage.core.chroma.read import read_bytes
from mirage.core.chroma.stat import stat, stat_light
from mirage.core.chroma.tree import ensure_tree


@pytest.mark.asyncio
async def test_stat_size_matches_read(chroma_accessor, chroma_index,
                                      quickstart_path):
    result = await stat(chroma_accessor, quickstart_path, chroma_index)
    body = await read_bytes(chroma_accessor, quickstart_path, chroma_index)

    assert result.size == len(body)
    # The producer's own number stays visible, but never as the size.
    assert result.extra["source_size"] == 12


@pytest.mark.asyncio
async def test_stat_sizes_the_whole_directory_in_one_scan(
        chroma_accessor, chroma_collection, chroma_index, quickstart_path):
    await ensure_tree(chroma_accessor, chroma_index, "/knowledge")
    before = len(chroma_collection.get_calls)

    await stat(chroma_accessor, quickstart_path, chroma_index)
    scans = len(chroma_collection.get_calls) - before
    await stat(chroma_accessor, quickstart_path, chroma_index)

    assert scans == 1
    # The second stat is served from the index, so no further scan happens.
    assert len(chroma_collection.get_calls) - before == 1


@pytest.mark.asyncio
async def test_stat_light_skips_the_size_scan(chroma_accessor,
                                              chroma_collection, chroma_index,
                                              quickstart_path):
    await ensure_tree(chroma_accessor, chroma_index, "/knowledge")
    before = len(chroma_collection.get_calls)

    result = await stat_light(chroma_accessor, quickstart_path, chroma_index)

    assert result.size is None
    assert len(chroma_collection.get_calls) == before


@pytest.mark.asyncio
async def test_stat_leaves_chunkless_pages_unsized(chroma_accessor,
                                                   chroma_collection,
                                                   chroma_index,
                                                   quickstart_path):
    chroma_collection.chunks["guides/quickstart"] = []

    result = await stat(chroma_accessor, quickstart_path, chroma_index)

    assert result.size is None
