# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import errno

import pytest

from mirage import MountMode, Workspace
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.policy import Action, Policy
from mirage.policy.types import VfsContext
from mirage.types import FileStat, FileType, PathSpec
from mirage.vfs.base import BaseVFS
from mirage.vfs.call import call_effect, vfs_call
from mirage.vfs.ram import RAMVFS
from mirage.vfs.types import Effect
from mirage.workspace.mount import MountEntry
from tests.fixtures.vfs_io import served


class Notes(BaseVFS):
    """A plug-in VFS with one file and two functions of its own."""

    name = "notes"

    def __init__(self) -> None:
        super().__init__()
        self.stamped: list[str] = []

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        return ["/a.txt"]

    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        return b"note\n"

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        if path.vfs_path.strip("/") in ("", "a.txt"):
            kind = (
                FileType.DIRECTORY
                if not path.vfs_path.strip("/")
                else FileType.FILE
            )
            return FileStat(name=path.virtual, type=kind, size=5)
        raise FileNotFoundError(path.virtual)

    @vfs_call(effect=Effect.READ)
    async def search_abc(self, path: PathSpec, query: str) -> list[str]:
        return [f"{path.virtual}: {query}"]

    @vfs_call(effect=Effect.WRITE)
    async def stamp(self, path: PathSpec) -> None:
        self.stamped.append(path.virtual)

    async def helper(self, path: PathSpec) -> None:
        raise AssertionError("an unmarked method is not reachable by name")


class LoudNotes(Notes):
    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        return b"NOTE\n"


def test_a_mark_names_the_effect():
    assert call_effect(Notes, "search_abc") is Effect.READ
    assert call_effect(Notes, "stamp") is Effect.WRITE
    assert call_effect(Notes, "helper") is None


def test_an_unmarked_override_keeps_its_bases_mark():
    assert call_effect(LoudNotes, "read") is Effect.READ
    assert call_effect(BaseVFS, "write") is Effect.WRITE


def test_a_vfs_supports_what_it_defines():
    notes = Notes()
    assert notes.supports("read")
    assert notes.supports("search_abc")
    assert not notes.supports("write")
    assert served(BaseVFS()) == set()
    assert {"read", "write", "stat"} <= served(RAMVFS())


async def _write(path: PathSpec, data: bytes) -> None:
    return None


def test_a_function_set_on_the_instance_is_supported():
    notes = Notes()
    notes.write = _write  # type: ignore[method-assign]
    assert notes.supports("write")
    assert MountEntry("/", notes).answers("write")


def test_the_door_serves_marked_functions_only():
    mount = MountEntry("/", Notes())
    assert mount.answers("search_abc")
    assert mount.answers("stamp")
    assert not mount.answers("helper")
    assert not mount.answers("write")


@pytest.mark.asyncio
async def test_a_custom_function_runs_through_the_door():
    ws = Workspace({"/notes/": Notes()}, mode=MountMode.WRITE)
    try:
        found, _ = await ws.dispatch(
            "search_abc", PathSpec.from_str_path("/notes/a.txt"), query="hi"
        )
        assert found == ["/notes/a.txt: hi"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_writing_function_is_refused_on_a_read_only_mount():
    notes = Notes()
    ws = Workspace({"/notes/": notes}, mode=MountMode.READ)
    try:
        with pytest.raises(OSError) as refused:
            await ws.dispatch("stamp", PathSpec.from_str_path("/notes/a.txt"))
        assert refused.value.errno == errno.EROFS
        assert notes.stamped == []
    finally:
        await ws.close()


class Recorder(Policy):
    def __init__(self) -> None:
        self.seen: list[tuple[str, bool]] = []

    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        self.seen.append((ctx.op, ctx.write))
        return None


@pytest.mark.asyncio
async def test_policies_judge_a_custom_function_by_its_effect():
    recorder = Recorder()
    notes = Notes()
    ws = Workspace(
        {"/notes/": notes}, mode=MountMode.WRITE, policies=[recorder]
    )
    try:
        target = PathSpec.from_str_path("/notes/a.txt")
        await ws.dispatch("stamp", target)
        await ws.dispatch("search_abc", target, query="x")
        assert ("stamp", True) in recorder.seen
        assert ("search_abc", False) in recorder.seen
        assert notes.stamped == ["/notes/a.txt"]
    finally:
        await ws.close()


class Shelf(BaseVFS):
    """A cached flat store whose one custom function rewrites a file."""

    name = "shelf"
    caches_reads = True

    def __init__(self) -> None:
        super().__init__()
        self.files: dict[str, bytes] = {"a.txt": b"old\n"}

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        return [f"/shelf/{name}" for name in sorted(self.files)]

    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        return self.files[path.vfs_path.strip("/")]

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        key = path.vfs_path.strip("/")
        if not key:
            return FileStat(name="/", type=FileType.DIRECTORY, size=None)
        if key not in self.files:
            raise FileNotFoundError(path.virtual)
        return FileStat(
            name=key, type=FileType.FILE, size=len(self.files[key])
        )

    @vfs_call(effect=Effect.WRITE)
    async def shelve(self, path: PathSpec) -> None:
        self.files[path.vfs_path.strip("/")] = b"new\n"


@pytest.mark.asyncio
async def test_a_custom_write_drops_the_bytes_it_changed():
    ws = Workspace({"/shelf/": Shelf()}, mode=MountMode.WRITE)
    try:
        page = PathSpec.from_str_path("/shelf/a.txt")
        read, _ = await ws.dispatch("read", page)
        assert read == b"old\n"
        await ws.dispatch("shelve", page)
        read, _ = await ws.dispatch("read", page)
        assert read == b"new\n"
    finally:
        await ws.close()
