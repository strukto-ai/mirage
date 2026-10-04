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

from mirage.cache.context import push_cache_manager
from mirage.core.databricks_volume.rename import rename
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/dbx"))


class _MoveRecorder:
    """Records the rename's own evictions; the inner copy, unlink and
    rm_recursive run theirs too, which this test is not about."""

    def __init__(self) -> None:
        self.moves: list[tuple[str, bool]] = []

    def listing_trusted(self, _folder: str) -> bool:
        return False

    def probed_stat(self, _path: PathSpec) -> None:
        return None

    async def cached_bytes(self, _path: PathSpec) -> None:
        return None

    async def cached_size(self, _path: PathSpec) -> None:
        return None

    async def invalidate_after_write(self, _path: PathSpec) -> None:
        pass

    async def invalidate_after_unlink(self, _path: PathSpec) -> None:
        pass

    async def invalidate_subtree(self, _path: PathSpec) -> None:
        pass

    async def invalidate_ancestors(self, _path: PathSpec) -> None:
        pass

    async def invalidate_after_move(
        self, path: PathSpec, folder: bool
    ) -> None:
        self.moves.append((path.virtual, folder))


async def _recorded(accessor, src: str, dst: str, index) -> _MoveRecorder:
    manager = _MoveRecorder()
    prev = push_cache_manager(manager)
    try:
        await rename(accessor, _path(src), _path(dst), index)
    finally:
        push_cache_manager(prev)
    return manager


def _seed_directory(files, path: str) -> None:
    files.directory_metadata.add(path)
    files.directories.setdefault(path, [])
    parent = path.rsplit("/", 1)[0]
    if parent and parent != path:
        files.directories.setdefault(parent, []).append(
            SimpleNamespace(path=path, is_directory=True, file_size=None)
        )


def _seed_file(files, path: str, data: bytes) -> None:
    parent = path.rsplit("/", 1)[0]
    files.downloads[path] = data
    files.metadata[path] = SimpleNamespace(
        is_directory=False, file_size=len(data)
    )
    files.directories.setdefault(parent, []).append(
        SimpleNamespace(path=path, is_directory=False, file_size=len(data))
    )


@pytest.mark.asyncio
async def test_rename_file_moves_bytes(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)
    _seed_file(files, f"{remote_root}/src.txt", b"data")

    await rename(accessor, _path("/dbx/src.txt"), _path("/dbx/dst.txt"), index)

    assert files.downloads[f"{remote_root}/dst.txt"] == b"data"
    assert f"{remote_root}/src.txt" not in files.downloads


@pytest.mark.asyncio
async def test_rename_missing_source_fails(
    accessor, files, remote_root, index
):
    _seed_directory(files, remote_root)

    with pytest.raises(FileNotFoundError):
        await rename(
            accessor, _path("/dbx/missing.txt"), _path("/dbx/dst.txt"), index
        )


@pytest.mark.asyncio
async def test_rename_same_path_is_noop(accessor, files, remote_root, index):
    _seed_directory(files, remote_root)
    _seed_file(files, f"{remote_root}/src.txt", b"data")

    await rename(accessor, _path("/dbx/src.txt"), _path("/dbx/src.txt"), index)

    assert files.downloads[f"{remote_root}/src.txt"] == b"data"
    assert f"{remote_root}/src.txt" not in files.delete_calls


@pytest.mark.asyncio
async def test_rename_same_missing_path_fails(
    accessor, files, remote_root, index
):
    _seed_directory(files, remote_root)

    with pytest.raises(FileNotFoundError):
        await rename(
            accessor,
            _path("/dbx/missing.txt"),
            _path("/dbx/missing.txt"),
            index,
        )


@pytest.mark.asyncio
async def test_rename_directory_moves_tree(
    accessor, files, remote_root, index
):
    _seed_directory(files, remote_root)
    _seed_directory(files, f"{remote_root}/d")
    _seed_file(files, f"{remote_root}/d/a.txt", b"aaa")

    await rename(accessor, _path("/dbx/d"), _path("/dbx/d2"), index)

    assert files.downloads[f"{remote_root}/d2/a.txt"] == b"aaa"
    assert f"{remote_root}/d" not in files.directory_metadata


@pytest.mark.asyncio
async def test_rename_into_own_subtree_fails(
    accessor, files, remote_root, index
):
    _seed_directory(files, remote_root)
    _seed_directory(files, f"{remote_root}/d")
    _seed_file(files, f"{remote_root}/d/a.txt", b"aaa")

    with pytest.raises(ValueError):
        await rename(accessor, _path("/dbx/d"), _path("/dbx/d/d"), index)

    assert files.downloads[f"{remote_root}/d/a.txt"] == b"aaa"
    assert f"{remote_root}/d" in files.directory_metadata
    assert files.create_directory_calls == []
    assert files.upload_calls == []
    assert files.delete_calls == []
    assert files.delete_directory_calls == []


@pytest.mark.asyncio
async def test_renaming_a_file_narrows_only_the_source(
    accessor, files, remote_root, index
):
    # The source end is a file, so it drops no subtree. The destination
    # keeps one: the upload overwrites whatever stands at dst and nothing
    # here checks that it is not a non-empty directory.
    _seed_directory(files, remote_root)
    _seed_file(files, f"{remote_root}/src.txt", b"data")
    manager = await _recorded(accessor, "/dbx/src.txt", "/dbx/dst.txt", index)
    assert manager.moves == [("/dbx/dst.txt", True), ("/dbx/src.txt", False)]


@pytest.mark.asyncio
async def test_renaming_a_directory_drops_both_subtrees(
    accessor, files, remote_root, index
):
    _seed_directory(files, remote_root)
    _seed_directory(files, f"{remote_root}/d")
    _seed_file(files, f"{remote_root}/d/a.txt", b"aaa")
    manager = await _recorded(accessor, "/dbx/d", "/dbx/d2", index)
    assert manager.moves == [("/dbx/d2", True), ("/dbx/d", True)]
