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
async def test_write_does_not_create_parents(tmp_path):
    # A write is not `mkdir -p`: GNU `echo x > a/b/c/file.txt` fails with
    # ENOENT rather than building the chain, and the store-backed backends
    # refuse the same way.
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(FileNotFoundError):
        await write_bytes(
            accessor,
            PathSpec(resource_path="a/b/c/file.txt",
                     virtual="/a/b/c/file.txt",
                     directory="/a/b/c/file.txt"), b"deep")
    assert not (tmp_path / "a").exists()


@pytest.mark.asyncio
async def test_write_into_an_existing_dir(tmp_path):
    (tmp_path / "d").mkdir()
    accessor = DiskAccessor(tmp_path)
    await write_bytes(
        accessor,
        PathSpec(resource_path="d/file.txt",
                 virtual="/d/file.txt",
                 directory="/d/file.txt"), b"deep")
    assert (tmp_path / "d" / "file.txt").read_bytes() == b"deep"


@pytest.mark.asyncio
async def test_write_under_a_plain_file_is_not_a_directory(tmp_path):
    (tmp_path / "plain").write_bytes(b"x")
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(NotADirectoryError):
        await write_bytes(
            accessor,
            PathSpec(resource_path="plain/file.txt",
                     virtual="/plain/file.txt",
                     directory="/plain/file.txt"), b"data")


@pytest.mark.asyncio
async def test_write_error_reports_the_virtual_path(tmp_path):
    # The host root is an implementation detail of the mount: only the
    # virtual path may reach a user-facing stderr line.
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(FileNotFoundError) as excinfo:
        await write_bytes(
            accessor,
            PathSpec(resource_path="nodir/file.txt",
                     virtual="/data/nodir/file.txt",
                     directory="/data/nodir/file.txt"), b"data")
    assert str(tmp_path) not in str(excinfo.value)
    assert "/data/nodir/file.txt" in str(excinfo.value)
