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

from mirage.types import FileStat, FileType, PathSpec
from tests.fixtures.answers import Answers, run_generic

TREE = {"/m": ["/m/empty", "/m/locked"], "/m/empty": [], "/m/locked": []}


async def _readdir(path: PathSpec) -> list[str]:
    return TREE.get(path.virtual, [])


async def _stat(path: PathSpec) -> FileStat:
    if path.virtual.startswith("/m/locked/"):
        raise PermissionError(path.virtual)
    if path.virtual in TREE:
        return FileStat(name=path.virtual, type=FileType.DIRECTORY)
    raise FileNotFoundError(path.virtual)


def _mount(removed: list[str] | None = None) -> Answers:
    async def remove(path: PathSpec) -> None:
        assert removed is not None
        removed.append(path.virtual)

    if removed is None:
        return Answers("/m/", readdir=_readdir, stat=_stat)
    return Answers("/m/", readdir=_readdir, stat=_stat, rmdir=remove)


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual,
        vfs_path=virtual.lstrip("/"),
        resolved=True,
    )


async def _rmdir(mount: Answers, *paths: str) -> tuple[int, str]:
    _, io = await run_generic("rmdir", mount, [_spec(p) for p in paths])
    return io.exit_code, io.stderr.decode() if io.stderr else ""


@pytest.mark.asyncio
async def test_rmdir_stats_its_operand_through_the_dispatcher():
    removed: list[str] = []
    assert await _rmdir(_mount(removed), "/m/empty") == (0, "")
    assert removed == ["/m/empty"]


@pytest.mark.asyncio
async def test_rmdir_reports_an_existing_directory_it_cannot_remove():
    assert await _rmdir(_mount(), "/m/empty") == (
        1,
        "rmdir: failed to remove '/m/empty': Operation not supported\n",
    )


@pytest.mark.asyncio
async def test_rmdir_reports_a_refused_stat_and_removes_the_rest():
    removed: list[str] = []
    assert await _rmdir(_mount(removed), "/m/locked/sub", "/m/empty") == (
        1,
        "rmdir: failed to remove '/m/locked/sub': Permission denied\n",
    )
    assert removed == ["/m/empty"]
