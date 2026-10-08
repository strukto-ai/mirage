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

import pytest

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.generic_bind.builders.rm import rm
from mirage.commands.config import CommandIO, CommandOpts
from mirage.io.stream import materialize
from mirage.types import FileStat, FileType, PathSpec

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
        CommandOpts(flags=flags, index=INDEX),
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
