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

from mirage.core.databricks_volume.rm import rm_recursive
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/dbx"))


def _seed_directory(files, path: str) -> None:
    files.directory_metadata.add(path)
    files.directories.setdefault(path, [])
    parent = path.rsplit("/", 1)[0]
    if parent and parent != path:
        files.directories.setdefault(parent, []).append(
            SimpleNamespace(path=path, is_directory=True, file_size=None))


def _seed_file(files, path: str, data: bytes = b"x") -> None:
    parent = path.rsplit("/", 1)[0]
    files.downloads[path] = data
    files.metadata[path] = SimpleNamespace(is_directory=False,
                                           file_size=len(data))
    files.directories.setdefault(parent, []).append(
        SimpleNamespace(path=path, is_directory=False, file_size=len(data)))


@pytest.mark.asyncio
async def test_rm_recursive_file(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)
    _seed_file(files, f"{remote_root}/a.txt")

    removed = await rm_recursive(accessor, _path("/dbx/a.txt"), index)

    assert removed == ["/a.txt"]
    assert f"{remote_root}/a.txt" not in files.downloads


@pytest.mark.asyncio
async def test_rm_recursive_nested_tree(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)
    _seed_directory(files, f"{remote_root}/d")
    _seed_file(files, f"{remote_root}/d/a.txt")
    _seed_directory(files, f"{remote_root}/d/sub")
    _seed_file(files, f"{remote_root}/d/sub/b.txt")

    removed = await rm_recursive(accessor, _path("/dbx/d"), index)

    assert f"{remote_root}/d/a.txt" in files.delete_calls
    assert f"{remote_root}/d/sub/b.txt" in files.delete_calls
    assert f"{remote_root}/d/sub" in files.delete_directory_calls
    assert f"{remote_root}/d" in files.delete_directory_calls
    assert "/d" in removed
    assert f"{remote_root}/d" not in files.directory_metadata


@pytest.mark.asyncio
async def test_rm_recursive_missing_raises(accessor, files, remote_root,
                                           index):
    _seed_directory(files, remote_root)

    with pytest.raises(FileNotFoundError):
        await rm_recursive(accessor, _path("/dbx/missing"), index)
