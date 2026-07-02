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

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.write import write_bytes
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_write_new_file(tmp_path):
    accessor = DiskAccessor(tmp_path)
    await write_bytes(
        accessor,
        PathSpec(resource_path="new.txt",
                 virtual="/new.txt",
                 directory="/new.txt"), b"content")
    assert (tmp_path / "new.txt").read_bytes() == b"content"


@pytest.mark.asyncio
async def test_overwrite_existing_file(tmp_path):
    (tmp_path / "exist.txt").write_bytes(b"old")
    accessor = DiskAccessor(tmp_path)
    await write_bytes(
        accessor,
        PathSpec(resource_path="exist.txt",
                 virtual="/exist.txt",
                 directory="/exist.txt"), b"new")
    assert (tmp_path / "exist.txt").read_bytes() == b"new"


@pytest.mark.asyncio
async def test_parent_directory_auto_creation(tmp_path):
    accessor = DiskAccessor(tmp_path)
    await write_bytes(
        accessor,
        PathSpec(resource_path="a/b/c/file.txt",
                 virtual="/a/b/c/file.txt",
                 directory="/a/b/c/file.txt"), b"deep")
    assert (tmp_path / "a" / "b" / "c" / "file.txt").read_bytes() == b"deep"
