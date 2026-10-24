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

from collections.abc import AsyncIterator, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

import pytest

from mirage.commands.builtin.generic_bind.files import (
    CommandFiles,
    Reading,
    command_files,
    dir_aware_stat,
    dir_aware_stream,
    file_size,
    resolve_or_empty,
    with_reading,
)
from mirage.commands.config import Context
from mirage.context import reset_mount_gate, set_mount_gate
from mirage.errors.types import GlobLimitError
from mirage.io import IOResult
from mirage.io.types import materialize
from mirage.observe.context import push_revisions, reset_revisions
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.files import Files
from mirage.workspace.types import MountRow
from tests.fixtures.readers import readers
from tests.fixtures.vfs_io import BatchedRAM


@dataclass
class Backend:
    """A keyed store: a directory is a name its parent lists, or explicit."""

    stored: dict[str, bytes] = field(default_factory=dict)
    implicit: set[str] = field(default_factory=set)
    explicit: set[str] = field(default_factory=set)
    listing: Any = None
    calls: list[tuple[str, str, dict[str, Any]]] = field(default_factory=list)

    def _stat(self, at: str) -> FileStat:
        if at in self.explicit:
            return FileStat(name=at, type=FileType.DIRECTORY)
        if at in self.stored:
            size = len(self.stored[at])
            return FileStat(name=at, type=FileType.FILE, size=size)
        raise FileNotFoundError(at)

    def _listing(self, at: str) -> list[str]:
        if self.listing is not None:
            return list(self.listing(at))
        names = {*self.implicit, *self.explicit, *self.stored}
        target = at.rstrip("/") or "/"
        return sorted(
            n for n in names if (n.rpartition("/")[0] or "/") == target
        )

    def _read(self, at: str) -> bytes:
        if at not in self.stored:
            raise FileNotFoundError(at)
        return self.stored[at]

    async def _stream(self, at: str) -> AsyncIterator[bytes]:
        yield self._read(at)

    async def __call__(
        self, name: str, path: PathSpec, /, **kwargs: Any
    ) -> tuple[Any, IOResult]:
        self.calls.append((name, path.virtual, kwargs))
        read = self._stream if kwargs.get("stream") else self._read
        call = {"stat": self._stat, "readdir": self._listing, "read": read}
        answer = call.get(name)
        return (answer(path.virtual) if answer else None), IOResult()


def _refusing(at: str) -> list[str]:
    raise PermissionError(at)


def _fabricated(at: str) -> list[str]:
    return ["/real.txt"] if at == "/" else [f"{at}/tables"]


def _driver(at: str) -> list[str]:
    raise ValueError(f"Table '{at}' was not found")


def _st(kind: FileType = FileType.FILE, **fields: Any) -> FileStat:
    return FileStat(name="f", type=kind, **fields)


def _answering(
    st: FileStat, now: FileStat | None = None, warm: bool = False
) -> Any:
    async def dispatch(name, path, /, **kwargs):
        if name == "read":
            return (True if warm else None), IOResult()
        return (now or st) if kwargs.get("fresh") else st, IOResult()

    return dispatch


def _row(prefix: str = "/", **fields: Any) -> MountRow:
    return MountRow(
        prefix=prefix, resource_type="ram", mode=MountMode.WRITE, **fields
    )


def _ctx(dispatch: Any, *rows: MountRow) -> Context:
    return Context(vfs=Files(dispatch, readers(list(rows)), ledger=False))


@contextmanager
def _on_mount(prefix: str = "/") -> Iterator[None]:
    token = set_mount_gate(prefix, MountMode.WRITE)
    try:
        yield
    finally:
        reset_mount_gate(token)


def _files(ctx: Context) -> CommandFiles:
    with with_reading(ctx, Reading(split=False)) as run:
        return command_files(run)


def _path(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


async def _drain(stream: AsyncIterator[bytes]) -> bytes:
    return b"".join([chunk async for chunk in stream])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "backend,prefix,path,error",
    [
        (Backend(implicit={"/sub"}), None, "/sub", IsADirectoryError),
        (Backend(), "/ghost/alpha/", "/ghost", IsADirectoryError),
        (Backend(), "/else/alpha/", "/ghost", FileNotFoundError),
        (Backend(listing=_fabricated), None, "/nope.txt", FileNotFoundError),
        (Backend(listing=_driver), None, "/nope.txt", FileNotFoundError),
        (
            Backend(listing=_refusing),
            None,
            "/locked/nope.txt",
            PermissionError,
        ),
    ],
    ids="implicit mount-parent unknown fabricated driver refused".split(),
)
async def test_dir_aware_stat_and_stream_judge_each_kind_of_directory(
    backend, prefix, path, error
):
    ctx = _ctx(backend, *([_row(prefix)] if prefix else []))
    with _on_mount():
        files = _files(ctx)
    with pytest.raises(error):
        await dir_aware_stat(files, ctx)(_path(path))
    with pytest.raises(error):
        await _drain(dir_aware_stream(files, ctx)(_path(path)))
    assert [v for n, v, _ in backend.calls if n == "read"] == []


