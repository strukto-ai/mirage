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

from mirage.core.sql.create import create
from mirage.core.sql.fingerprint import token_of
from mirage.core.sql.path import walk
from mirage.core.sql.write import write
from mirage.types import FileStat, PathSpec
from mirage.utils.clock import ManualClock, run_with_system_clock
from mirage.vfs.sql import SqlVFS
from mirage.vfs.sql.driver import SqliteDriver


def at(p: str) -> PathSpec:
    return PathSpec.from_str_path(p)


def test_a_token_names_the_inode_and_the_nanosecond():
    assert token_of(7, 1_800_000_000, 5) == "7:1800000000.000000005"


async def _rewritten(vfs: SqlVFS) -> tuple[FileStat, FileStat, FileStat]:
    await vfs.write(at("/f"), b"one")
    first = await vfs.stat(at("/f"))
    await vfs.write(at("/f"), b"two")
    second = await vfs.stat(at("/f"))
    tree = await vfs.read_tree(at("/"))
    assert tree is not None
    return first, second, tree["f"]


@pytest.mark.asyncio
async def test_a_same_size_rewrite_moves_it_on_a_clock_that_stands_still():
    driver = SqliteDriver()
    vfs = SqlVFS(driver=driver)
    try:
        first, second, row = await run_with_system_clock(
            ManualClock(1_800_000_000), _rewritten(vfs)
        )
    finally:
        await vfs.close()
        driver.close()
    assert first.fingerprint != second.fingerprint
    assert row.fingerprint == second.fingerprint


async def _rewritten_by_another(path: str) -> tuple[FileStat, FileStat]:
    first_driver, second_driver = SqliteDriver(path), SqliteDriver(path)
    first, second = SqlVFS(driver=first_driver), SqlVFS(driver=second_driver)
    try:
        await first.write(at("/f"), b"one")
        before = await first.stat(at("/f"))
        await second.write(at("/f"), b"two")
        return before, await first.stat(at("/f"))
    finally:
        await first.close()
        await second.close()
        first_driver.close()
        second_driver.close()


@pytest.mark.asyncio
async def test_a_rewrite_through_another_driver_moves_it(tmp_path):
    # Each driver keeps its own last stamp, so on a clock that stands still
    # only the file's own stored time keeps the second write past the first.
    before, after = await run_with_system_clock(
        ManualClock(1_800_000_000),
        _rewritten_by_another(str(tmp_path / "db.sqlite")),
    )
    assert before.fingerprint != after.fingerprint


async def _crossed(path: str) -> tuple[FileStat, FileStat]:
    first_driver, second_driver = SqliteDriver(path), SqliteDriver(path)
    first, second = SqlVFS(driver=first_driver), SqlVFS(driver=second_driver)
    try:
        await first.write(at("/f"), b"one")
        read = await walk(first.accessor, at("/f"))
        await second.write(at("/f"), b"two")
        theirs = await first.stat(at("/f"))
        await write(first.accessor, at("/f"), b"six", walked=read)
        return theirs, await first.stat(at("/f"))
    finally:
        await first.close()
        await second.close()
        first_driver.close()
        second_driver.close()


@pytest.mark.asyncio
async def test_a_replacement_over_a_file_changed_since_its_walk_moves_it(
    tmp_path,
):
    # Both writes start from the same inode as the walk read it; the guard
    # sends the second back to the inode as it is, so it lands past the
    # first instead of on the same time.
    theirs, ours = await run_with_system_clock(
        ManualClock(1_800_000_000), _crossed(str(tmp_path / "db.sqlite"))
    )
    assert theirs.fingerprint != ours.fingerprint


async def _emptied_by_another(path: str) -> tuple[FileStat, FileStat]:
    first_driver, second_driver = SqliteDriver(path), SqliteDriver(path)
    first, second = SqlVFS(driver=first_driver), SqlVFS(driver=second_driver)
    try:
        await first.write(at("/f"), b"")
        before = await first.stat(at("/f"))
        await create(second.accessor, at("/f"))
        return before, await first.stat(at("/f"))
    finally:
        await first.close()
        await second.close()
        first_driver.close()
        second_driver.close()


@pytest.mark.asyncio
async def test_create_over_a_file_another_driver_wrote_moves_it(tmp_path):
    before, after = await run_with_system_clock(
        ManualClock(1_800_000_000),
        _emptied_by_another(str(tmp_path / "db.sqlite")),
    )
    assert before.fingerprint != after.fingerprint
