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

from mirage.core.databricks_volume.copy import copy
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


def _seed_file(files, path: str, data: bytes) -> None:
    parent = path.rsplit("/", 1)[0]
    files.downloads[path] = data
    files.metadata[path] = SimpleNamespace(is_directory=False,
                                           file_size=len(data))
    files.directories.setdefault(parent, []).append(
        SimpleNamespace(path=path, is_directory=False, file_size=len(data)))


@pytest.mark.asyncio
async def test_copy_file_preserves_bytes(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)
    _seed_file(files, f"{remote_root}/src.txt", b"hello")

    await copy(accessor, _path("/dbx/src.txt"), _path("/dbx/dst.txt"), index)

    assert files.downloads[f"{remote_root}/dst.txt"] == b"hello"
    assert files.downloads[f"{remote_root}/src.txt"] == b"hello"


@pytest.mark.asyncio
async def test_copy_missing_source_fails(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)

    with pytest.raises(FileNotFoundError):
        await copy(accessor, _path("/dbx/missing.txt"), _path("/dbx/dst.txt"),
                   index)


@pytest.mark.asyncio
async def test_copy_missing_parent_fails(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)
    _seed_file(files, f"{remote_root}/src.txt", b"hi")

    with pytest.raises(FileNotFoundError):
        await copy(accessor, _path("/dbx/src.txt"),
                   _path("/dbx/missing/dst.txt"), index)


@pytest.mark.asyncio
async def test_copy_directory_without_recursive_fails(accessor, files,
                                                      remote_root, index):
    _seed_directory(files, remote_root)
    _seed_directory(files, f"{remote_root}/d")

    with pytest.raises(IsADirectoryError):
        await copy(accessor, _path("/dbx/d"), _path("/dbx/d2"), index)


@pytest.mark.asyncio
async def test_copy_same_path_is_noop(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)
    _seed_file(files, f"{remote_root}/src.txt", b"hello")

    await copy(accessor, _path("/dbx/src.txt"), _path("/dbx/src.txt"), index)

    assert files.downloads[f"{remote_root}/src.txt"] == b"hello"


@pytest.mark.asyncio
async def test_copy_same_missing_path_fails(accessor, files, remote_root,
                                            index):
    _seed_directory(files, remote_root)

    with pytest.raises(FileNotFoundError):
        await copy(accessor, _path("/dbx/missing.txt"),
                   _path("/dbx/missing.txt"), index)


@pytest.mark.asyncio
async def test_copy_same_dir_without_recursive_fails(accessor, files,
                                                     remote_root, index):
    _seed_directory(files, remote_root)
    _seed_directory(files, f"{remote_root}/d")

    with pytest.raises(IsADirectoryError):
        await copy(accessor, _path("/dbx/d"), _path("/dbx/d"), index)


@pytest.mark.asyncio
async def test_copy_recursive_tree(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)
    _seed_directory(files, f"{remote_root}/d")
    _seed_file(files, f"{remote_root}/d/a.txt", b"aaa")

    await copy(accessor,
               _path("/dbx/d"),
               _path("/dbx/d2"),
               index,
               recursive=True)

    assert f"{remote_root}/d2" in files.directory_metadata
    assert files.downloads[f"{remote_root}/d2/a.txt"] == b"aaa"


@pytest.mark.asyncio
async def test_copy_recursive_into_own_subtree_fails(accessor, files,
                                                     remote_root, index):
    _seed_directory(files, remote_root)
    _seed_directory(files, f"{remote_root}/d")
    _seed_file(files, f"{remote_root}/d/a.txt", b"aaa")

    with pytest.raises(ValueError):
        await copy(accessor,
                   _path("/dbx/d"),
                   _path("/dbx/d/d"),
                   index,
                   recursive=True)

    assert files.create_directory_calls == []
    assert files.upload_calls == []
    assert files.downloads[f"{remote_root}/d/a.txt"] == b"aaa"
