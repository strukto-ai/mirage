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
from mirage.context import reset_current_session, set_current_session
from mirage.policy import Action, Policy
from mirage.policy.types import VfsContext
from mirage.types import (
    FileStat,
    FileType,
    HiddenPaths,
    PathSpec,
    Visibility,
)
from mirage.vfs.base import BaseVFS
from mirage.vfs.call import call_names, declared, declared_calls, vfs_call
from mirage.vfs.ram import RAMVFS
from mirage.vfs.types import Declaration, Effect, Target
from mirage.workspace.mount import MountEntry
from mirage.workspace.session import SessionState
from tests.fixtures.vfs_io import served


class Shelf(BaseVFS):
    """A cached flat store with functions of its own."""

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
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
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

    @vfs_call(effect=Effect.READ)
    async def search_abc(self, path: PathSpec, query: str) -> list[str]:
        return [f"{path.virtual}: {query}"]

    @vfs_call(effect=Effect.READ)
    async def compare(self, path: PathSpec, other: PathSpec) -> str:
        return other.vfs_path

    @vfs_call(effect=Effect.WRITE)
    async def shelve(self, path: PathSpec) -> None:
        self.files[path.vfs_path.strip("/")] = b"new\n"

    @vfs_call(effect=Effect.WRITE)
    async def copy_to(self, path: PathSpec, target: PathSpec) -> None:
        key = path.vfs_path.strip("/")
        self.files[target.vfs_path.strip("/")] = self.files[key]

    async def helper(self, path: PathSpec) -> None:
        raise AssertionError("an unmarked method is not reachable by name")


def test_a_mark_declares_and_an_override_keeps_it():
    assert declared(Shelf, "search_abc") == Declaration(
        Effect.READ, Target.ANY, False
    )
    assert declared(Shelf, "shelve") == Declaration(
        Effect.WRITE, Target.ANY, False
    )
    assert declared(Shelf, "read") == declared(BaseVFS, "read")
    assert declared(Shelf, "helper") is None


async def move(path: PathSpec, dst: PathSpec) -> None:
    return None


def test_only_rename_declares_a_rename():
    with pytest.raises(TypeError, match="move: only rename"):
        vfs_call(effect=Effect.RENAME)(move)


# What each built-in function declares. The TypeScript twin
# (vfs/call.test.ts) pins this same table, so a declaration changed in
# one language fails the other language's test.
BUILT_INS = {
    "append": (Effect.WRITE, Target.FILE, True),
    "create": (Effect.WRITE, Target.FILE, True),
    "mkdir": (Effect.CREATE, Target.DIR, False),
    "pwrite": (Effect.WRITE, Target.FILE, True),
    "read": (Effect.READ, Target.FILE, False),
    "readdir": (Effect.READ, Target.DIR, False),
    "rename": (Effect.RENAME, Target.ANY, False),
    "rmdir": (Effect.REMOVE, Target.DIR, False),
    "setattr": (Effect.ATTR, Target.ANY, False),
    "stat": (Effect.METADATA, Target.ANY, False),
    "truncate": (Effect.WRITE, Target.FILE, True),
    "unlink": (Effect.REMOVE, Target.FILE, False),
    "write": (Effect.WRITE, Target.FILE, True),
}


def test_the_built_ins_declare_what_they_do():
    assert declared_calls(BaseVFS) == {
        name: Declaration(*mark) for name, mark in BUILT_INS.items()
    }


def test_call_names_keeps_what_matches_every_filter():
    calls = declared_calls(BaseVFS)
    assert call_names(calls, effects={Effect.REMOVE}) == {"unlink", "rmdir"}
    assert call_names(
        calls, effects={Effect.REMOVE}, targets={Target.DIR}
    ) == {"rmdir"}
    assert call_names(calls, effects={Effect.WRITE}, creates=False) == set()
    assert call_names(calls, targets={Target.LINK}) == set()


def test_the_door_serves_what_a_vfs_defines_and_marks():
    shelf = Shelf()
    mount = MountEntry("/", shelf)
    assert shelf.supports("search_abc") and mount.answers("search_abc")
    assert not shelf.supports("write") and not mount.answers("write")
    assert not mount.answers("helper")
    assert served(BaseVFS()) == set()
    assert {"read", "write", "stat"} <= served(RAMVFS())


async def _write(path: PathSpec, data: bytes) -> None:
    return None


def test_a_function_set_on_the_instance_is_supported():
    shelf = Shelf()
    shelf.write = _write  # type: ignore[method-assign]
    assert shelf.supports("write")
    assert MountEntry("/", shelf).answers("write")


