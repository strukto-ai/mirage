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

from types import SimpleNamespace

import pytest

from mirage.core.databricks_volume.mkdir import mkdir
from mirage.types import PathSpec


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, "/dbx")


def _seed_directory(files, path: str) -> None:
    files.directory_metadata.add(path)
    files.directories.setdefault(path, [])


@pytest.mark.asyncio
async def test_mkdir_creates_directory(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)

    await mkdir(accessor, _path("/dbx/newdir"), index)

    assert f"{remote_root}/newdir" in files.create_directory_calls
    assert f"{remote_root}/newdir" in files.directory_metadata


@pytest.mark.asyncio
async def test_mkdir_parent_missing_fails(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)

    with pytest.raises(FileNotFoundError):
        await mkdir(accessor, _path("/dbx/a/b"), index)
    assert files.create_directory_calls == []


@pytest.mark.asyncio
async def test_mkdir_parents_creates_chain(accessor, files, remote_root,
                                           index):
    _seed_directory(files, remote_root)

    await mkdir(accessor, _path("/dbx/a/b/c"), index, parents=True)

    assert f"{remote_root}/a/b/c" in files.directory_metadata


@pytest.mark.asyncio
async def test_mkdir_existing_target_fails(accessor, files, remote_root,
                                           index):
    _seed_directory(files, remote_root)
    _seed_directory(files, f"{remote_root}/exists")

    with pytest.raises(FileExistsError):
        await mkdir(accessor, _path("/dbx/exists"), index)


@pytest.mark.asyncio
async def test_mkdir_parent_is_file_fails(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)
    files.metadata[f"{remote_root}/file.txt"] = SimpleNamespace(
        is_directory=False, file_size=3)

    with pytest.raises(NotADirectoryError):
        await mkdir(accessor, _path("/dbx/file.txt/sub"), index)
