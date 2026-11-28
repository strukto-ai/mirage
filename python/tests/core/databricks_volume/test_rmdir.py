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

from mirage.core.databricks_volume.rmdir import rmdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from tests.fixtures.databricks_volume import DIRS


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/dbx"))


@pytest.mark.asyncio
async def test_rmdir_empty_succeeds(accessor, volume, remote_root):
    await volume.mkdir(f"{remote_root}/empty")
    await volume.run.record_requests()

    await rmdir(accessor, _path("/dbx/empty"))

    assert await volume.asked("DELETE", DIRS) == [f"{remote_root}/empty"]
    assert not await volume.has(f"{remote_root}/empty")


@pytest.mark.asyncio
async def test_rmdir_non_empty_fails(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/full/a.txt", b"x")
    await volume.run.record_requests()

    with pytest.raises(OSError):
        await rmdir(accessor, _path("/dbx/full"))
    assert await volume.asked("DELETE", DIRS) == []


@pytest.mark.asyncio
async def test_rmdir_refuses_a_child_written_after_the_listing(
    accessor, volume, remote_root
):
    # Another client writes a file into the directory between the listing
    # that found it empty and the delete, which the Files API refuses.
    await volume.mkdir(f"{remote_root}/empty")
    await volume.run.before_next(
        [("DELETE", DIRS)],
        lambda: volume.put(f"{remote_root}/empty/late.txt", b"x"),
    )
    with pytest.raises(OSError) as refused:
        await rmdir(accessor, _path("/dbx/empty"))
    assert refused.value.errno == errno.ENOTEMPTY
    assert await volume.has(f"{remote_root}/empty/late.txt")


@pytest.mark.asyncio
async def test_rmdir_file_target_fails(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/a.txt", b"x")

    with pytest.raises(NotADirectoryError):
        await rmdir(accessor, _path("/dbx/a.txt"))


@pytest.mark.asyncio
async def test_rmdir_missing_fails(accessor, volume, remote_root):
    await volume.mkdir(remote_root)

    with pytest.raises(FileNotFoundError):
        await rmdir(accessor, _path("/dbx/missing"))
