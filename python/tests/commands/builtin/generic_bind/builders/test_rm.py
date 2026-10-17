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

from dataclasses import replace
from unittest.mock import AsyncMock

import pytest

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.generic_bind import generic
from mirage.commands.builtin.generic_bind.builders.rm import rm
from mirage.commands.config import CommandIO, Context
from mirage.errors.fs import walk_declined, walk_refusal
from mirage.io.stream import materialize
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.workspace.files import Files
from mirage.workspace.types import MountRow

INDEX = RAMIndexCacheStore()
TREE = {
    "/m": ["/m/a.txt", "/m/d", "/m/locked"],
    "/m/d": ["/m/d/x.txt"],
    "/m/locked": ["/m/locked/f.txt"],
}
FILES = {"/m/a.txt", "/m/d/x.txt", "/m/locked/f.txt"}


def _ops(removed: list[str] | None = None) -> CommandIO:
    async def readdir(_accessor, path, index=None):
        return TREE.get(path.virtual, [])

    async def stat(_accessor, path, index=None):
        # Served from the index, as github's is: a stat handed none finds
        # nothing, however real the file.
        if index is not INDEX:
            raise FileNotFoundError(path.virtual)
        if path.virtual.startswith("/m/locked/"):
            raise PermissionError(path.virtual)
        if path.virtual in TREE:
            return FileStat(name=path.virtual, type=FileType.DIRECTORY)
        if path.virtual in FILES:
            return FileStat(name=path.virtual, type=FileType.FILE)
        raise FileNotFoundError(path.virtual)

    async def read_bytes(_accessor, _path, index=None):
        return b""

    async def remove(_accessor, path, index=None):
        removed.append(path.virtual)

    writes = {} if removed is None else {"unlink": remove, "rm_r": remove}
    return CommandIO(
        readdir=readdir,
        read_bytes=read_bytes,
        read_stream=read_bytes,
        stat=stat,
        is_mounted=lambda _a: True,
        **writes,
    )


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual,
        vfs_path=virtual.lstrip("/"),
        resolved=True,
    )


async def _rm(
    ops: CommandIO, *paths: str, **flags: bool
) -> tuple[int, str, str]:
    out, io = await rm(
        ops,
        object(),
        [_spec(p) for p in paths],
        [],
        Context(flags=flags, index=INDEX),
    )
    stdout = (await materialize(out)).decode() if out is not None else ""
    stderr = io.stderr.decode() if io.stderr else ""
    return io.exit_code, stdout, stderr


@pytest.mark.asyncio
async def test_rm_stats_its_operand_through_the_index():
    removed: list[str] = []
    assert await _rm(_ops(removed), "/m/a.txt") == (0, "", "")
    assert removed == ["/m/a.txt"]


@pytest.mark.asyncio
async def test_rm_v_walks_the_tree_through_the_index():
    removed: list[str] = []
    listing = "removed '/m/d/x.txt'\nremoved directory '/m/d'\n"
    result = await _rm(_ops(removed), "/m/d", r=True, v=True)
    assert result == (0, listing, "")
    assert removed == ["/m/d"]


@pytest.mark.asyncio
async def test_rm_f_reports_an_existing_file_it_cannot_remove():
    # GNU's `ignorable_missing` spares ENOENT and ENOTDIR alone: a file
    # that exists on a filesystem refusing the unlink fails under -f too.
    refusal = "rm: cannot remove '/m/a.txt': Operation not supported\n"
    result = await _rm(_ops(), "/m/a.txt", "/m/nope", f=True)
    assert result == (1, "", refusal)


@pytest.mark.asyncio
async def test_rm_reports_a_refused_stat_and_removes_the_rest():
    removed: list[str] = []
    refusal = "rm: cannot remove '/m/locked/f.txt': Permission denied\n"
    result = await _rm(_ops(removed), "/m/locked/f.txt", "/m/a.txt", f=True)
    assert result == (1, "", refusal)
    assert removed == ["/m/a.txt"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "force,refusal,raw,code,stderr",
    [
        (
            False,
            "ELOOP",
            "loop/child",
            1,
            b"rm: cannot remove 'loop/child': "
            b"Too many levels of symbolic links\n",
        ),
        (True, "ENOENT", "", 0, None),
    ],
)
async def test_rm_refused_operand_keeps_spelling_and_continues(
    force, refusal, raw, code, stderr
):
    async def dispatched(_accessor, path, index=None):
        if path.walk_error is not None:
            raise walk_refusal(path)
        return FileStat(name="ok", type=FileType.FILE)

    stat = AsyncMock(side_effect=dispatched)
    unlink = AsyncMock()
    io = CommandIO(
        readdir=AsyncMock(return_value=[]),
        read_bytes=AsyncMock(),
        read_stream=AsyncMock(),
        stat=stat,
        is_mounted=lambda _: True,
        unlink=unlink,
        rmdir=AsyncMock(),
        rm_r=AsyncMock(),
    )
    refused = replace(
        PathSpec.from_str_path("/data"), raw_path=raw, walk_error=refusal
    )
    valid = PathSpec.from_str_path("/data/ok")
    _, result = await generic("rm").fn(
        None, [refused, valid], [], Context(flags={"f": force}, io=io)
    )
    assert (result.exit_code, result.stderr) == (code, stderr)
    assert stat.await_count == 2
    assert unlink.await_args.args[1] == valid


async def _declined_rm_r(
    _accessor: None, path: PathSpec, index: None = None
) -> None:
    raise walk_declined("s3", "rm_r", path)


@pytest.mark.asyncio
async def test_rm_r_names_a_mount_below_and_fails():
    tree = {"/data": ["/data/a.txt", "/data/inner"]}

    async def readdir(_accessor, path, index=None):
        return tree.get(path.virtual, [])

    async def stat(_accessor, path, index=None):
        kind = FileType.DIRECTORY if path.virtual in tree else FileType.FILE
        return FileStat(name=path.virtual, type=kind)

    unlink = AsyncMock()
    rmdir = AsyncMock()
    io = CommandIO(
        readdir=readdir,
        read_bytes=AsyncMock(),
        read_stream=AsyncMock(),
        stat=stat,
        is_mounted=lambda _: True,
        unlink=unlink,
        rmdir=rmdir,
        rm_r=_declined_rm_r,
    )
    files = Files(
        [
            MountRow(prefix=p, resource_type="ram", mode=MountMode.WRITE)
            for p in ("/data/", "/data/inner/")
        ],
        AsyncMock(),
    )
    _, result = await generic("rm").fn(
        None,
        [PathSpec.from_str_path("/data")],
        [],
        Context(flags={"r": True}, io=io, vfs=files),
    )
    assert result.exit_code == 1
    assert result.stderr == (
        b"rm: skipping '/data/inner', since it's on a different device\n"
    )
    assert [c.args[1].virtual for c in unlink.await_args_list] == [
        "/data/a.txt"
    ]
    rmdir.assert_not_awaited()
