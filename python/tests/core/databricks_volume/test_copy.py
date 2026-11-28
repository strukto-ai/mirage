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

from mirage.core.databricks_volume.copy import copy
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from tests.fixtures.databricks_volume import DIRS, FILES


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/dbx"))


@pytest.mark.asyncio
async def test_copy_file_preserves_bytes(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/src.txt", b"hello")

    await copy(accessor, _path("/dbx/src.txt"), _path("/dbx/dst.txt"))

    assert await volume.content(f"{remote_root}/dst.txt") == b"hello"
    assert await volume.content(f"{remote_root}/src.txt") == b"hello"


@pytest.mark.asyncio
async def test_copy_missing_source_fails(accessor, volume, remote_root):
    await volume.mkdir(remote_root)

    with pytest.raises(FileNotFoundError):
        await copy(accessor, _path("/dbx/missing.txt"), _path("/dbx/dst.txt"))


@pytest.mark.asyncio
async def test_copy_missing_parent_fails(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/src.txt", b"hi")

    with pytest.raises(FileNotFoundError):
        await copy(
            accessor,
            _path("/dbx/src.txt"),
            _path("/dbx/missing/dst.txt"),
        )


@pytest.mark.asyncio
async def test_copy_directory_without_recursive_fails(
    accessor, volume, remote_root
):
    await volume.mkdir(f"{remote_root}/d")

    with pytest.raises(IsADirectoryError):
        await copy(accessor, _path("/dbx/d"), _path("/dbx/d2"))


@pytest.mark.asyncio
async def test_copy_same_path_is_noop(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/src.txt", b"hello")

    await copy(accessor, _path("/dbx/src.txt"), _path("/dbx/src.txt"))

    assert await volume.content(f"{remote_root}/src.txt") == b"hello"


@pytest.mark.asyncio
async def test_copy_same_missing_path_fails(accessor, volume, remote_root):
    await volume.mkdir(remote_root)

    with pytest.raises(FileNotFoundError):
        await copy(
            accessor,
            _path("/dbx/missing.txt"),
            _path("/dbx/missing.txt"),
        )


@pytest.mark.asyncio
async def test_copy_same_dir_without_recursive_fails(
    accessor, volume, remote_root
):
    await volume.mkdir(f"{remote_root}/d")

    with pytest.raises(IsADirectoryError):
        await copy(accessor, _path("/dbx/d"), _path("/dbx/d"))


@pytest.mark.asyncio
async def test_copy_recursive_tree(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/d/a.txt", b"aaa")

    await copy(accessor, _path("/dbx/d"), _path("/dbx/d2"), recursive=True)

    assert await volume.has(f"{remote_root}/d2")
    assert await volume.content(f"{remote_root}/d2/a.txt") == b"aaa"


@pytest.mark.asyncio
async def test_copy_recursive_into_own_subtree_fails(
    accessor, volume, remote_root
):
    await volume.put(f"{remote_root}/d/a.txt", b"aaa")
    await volume.run.record_requests()

    with pytest.raises(ValueError):
        await copy(
            accessor, _path("/dbx/d"), _path("/dbx/d/d"), recursive=True
        )

    assert await volume.asked("PUT", DIRS) == []
    assert await volume.asked("PUT", FILES) == []
    assert await volume.content(f"{remote_root}/d/a.txt") == b"aaa"
