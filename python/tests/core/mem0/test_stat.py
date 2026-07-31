import pytest
from pydantic import SecretStr

from mirage.accessor.mem0 import Mem0Accessor
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.mem0.read import read
from mirage.core.mem0.readdir import readdir
from mirage.core.mem0.stat import stat
from mirage.resource.mem0.config import Mem0Config
from mirage.types import FileType, PathSpec


class FakeClient:

    def __init__(self):
        self.get_calls = 0

    async def get_all(self, options=None):
        return {
            "count":
            1,
            "next":
            None,
            "results": [{
                "id": "aaa",
                "memory": "x",
                "created_at": "2026-06-15T00:34:18-07:00",
                "updated_at": "2026-06-15T00:34:22-07:00"
            }]
        }

    async def get(self, memory_id):
        self.get_calls += 1
        return {
            "id": memory_id,
            "memory": "x",
            "created_at": "2026-06-15T00:00:00-07:00",
            "updated_at": "2026-06-15T09:00:00-07:00"
        }


class CreatedOnlyClient(FakeClient):

    async def get(self, memory_id):
        return {
            "id": memory_id,
            "memory": "x",
            "created_at": "2026-06-15T00:00:00-07:00",
            "updated_at": None,
        }


def _accessor():
    acc = Mem0Accessor(Mem0Config(api_key=SecretStr("k"), user_id="alex"))
    acc._client = FakeClient()
    return acc


@pytest.mark.asyncio
async def test_stat_root_is_dir():
    s = await stat(
        _accessor(),
        PathSpec(virtual="/mem", directory="/mem", resource_path=""))
    assert s.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_memory_from_cache_has_times():
    acc = _accessor()
    index = RAMIndexCacheStore()
    root = PathSpec(virtual="/mem", directory="/mem", resource_path="")
    await readdir(acc, root, index)
    fpath = PathSpec(virtual="/mem/aaa.json",
                     directory="/mem",
                     resource_path="aaa.json")
    s = await stat(acc, fpath, index)
    assert s.type == FileType.JSON
    assert s.name == "aaa.json"
    assert s.modified == "2026-06-15T00:34:22-07:00"
    assert s.extra["created_at"] == "2026-06-15T00:34:18-07:00"
    assert s.extra["updated_at"] == "2026-06-15T00:34:22-07:00"
    assert acc._client.get_calls == 0


@pytest.mark.asyncio
async def test_stat_memory_fallback_get():
    acc = _accessor()
    fpath = PathSpec(virtual="/mem/zzz.json",
                     directory="/mem",
                     resource_path="zzz.json")
    s = await stat(acc, fpath, RAMIndexCacheStore())
    assert s.modified == "2026-06-15T09:00:00-07:00"
    assert acc._client.get_calls == 1


@pytest.mark.asyncio
async def test_stat_falls_back_to_created_at():
    acc = _accessor()
    acc._client = CreatedOnlyClient()
    fpath = PathSpec(virtual="/mem/zzz.json",
                     directory="/mem",
                     resource_path="zzz.json")
    s = await stat(acc, fpath, RAMIndexCacheStore())
    assert s.modified == "2026-06-15T00:00:00-07:00"


@pytest.mark.asyncio
async def test_stat_invalid_enoent():
    with pytest.raises(FileNotFoundError):
        await stat(
            _accessor(),
            PathSpec(virtual="/mem/.x", directory="/mem", resource_path=".x"))


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file():
    # The fskit invariant behind SIZES_ALWAYS_KNOWN: the size stat reports
    # from the listing must equal the byte length a read delivers.
    acc = _accessor()
    index = RAMIndexCacheStore()
    root = PathSpec(virtual="/mem", directory="/mem", resource_path="")
    for child in await readdir(acc, root, index):
        name = child.rsplit("/", 1)[-1]
        fpath = PathSpec(virtual=child, directory="/mem", resource_path=name)
        info = await stat(acc, fpath, index)
        if info.type == FileType.DIRECTORY:
            continue
        body = await read(acc, fpath, index)
        assert info.size == len(body), child
