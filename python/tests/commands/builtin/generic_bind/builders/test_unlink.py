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


async def _readdir(path: PathSpec) -> list[str]:
    return ["/m/a.txt", "/m/locked"] if path.virtual == "/m" else []


async def _stat(path: PathSpec) -> FileStat:
    if path.virtual.startswith("/m/locked/"):
        raise PermissionError(path.virtual)
    if path.virtual == "/m/a.txt":
        return FileStat(name=path.virtual, type=FileType.FILE)
    raise FileNotFoundError(path.virtual)


def _mount(removed: list[str] | None = None) -> Answers:
    async def remove(path: PathSpec) -> None:
        assert removed is not None
        removed.append(path.virtual)

    if removed is None:
        return Answers("/m/", readdir=_readdir, stat=_stat)
    return Answers("/m/", readdir=_readdir, stat=_stat, unlink=remove)


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual,
        vfs_path=virtual.lstrip("/"),
        resolved=True,
    )


async def _unlink(mount: Answers, path: str) -> tuple[int, str]:
    _, io = await run_generic("unlink", mount, [_spec(path)])
    return io.exit_code, io.stderr.decode() if io.stderr else ""


@pytest.mark.asyncio
async def test_unlink_stats_its_operand_through_the_dispatcher():
    removed: list[str] = []
    assert await _unlink(_mount(removed), "/m/a.txt") == (0, "")
    assert removed == ["/m/a.txt"]


@pytest.mark.asyncio
async def test_unlink_reports_an_existing_file_it_cannot_remove():
    assert await _unlink(_mount(), "/m/a.txt") == (
        1,
        "unlink: cannot unlink '/m/a.txt': Operation not supported\n",
    )


@pytest.mark.asyncio
async def test_unlink_reports_a_refused_stat():
    assert await _unlink(_mount(), "/m/locked/f.txt") == (
        1,
        "unlink: cannot unlink '/m/locked/f.txt': Permission denied\n",
    )