@pytest.mark.asyncio
async def test_a_mount_reads_the_stored_bytes_and_a_run_across_renders():
    backend = Backend(stored={"/f": b"x"}, explicit={"/d"})
    with _on_mount():
        on_mount = _files(_ctx(backend))
    across = _files(_ctx(backend))
    assert await materialize(on_mount.read(_path("/f"))) == b"x"
    assert await materialize(across.read(_path("/f"))) == b"x"
    with pytest.raises(IsADirectoryError):
        await materialize(across.read(_path("/d")))
    assert [(name, kwargs) for name, _, kwargs in backend.calls] == [
        (
            "read",
            {"stream": True, "filetype": None, "offset": 0, "size": None},
        ),
        ("stat", {}),
        ("read", {"stream": True}),
        ("stat", {}),
    ]


@pytest.mark.asyncio
async def test_a_glob_past_its_mounts_limit_is_refused_and_none_is_stdin():
    backend = Backend(stored={f"/f{i}.txt": b"" for i in range(3)})
    row = _row("/", walk_limit=2)
    with _on_mount():
        capped = _files(_ctx(backend, row))
        roomy = _files(_ctx(backend, _row("/", walk_limit=3)))
    across = _files(_ctx(backend, row))
    spec = PathSpec(
        virtual="/*.txt",
        directory="/",
        vfs_path="*.txt",
        pattern="*.txt",
        resolved=False,
    )
    for files in (capped, across):
        with pytest.raises(GlobLimitError) as refused:
            await resolve_or_empty(files, [spec])
        assert str(refused.value) == (
            "/*.txt: matches more than 2 files (walk_limit); narrow the path"
        )
    assert len(await resolve_or_empty(roomy, [spec])) == 3
    assert await resolve_or_empty(capped, []) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "st,now,warm,pin,size",
    [
        (_st(size=7), None, False, None, 7),
        (_st(size=7), _st(size=9), False, None, None),
        (_st(size=7), None, True, None, None),
        (_st(size=7), None, False, {"/f": "v1"}, None),
        (_st(size=7, mode=0o644), None, False, None, None),
        (_st(), None, False, None, None),
        (_st(FileType.CHAR_DEVICE, size=0), None, False, None, None),
    ],
    ids="file moved cached pinned mode unsized device".split(),
)
async def test_file_size_answers_a_store_files_unmoved_unpinned_size(
    st, now, warm, pin, size
):
    ctx = _ctx(_answering(st, now, warm))
    with _on_mount():
        bound = file_size(command_files(ctx), ctx)
    token = push_revisions(pin)
    try:
        assert await bound(_path("/f")) == size
    finally:
        reset_revisions(token)


@pytest.mark.asyncio
async def test_a_glob_read_warms_the_operands_after_it():
    vfs = BatchedRAM()
    names = [f"/f{i:02}" for i in range(12)]
    vfs._store.files.update({name: b"x\n" for name in names})
    with Workspace({"/r/": vfs}) as ws:
        out = await ws.shell("cat /r/f*")
        assert await out.stdout_str() == "x\n" * 12
    warmed = [f"/r{name}" for name in names[1:]]
    assert vfs.reads == ["/r/f00"]
    assert vfs.batches == [warmed[:8], warmed[8:]]


class TreeRAM(RAMVFS):
    """A RAM mount noting each folder its tree read is asked for."""

    def __init__(self) -> None:
        super().__init__()
        self.trees: list[str] = []

    async def read_tree(self, path):
        self.trees.append(path.virtual)
        return await super().read_tree(path)


@pytest.mark.asyncio
async def test_a_walk_across_mounts_reads_no_tree_a_mount_sits_under():
    vfs = TreeRAM()
    vfs._store.dirs.update({"/d", "/d/sub", "/e"})
    vfs._store.files.update({"/d/x": b"", "/e/y": b""})
    nested = RAMVFS()
    nested._store.files["/z"] = b""
    with Workspace({"/r/": vfs, "/r/d/sub/": nested}) as ws:
        out = await ws.shell("ls -R /r")
        assert await out.stdout_str() == (
            "/r:\nd\ne\n\n/r/d:\nsub\nx\n\n/r/d/sub:\nz\n\n/r/e:\ny\n"
        )
    assert vfs.trees == ["/r/e"]
