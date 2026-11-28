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
from collections.abc import Awaitable, Callable

import pytest

from mirage.core.databricks_volume.rename import rename
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from tests.fixtures.databricks_volume import DIRS, FILES


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/dbx"))


async def _while_listing(
    volume, nth: int, change: Callable[[], Awaitable[None]]
) -> None:
    """Run ``change`` while the ``nth`` directory listing from now waits:
    each listing before it, held, arms the hold on the next.

    Args:
        volume (DatabricksVolume): the volume.
        nth (int): which listing, counting from one.
        change (Callable[[], Awaitable[None]]): what another client does.
    """
    if nth == 1:
        await volume.run.before_next([("GET", DIRS)], change)
        return
    await volume.run.before_next(
        [("GET", DIRS)], lambda: _while_listing(volume, nth - 1, change)
    )


@pytest.mark.asyncio
async def test_rename_file_moves_bytes(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/src.txt", b"data")

    await rename(accessor, _path("/dbx/src.txt"), _path("/dbx/dst.txt"))

    assert await volume.content(f"{remote_root}/dst.txt") == b"data"
    assert not await volume.has(f"{remote_root}/src.txt")


@pytest.mark.asyncio
async def test_rename_missing_source_fails(accessor, volume, remote_root):
    await volume.mkdir(remote_root)

    with pytest.raises(FileNotFoundError):
        await rename(
            accessor, _path("/dbx/missing.txt"), _path("/dbx/dst.txt")
        )


@pytest.mark.asyncio
async def test_rename_same_path_is_noop(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/src.txt", b"data")
    await volume.run.record_requests()

    await rename(accessor, _path("/dbx/src.txt"), _path("/dbx/src.txt"))

    assert await volume.content(f"{remote_root}/src.txt") == b"data"
    assert await volume.asked("DELETE", FILES) == []


@pytest.mark.asyncio
async def test_rename_same_missing_path_fails(accessor, volume, remote_root):
    await volume.mkdir(remote_root)

    with pytest.raises(FileNotFoundError):
        await rename(
            accessor,
            _path("/dbx/missing.txt"),
            _path("/dbx/missing.txt"),
        )


@pytest.mark.asyncio
async def test_rename_directory_moves_tree(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/d/a.txt", b"aaa")

    await rename(accessor, _path("/dbx/d"), _path("/dbx/d2"))

    assert await volume.content(f"{remote_root}/d2/a.txt") == b"aaa"
    assert not await volume.has(f"{remote_root}/d")


@pytest.mark.asyncio
async def test_rename_into_own_subtree_fails(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/d/a.txt", b"aaa")
    await volume.run.record_requests()

    with pytest.raises(ValueError):
        await rename(accessor, _path("/dbx/d"), _path("/dbx/d/d"))

    assert await volume.content(f"{remote_root}/d/a.txt") == b"aaa"
    assert await volume.has(f"{remote_root}/d")
    assert await volume.asked("PUT", DIRS) == []
    assert await volume.asked("PUT", FILES) == []
    assert await volume.asked("DELETE", FILES) == []
    assert await volume.asked("DELETE", DIRS) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("late", ["file", "directory", "replaced"])
async def test_rename_keeps_an_entry_written_after_the_copy(
    accessor, volume, remote_root, late
):
    # Only what the copy carried is deleted: an entry written under the
    # source since, or one replaced since its copy, stays there, and the
    # move is ENOTEMPTY rather than a loss. Another client writes it once
    # the copy is done, while the delete walk's listing of the source
    # waits: the copy lists the source, and `late` too when it is there.
    d = f"{remote_root}/d"
    if late == "replaced":
        await volume.mkdir(f"{d}/late")
    await volume.put(f"{d}/a.txt", b"aaa")

    async def write_late() -> None:
        if late == "directory":
            await volume.mkdir(f"{d}/late")
            return
        if late == "replaced":
            await volume.rmdir(f"{d}/late")
        await volume.put(f"{d}/late", b"late")

    await _while_listing(volume, 3 if late == "replaced" else 2, write_late)
    with pytest.raises(OSError) as refused:
        await rename(accessor, _path("/dbx/d"), _path("/dbx/d2"))
    assert refused.value.errno == errno.ENOTEMPTY
    assert await volume.content(f"{remote_root}/d2/a.txt") == b"aaa"
    assert not await volume.has(f"{d}/a.txt")
    if late == "directory":
        assert await volume.has(f"{d}/late")
    else:
        assert await volume.content(f"{d}/late") == b"late"
