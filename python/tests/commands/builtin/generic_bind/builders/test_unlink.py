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
from mirage.commands.builtin.generic_bind.builders.unlink import unlink
from mirage.commands.config import CommandIO, CommandOpts
from mirage.types import FileStat, FileType, PathSpec

INDEX = RAMIndexCacheStore()


def _ops(removed: list[str] | None = None) -> CommandIO:
    async def readdir(_accessor, path, index=None):
        return ["/m/a.txt", "/m/locked"] if path.virtual == "/m" else []

    async def stat(_accessor, path, index=None):
        # Served from the index, as github's is: a stat handed none finds
        # nothing, however real the file.
        if index is not INDEX:
            raise FileNotFoundError(path.virtual)
        if path.virtual.startswith("/m/locked/"):
            raise PermissionError(path.virtual)
        if path.virtual == "/m/a.txt":
            return FileStat(name=path.virtual, type=FileType.FILE)
        raise FileNotFoundError(path.virtual)

    async def read_bytes(_accessor, _path, index=None):
        return b""

    async def remove(_accessor, path, index=None):
        removed.append(path.virtual)

    writes = {} if removed is None else {"unlink": remove}
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


async def _unlink(ops: CommandIO, path: str) -> tuple[int, str]:
    _, io = await unlink(
        ops, object(), [_spec(path)], [], CommandOpts(index=INDEX)
    )
    return io.exit_code, io.stderr.decode() if io.stderr else ""


@pytest.mark.asyncio
async def test_unlink_stats_its_operand_through_the_index():
    removed: list[str] = []
    assert await _unlink(_ops(removed), "/m/a.txt") == (0, "")
    assert removed == ["/m/a.txt"]


@pytest.mark.asyncio
async def test_unlink_reports_an_existing_file_it_cannot_remove():
    assert await _unlink(_ops(), "/m/a.txt") == (
        1,
        "unlink: cannot unlink '/m/a.txt': Operation not supported\n",
    )


@pytest.mark.asyncio
async def test_unlink_reports_a_refused_stat():
    assert await _unlink(_ops(), "/m/locked/f.txt") == (
        1,
        "unlink: cannot unlink '/m/locked/f.txt': Permission denied\n",
    )
