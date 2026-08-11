import pytest

from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.qdrant.read import read
from mirage.core.qdrant.readdir import readdir
from mirage.core.qdrant.stat import stat
from mirage.types import FileType, PathSpec


def _ps(path: str) -> PathSpec:
    return PathSpec(virtual=path,
                    directory=path,
                    resource_path=path.strip("/"))


@pytest.mark.asyncio
async def test_stat_group_dir_is_directory(accessor):
    s = await stat(accessor, _ps("/animals/cat"))
    assert s.type == FileType.DIRECTORY
    assert s.name == "cat"


@pytest.mark.asyncio
async def test_stat_json_is_text_with_size(accessor):
    s = await stat(accessor, _ps("/animals/cat/big/1.json"))
    assert s.type == FileType.TEXT
    assert s.size and s.size > 0


@pytest.mark.asyncio
async def test_stat_txt_is_text_with_size(accessor):
    s = await stat(accessor, _ps("/animals/cat/big/1.txt"))
    assert s.type == FileType.TEXT
    assert s.size and s.size > 0


@pytest.mark.asyncio
async def test_stat_blob_is_image(accessor):
    s = await stat(accessor, _ps("/animals/cat/big/1.png"))
    assert s.type == FileType.IMAGE_PNG
    assert s.size == len(b"PNG-1")


@pytest.mark.asyncio
async def test_stat_serves_seeded_size_without_refetch(accessor):
    # A seeded entry wins over the read-based fallback, so a warm index
    # answers stat without one row fetch per file.
    index = RAMIndexCacheStore()
    await index.put(
        "/animals/cat/big/1.json",
        IndexEntry(
            id="1",
            name="1.json",
            resource_type="qdrant/row_json",
            vfs_name="1.json",
            size=999,
        ),
    )
    s = await stat(accessor, _ps("/animals/cat/big/1.json"), index)
    assert s.size == 999


@pytest.mark.asyncio
async def test_stat_size_matches_read_after_readdir(accessor):
    index = RAMIndexCacheStore()
    await readdir(accessor, _ps("/animals/cat/big"), index)
    for name in ("1.json", "1.txt", "1.png"):
        path = _ps(f"/animals/cat/big/{name}")
        s = await stat(accessor, path, index)
        data = await read(accessor, path, index)
        assert s.size == len(data)


@pytest.mark.asyncio
async def test_stat_unknown_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, _ps("/animals/cat/big/1.weird/x"))
