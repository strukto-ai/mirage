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

from mirage.core.databricks_volume.rmdir import rmdir
from mirage.types import PathSpec


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, "/dbx")


def _seed_directory(files, path: str) -> None:
    files.directory_metadata.add(path)
    files.directories.setdefault(path, [])


def _seed_file(files, path: str, data: bytes = b"x") -> None:
    parent = path.rsplit("/", 1)[0]
    files.downloads[path] = data
    files.metadata[path] = SimpleNamespace(is_directory=False,
                                           file_size=len(data))
    files.directories.setdefault(parent, [])
    files.directories[parent].append(
        SimpleNamespace(path=path, is_directory=False, file_size=len(data)))


@pytest.mark.asyncio
async def test_rmdir_empty_succeeds(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)
    _seed_directory(files, f"{remote_root}/empty")

    await rmdir(accessor, _path("/dbx/empty"), index)

    assert files.delete_directory_calls == [f"{remote_root}/empty"]
    assert f"{remote_root}/empty" not in files.directory_metadata


@pytest.mark.asyncio
async def test_rmdir_non_empty_fails(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)
    _seed_directory(files, f"{remote_root}/full")
    _seed_file(files, f"{remote_root}/full/a.txt")

    with pytest.raises(OSError):
        await rmdir(accessor, _path("/dbx/full"), index)
    assert files.delete_directory_calls == []


@pytest.mark.asyncio
async def test_rmdir_file_target_fails(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)
    _seed_file(files, f"{remote_root}/a.txt")

    with pytest.raises(NotADirectoryError):
        await rmdir(accessor, _path("/dbx/a.txt"), index)


@pytest.mark.asyncio
async def test_rmdir_missing_fails(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)

    with pytest.raises(FileNotFoundError):
        await rmdir(accessor, _path("/dbx/missing"), index)
