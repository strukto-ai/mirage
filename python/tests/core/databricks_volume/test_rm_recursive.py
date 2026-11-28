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

from mirage.core.databricks_volume.rm import rm_recursive
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from tests.fixtures.databricks_volume import DIRS, FILES


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/dbx"))


@pytest.mark.asyncio
async def test_rm_recursive_file(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/a.txt", b"x")

    removed = await rm_recursive(accessor, _path("/dbx/a.txt"))

    assert removed == ["/a.txt"]
    assert not await volume.has(f"{remote_root}/a.txt")


@pytest.mark.asyncio
async def test_rm_recursive_nested_tree(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/d/a.txt", b"x")
    await volume.put(f"{remote_root}/d/sub/b.txt", b"x")
    await volume.run.record_requests()

    removed = await rm_recursive(accessor, _path("/dbx/d"))

    deleted_files = await volume.asked("DELETE", FILES)
    deleted_dirs = await volume.asked("DELETE", DIRS)
    assert f"{remote_root}/d/a.txt" in deleted_files
    assert f"{remote_root}/d/sub/b.txt" in deleted_files
    assert f"{remote_root}/d/sub" in deleted_dirs
    assert f"{remote_root}/d" in deleted_dirs
    assert "/d" in removed
    assert not await volume.has(f"{remote_root}/d")


@pytest.mark.asyncio
async def test_rm_recursive_keeps_a_file_written_during_the_walk(
    accessor, volume, remote_root
):
    # The Files API deletes only an empty directory: a file written after
    # the listing refuses it, and the removal is ENOTEMPTY. Another client
    # writes it while the walk's first delete waits.
    await volume.put(f"{remote_root}/d/a.txt", b"x")
    await volume.run.before_next(
        [("DELETE", FILES)],
        lambda: volume.put(f"{remote_root}/d/late.txt", b"late"),
    )
    with pytest.raises(OSError) as refused:
        await rm_recursive(accessor, _path("/dbx/d"))
    assert refused.value.errno == errno.ENOTEMPTY
    assert await volume.content(f"{remote_root}/d/late.txt") == b"late"
    assert await volume.has(f"{remote_root}/d")


@pytest.mark.asyncio
async def test_rm_recursive_missing_raises(accessor, volume, remote_root):
    await volume.mkdir(remote_root)

    with pytest.raises(FileNotFoundError):
        await rm_recursive(accessor, _path("/dbx/missing"))
