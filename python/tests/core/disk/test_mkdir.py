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
from mirage.core.disk.mkdir import mkdir
from mirage.types import PathSpec


def spec(virtual: str) -> PathSpec:
    return PathSpec(resource_path=virtual.lstrip("/"),
                    virtual=virtual,
                    directory=virtual)


@pytest.mark.asyncio
async def test_mkdir_creates_a_directory(tmp_path):
    accessor = DiskAccessor(tmp_path)
    await mkdir(accessor, spec("/d"))
    assert (tmp_path / "d").is_dir()


@pytest.mark.asyncio
async def test_mkdir_refuses_an_existing_directory(tmp_path):
    accessor = DiskAccessor(tmp_path)
    await mkdir(accessor, spec("/d"))
    # Only -p is idempotent; plain mkdir refuses an existing target (GNU).
    with pytest.raises(FileExistsError):
        await mkdir(accessor, spec("/d"))
    await mkdir(accessor, spec("/d"), parents=True)


@pytest.mark.asyncio
async def test_mkdir_refuses_an_existing_file(tmp_path):
    (tmp_path / "a.txt").write_bytes(b"hi")
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(FileExistsError):
        await mkdir(accessor, spec("/a.txt"))
    assert (tmp_path / "a.txt").read_bytes() == b"hi"


@pytest.mark.asyncio
async def test_mkdir_p_across_a_file_names_the_component(tmp_path):
    (tmp_path / "a.txt").write_bytes(b"hi")
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(NotADirectoryError) as excinfo:
        await mkdir(accessor, spec("/a.txt/sub"), parents=True)
    # The kernel names the whole path; GNU names the component it tripped
    # on, and the host root never appears.
    assert str(excinfo.value) == "/a.txt"
    assert str(tmp_path) not in str(excinfo.value)
    assert (tmp_path / "a.txt").read_bytes() == b"hi"


@pytest.mark.asyncio
async def test_mkdir_p_onto_a_file_target_is_eexist(tmp_path):
    (tmp_path / "a.txt").write_bytes(b"hi")
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(FileExistsError) as excinfo:
        await mkdir(accessor, spec("/a.txt"), parents=True)
    assert str(tmp_path) not in str(excinfo.value)


@pytest.mark.asyncio
async def test_mkdir_p_builds_the_chain(tmp_path):
    accessor = DiskAccessor(tmp_path)
    await mkdir(accessor, spec("/a/b/c"), parents=True)
    assert (tmp_path / "a" / "b" / "c").is_dir()


@pytest.mark.asyncio
async def test_mkdir_missing_parent_reports_the_virtual_path(tmp_path):
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(FileNotFoundError) as excinfo:
        await mkdir(accessor, spec("/nodir/sub"))
    assert str(tmp_path) not in str(excinfo.value)
