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

from mirage.core.databricks_volume.create import create
from mirage.core.databricks_volume.unlink import unlink
from mirage.core.databricks_volume.write import write_bytes
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/dbx"))


def _seed_directory(files, path: str) -> None:
    files.directory_metadata.add(path)
    files.metadata[path] = type("Metadata", (), {"is_directory": True})()
    files.directories.setdefault(path, [])


def _seed_file(files, path: str, data: bytes) -> None:
    parent = path.rsplit("/", 1)[0]
    files.downloads[path] = data
    files.metadata[path] = type(
        "Metadata",
        (),
        {
            "content_length": len(data),
        },
    )()
    files.directories.setdefault(parent, [])
    files.directories[parent].append(
        type(
            "Entry",
            (),
            {
                "path": path,
                "is_directory": False,
                "file_size": len(data),
            },
        )())


@pytest.mark.asyncio
async def test_write_new_file(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)

    await write_bytes(accessor, _path("/dbx/new.txt"), b"hello", index)

    assert files.downloads[f"{remote_root}/new.txt"] == b"hello"
    assert files.upload_calls == [(f"{remote_root}/new.txt", b"hello", True)]


@pytest.mark.asyncio
async def test_write_overwrites_existing_file(accessor, files, remote_root,
                                              index):
    _seed_directory(files, remote_root)
    _seed_file(files, f"{remote_root}/new.txt", b"old")

    await write_bytes(accessor, _path("/dbx/new.txt"), b"new", index)

    assert files.downloads[f"{remote_root}/new.txt"] == b"new"
    assert files.metadata[f"{remote_root}/new.txt"].content_length == 3


@pytest.mark.asyncio
async def test_write_fails_when_parent_is_missing(accessor, files, remote_root,
                                                  index):
    _seed_directory(files, remote_root)

    with pytest.raises(FileNotFoundError):
        await write_bytes(accessor, _path("/dbx/missing/new.txt"), b"x", index)


@pytest.mark.asyncio
async def test_write_fails_when_parent_is_file(accessor, files, remote_root,
                                               index):
    _seed_directory(files, remote_root)
    _seed_file(files, f"{remote_root}/parent.txt", b"file")

    with pytest.raises(NotADirectoryError):
        await write_bytes(accessor, _path("/dbx/parent.txt/new.txt"), b"x",
                          index)


@pytest.mark.asyncio
async def test_create_empty_file(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)

    await create(accessor, _path("/dbx/empty.txt"), index)

    assert files.downloads[f"{remote_root}/empty.txt"] == b""


@pytest.mark.asyncio
async def test_create_fails_when_parent_is_missing(accessor, files,
                                                   remote_root, index):
    _seed_directory(files, remote_root)

    with pytest.raises(FileNotFoundError):
        await create(accessor, _path("/dbx/missing/empty.txt"), index)


@pytest.mark.asyncio
async def test_unlink_file(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)
    _seed_file(files, f"{remote_root}/delete.txt", b"bye")

    await unlink(accessor, _path("/dbx/delete.txt"), index)

    assert f"{remote_root}/delete.txt" not in files.downloads
    assert files.delete_calls == [f"{remote_root}/delete.txt"]


@pytest.mark.asyncio
async def test_unlink_missing_file_raises_file_not_found(
        accessor, files, remote_root, index):
    _seed_directory(files, remote_root)

    with pytest.raises(FileNotFoundError):
        await unlink(accessor, _path("/dbx/missing.txt"), index)


@pytest.mark.asyncio
async def test_unlink_directory_raises_is_a_directory(accessor, files,
                                                      remote_root, index):
    _seed_directory(files, remote_root)
    _seed_directory(files, f"{remote_root}/dir")

    with pytest.raises(IsADirectoryError):
        await unlink(accessor, _path("/dbx/dir"), index)


@pytest.mark.asyncio
async def test_file_mutation_paths_cannot_escape_root(accessor, files,
                                                      remote_root, index):
    _seed_directory(files, remote_root)
    escaping = _path("/dbx/../escape.txt")

    with pytest.raises(ValueError):
        await write_bytes(accessor, escaping, b"x", index)
    with pytest.raises(ValueError):
        await create(accessor, escaping, index)
    with pytest.raises(ValueError):
        await unlink(accessor, escaping, index)
