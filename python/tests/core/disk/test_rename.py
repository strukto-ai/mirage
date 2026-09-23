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
from mirage.cache.context import push_cache_manager
from mirage.core.disk.rename import rename
from mirage.types import PathSpec


class _FakeManager:

    def __init__(self) -> None:
        self.writes: list[str] = []
        self.unlinks: list[str] = []
        self.subtrees: list[str] = []

    async def invalidate_after_write(self, path: PathSpec) -> None:
        self.writes.append(path.mount_path)

    async def invalidate_after_unlink(self, path: PathSpec) -> None:
        self.unlinks.append(path.mount_path)

    async def invalidate_subtree(self, path: PathSpec) -> None:
        self.subtrees.append(path.mount_path)


def _spec(path: str) -> PathSpec:
    return PathSpec(vfs_path=path.lstrip("/"), virtual=path, directory="/")


@pytest.mark.asyncio
async def test_rename_moves_file(tmp_path):
    (tmp_path / "a.txt").write_bytes(b"A")
    accessor = DiskAccessor(tmp_path)
    await rename(accessor, _spec("/a.txt"), _spec("/b.txt"))
    assert not (tmp_path / "a.txt").exists()
    assert (tmp_path / "b.txt").read_bytes() == b"A"


@pytest.mark.asyncio
async def test_rename_evicts_both_identities(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "f.txt").write_bytes(b"x")
    (tmp_path / "dst").mkdir()
    accessor = DiskAccessor(tmp_path)
    manager = _FakeManager()
    prev = push_cache_manager(manager)
    try:
        await rename(accessor, _spec("/src"), _spec("/dst"))
    finally:
        push_cache_manager(prev)
    # A replaced empty directory loses its own cached listing, not just
    # its parent's: both sides of a rename take the unlink flavor.
    assert manager.subtrees == ["/src", "/dst"]
    assert manager.writes == []
    assert (tmp_path / "dst" / "f.txt").read_bytes() == b"x"
