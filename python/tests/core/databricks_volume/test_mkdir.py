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

from mirage.core.databricks_volume.mkdir import mkdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from tests.fixtures.databricks_volume import DIRS


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/dbx"))


@pytest.mark.asyncio
async def test_mkdir_creates_directory(accessor, volume, remote_root):
    await volume.mkdir(remote_root)
    await volume.run.record_requests()

    await mkdir(accessor, _path("/dbx/newdir"))

    assert f"{remote_root}/newdir" in await volume.asked("PUT", DIRS)
    assert await volume.has(f"{remote_root}/newdir")


@pytest.mark.asyncio
async def test_mkdir_parent_missing_fails(accessor, volume, remote_root):
    await volume.mkdir(remote_root)
    await volume.run.record_requests()

    with pytest.raises(FileNotFoundError) as raised:
        await mkdir(accessor, _path("/dbx/a/b"))
    assert raised.value.filename == "/dbx/a/b"
    assert await volume.asked("PUT", DIRS) == []


@pytest.mark.asyncio
async def test_mkdir_parents_creates_chain(accessor, volume, remote_root):
    await volume.mkdir(remote_root)

    await mkdir(accessor, _path("/dbx/a/b/c"), parents=True)

    assert await volume.has(f"{remote_root}/a/b/c")


@pytest.mark.asyncio
async def test_mkdir_parent_is_file_fails(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/file.txt", b"abc")

    with pytest.raises(NotADirectoryError):
        await mkdir(accessor, _path("/dbx/file.txt/sub"))
