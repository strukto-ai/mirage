import pytest
from pydantic import SecretStr

from mirage.accessor.mem0 import Mem0Accessor
from mirage.core.mem0.stat import stat
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.vfs.mem0 import Mem0VFS
from mirage.vfs.mem0.config import Mem0Config
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import vfs_over


class FakeClient:
    def __init__(self):
        self.get_calls = 0

    async def get_all(self, options=None):
        return {
            "count": 1,
            "next": None,
            "results": [
                {
                    "id": "aaa",
                    "memory": "x",
                    "created_at": "2026-06-15T00:34:18-07:00",
                    "updated_at": "2026-06-15T00:34:22-07:00",
                }
            ],
        }

    async def get(self, memory_id):
        self.get_calls += 1
        return {
            "id": memory_id,
            "memory": "x",
            "created_at": "2026-06-15T00:00:00-07:00",
            "updated_at": "2026-06-15T09:00:00-07:00",
        }


class CreatedOnlyClient(FakeClient):
    async def get_all(self, options=None):
        return {
            "count": 1,
            "next": None,
            "results": [
                {
                    "id": "aaa",
                    "memory": "x",
                    "created_at": "2026-06-15T00:00:00-07:00",
                    "updated_at": None,
                }
            ],
        }


def _accessor():
    acc = Mem0Accessor(Mem0Config(api_key=SecretStr("k"), user_id="alex"))
    acc._client = FakeClient()
    return acc


@pytest.mark.asyncio
async def test_stat_root_is_dir():
    s = await stat(
        _accessor(), PathSpec(virtual="/mem", directory="/mem", vfs_path="")
    )
    assert s.type == FileType.DIRECTORY


def _mounted(acc: Mem0Accessor) -> Workspace:
    return Workspace({"/mem/": vfs_over(Mem0VFS, acc)})


async def _stat_at(acc: Mem0Accessor, path: str) -> FileStat:
    row, _ = await _mounted(acc).dispatch("stat", PathSpec.from_str_path(path))
    return row


@pytest.mark.asyncio
async def test_stat_memory_from_the_listing_has_times():
    acc = _accessor()
    s = await _stat_at(acc, "/mem/aaa.json")
    assert s.content == ContentType.JSON
    assert s.name == "aaa.json"
    assert s.modified == "2026-06-15T00:34:22-07:00"
    assert s.extra["created_at"] == "2026-06-15T00:34:18-07:00"
    assert s.extra["updated_at"] == "2026-06-15T00:34:22-07:00"
    assert acc._client.get_calls == 0


@pytest.mark.asyncio
async def test_stat_of_a_memory_outside_the_scope_is_enoent():
    # The scoped listing is the proof, as it is for read: a by-id fetch
    # answered for another user's memory the listing never showed.
    acc = _accessor()
    with pytest.raises(FileNotFoundError):
        await _stat_at(acc, "/mem/zzz.json")
    assert acc._client.get_calls == 0


@pytest.mark.asyncio
async def test_stat_falls_back_to_created_at():
    acc = _accessor()
    acc._client = CreatedOnlyClient()
    s = await _stat_at(acc, "/mem/aaa.json")
    assert s.modified == "2026-06-15T00:00:00-07:00"


@pytest.mark.asyncio
async def test_stat_invalid_enoent():
    with pytest.raises(FileNotFoundError):
        await stat(
            _accessor(),
            PathSpec(virtual="/mem/.x", directory="/mem", vfs_path=".x"),
        )


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file():
    # The fskit invariant behind sizes_always_known: the size stat reports
    # from the listing must equal the byte length a read delivers.
    ws = _mounted(_accessor())
    paths, _ = await ws.dispatch("readdir", PathSpec.from_str_path("/mem"))
    for child in paths:
        info, _ = await ws.dispatch("stat", PathSpec.from_str_path(child))
        if info.type == FileType.DIRECTORY:
            continue
        body, _ = await ws.dispatch("read", PathSpec.from_str_path(child))
        assert info.size == len(body), child
