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

from mirage.accessor.ssh import SSHAccessor
from mirage.cache.context import push_cache_manager
from mirage.core.ssh.rename import rename
from mirage.types import PathSpec
from mirage.vfs.ssh.config import SSHConfig


class _FakeSFTP:
    """Just enough of asyncssh's SFTPClient for rename."""

    def __init__(self) -> None:
        self.renamed: list[tuple[str, str]] = []

    async def posix_rename(self, src: str, dst: str) -> None:
        self.renamed.append((src, dst))


class _Moves:
    """Which invalidation each end of a rename took, in call order."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def invalidate_after_move(
        self, path: PathSpec, folder: bool
    ) -> None:
        self.calls.append(("subtree" if folder else "unlink", path.virtual))

    async def invalidate_subtree(self, path: PathSpec) -> None:
        self.calls.append(("subtree", path.virtual))


@pytest.mark.asyncio
async def test_a_renamed_file_still_drops_both_subtrees():
    # A blind SFTP rename never learns what it moved, and asking costs a
    # round trip, so even a file keeps the subtree on both ends.
    sftp = _FakeSFTP()
    accessor = SSHAccessor(SSHConfig(host="example.test"))
    accessor._sftp = sftp
    moves = _Moves()
    prev = push_cache_manager(moves)
    try:
        await rename(
            accessor,
            PathSpec.from_str_path("/a.txt"),
            PathSpec.from_str_path("/b.txt"),
        )
    finally:
        push_cache_manager(prev)
    assert len(sftp.renamed) == 1
    assert moves.calls == [("subtree", "/b.txt"), ("subtree", "/a.txt")]
