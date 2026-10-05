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
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.generic_bind.builders.rmdir import rmdir
from mirage.commands.config import CommandOpts
from mirage.types import FileStat, FileType, PathSpec

INDEX = RAMIndexCacheStore()
TREE = {"/m": ["/m/empty", "/m/locked"], "/m/empty": [], "/m/locked": []}


def _ops(removed: list[str] | None = None) -> CommandIO:
    async def readdir(_accessor, path, index=None):
        return TREE.get(path.virtual, [])

    async def stat(_accessor, path, index=None):
        # Served from the index, as github's is: a stat handed none finds
        # nothing, however real the directory.
        if index is not INDEX:
            raise FileNotFoundError(path.virtual)
        if path.virtual.startswith("/m/locked/"):
            raise PermissionError(path.virtual)
        if path.virtual in TREE:
            return FileStat(name=path.virtual, type=FileType.DIRECTORY)
        raise FileNotFoundError(path.virtual)

    async def read_bytes(_accessor, _path, index=None):
        return b""

    async def remove(_accessor, path, index=None):
        removed.append(path.virtual)

    writes = {} if removed is None else {"rmdir": remove}
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


async def _rmdir(ops: CommandIO, *paths: str) -> tuple[int, str]:
    _, io = await rmdir(
        ops, object(), [_spec(p) for p in paths], [], CommandOpts(index=INDEX)
    )
    return io.exit_code, io.stderr.decode() if io.stderr else ""


@pytest.mark.asyncio
async def test_rmdir_stats_its_operand_through_the_index():
    removed: list[str] = []
    assert await _rmdir(_ops(removed), "/m/empty") == (0, "")
    assert removed == ["/m/empty"]


@pytest.mark.asyncio
async def test_rmdir_reports_an_existing_directory_it_cannot_remove():
    assert await _rmdir(_ops(), "/m/empty") == (
        1,
        "rmdir: failed to remove '/m/empty': Operation not supported\n",
    )


@pytest.mark.asyncio
async def test_rmdir_reports_a_refused_stat_and_removes_the_rest():
    removed: list[str] = []
    assert await _rmdir(_ops(removed), "/m/locked/sub", "/m/empty") == (
        1,
        "rmdir: failed to remove '/m/locked/sub': Permission denied\n",
    )
    assert removed == ["/m/empty"]