@pytest.mark.asyncio
async def test_a_function_takes_its_own_keywords_only():
    ws = Workspace({"/shelf/": Shelf()}, mode=MountMode.WRITE)
    page = PathSpec.from_str_path("/shelf/a.txt")
    try:
        found, _ = await ws.dispatch("search_abc", page, query="hi")
        assert found == ["/shelf/a.txt: hi"]
        with pytest.raises(TypeError, match="search_abc.*'qeury'"):
            await ws.dispatch("search_abc", page, qeury="x")
        with pytest.raises(TypeError, match="read.*'offest'"):
            await ws.dispatch("read", page, offest=1)
        await ws.dispatch("read", page)
        assert (await ws.dispatch("read", page, offset=1))[0] == b"ld\n"
        with pytest.raises(TypeError, match="read.*'offest'"):
            await ws.dispatch("read", page, offest=1)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_writing_function_answers_to_the_read_only_paths():
    shelf = Shelf()
    shelf.files["b.txt"] = b"older\n"
    ws = Workspace({"/shelf/": shelf}, mode=MountMode.WRITE)
    show = {"/shelf/a.txt": "r", "/shelf/b.txt": "rw"}
    token = set_current_session(
        ws.create_session("rev", profile={"paths": {"show": show}})
    )
    a = PathSpec.from_str_path("/shelf/a.txt")
    b = PathSpec.from_str_path("/shelf/b.txt")
    try:
        with pytest.raises(OSError) as refused:
            await ws.dispatch("shelve", a)
        assert refused.value.errno == errno.EROFS
        with pytest.raises(OSError) as refused:
            await ws.dispatch("copy_to", b, target=a)
        assert refused.value.errno == errno.EROFS
        assert shelf.files["a.txt"] == b"old\n"
    finally:
        reset_current_session(token)
        await ws.close()


class Recorder(Policy):
    def __init__(self) -> None:
        self.seen: list[tuple[str, bool, str]] = []

    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        self.seen.append((ctx.op, ctx.write, ctx.path.virtual))
        return None


@pytest.mark.asyncio
async def test_policies_judge_a_function_by_its_effect_and_every_path():
    recorder = Recorder()
    ws = Workspace(
        {"/shelf/": Shelf()}, mode=MountMode.WRITE, policies=[recorder]
    )
    page = PathSpec.from_str_path("/shelf/a.txt")
    try:
        await ws.dispatch("shelve", page)
        await ws.dispatch(
            "compare", page, other=PathSpec.from_str_path("/shelf/b.txt")
        )
        assert recorder.seen == [
            ("shelve", True, "/shelf/a.txt"),
            ("compare", False, "/shelf/a.txt"),
            ("compare", False, "/shelf/b.txt"),
        ]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_second_path_passes_the_door():
    ws = Workspace(
        {"/shelf/": Shelf(), "/ram/": RAMVFS()}, mode=MountMode.WRITE
    )
    hidden = Visibility(paths=HiddenPaths(paths=("/shelf/c.txt",)))
    token = set_current_session(
        SessionState(session_id="agent", visibility=hidden)
    )

    async def compare(other: str) -> str:
        answer, _ = await ws.dispatch(
            "compare",
            PathSpec.from_str_path("/shelf/a.txt"),
            other=PathSpec.from_str_path(other, cwd="/"),
        )
        return answer

    try:
        assert await compare("/shelf/b.txt") == "b.txt"
        await ws.vfs.symlink("/shelf/l.txt", "b.txt")
        assert await compare("/shelf/l.txt") == "b.txt"
        with pytest.raises(FileNotFoundError):
            await compare("/shelf/c.txt")
        with pytest.raises(FileNotFoundError):
            await compare("/shelf/missing/../b.txt")
        with pytest.raises(NotADirectoryError):
            await compare("/shelf/a.txt/")
        for elsewhere in ("/ram/b.txt", "/nowhere/b.txt"):
            with pytest.raises(OSError) as refused:
                await compare(elsewhere)
            assert refused.value.errno == errno.EXDEV
    finally:
        reset_current_session(token)
        await ws.close()


@pytest.mark.asyncio
async def test_a_custom_write_drops_the_bytes_of_every_path_it_changed():
    shelf = Shelf()
    shelf.files["b.txt"] = b"older\n"
    ws = Workspace({"/shelf/": shelf}, mode=MountMode.WRITE)
    a = PathSpec.from_str_path("/shelf/a.txt")
    b = PathSpec.from_str_path("/shelf/b.txt")
    try:
        assert (await ws.dispatch("read", a))[0] == b"old\n"
        assert (await ws.dispatch("read", b))[0] == b"older\n"
        await ws.dispatch("shelve", a)
        await ws.dispatch("copy_to", a, target=b)
        assert (await ws.dispatch("read", a))[0] == b"new\n"
        assert (await ws.dispatch("read", b))[0] == b"new\n"
    finally:
        await ws.close()
