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

import errno
from types import SimpleNamespace

import asyncssh
import pytest

from mirage.accessor.ssh import SSHAccessor
from mirage.core.ssh.rm import rm_r
from mirage.types import PathSpec
from mirage.vfs.ssh.config import SSHConfig


class _FakeSFTP:
    """Just enough of asyncssh's SFTPClient for rm_r over a small tree.

    Args:
        files (set[str]): the remote file paths.
        dirs (set[str]): the remote directory paths.
        late (str | None): a file another writer adds at the first remove.
        refusal (Exception | None): what every rmdir raises, if anything.
    """

    def __init__(
        self,
        files: set[str],
        dirs: set[str],
        late: str | None = None,
        refusal: Exception | None = None,
    ) -> None:
        self.files = files
        self.dirs = dirs
        self.late = late
        self.refusal = refusal

    def _names(self, remote: str) -> list[str]:
        base = remote.rstrip("/") + "/"
        return sorted(
            {
                key[len(base) :].split("/", 1)[0]
                for key in self.files | self.dirs
                if key.startswith(base)
            }
        )

    async def lstat(self, remote: str) -> SimpleNamespace:
        if remote in self.dirs:
            return SimpleNamespace(type=asyncssh.FILEXFER_TYPE_DIRECTORY)
        if remote in self.files:
            return SimpleNamespace(type=asyncssh.FILEXFER_TYPE_REGULAR)
        raise asyncssh.SFTPNoSuchFile("No such file")

    async def readdir(self, remote: str) -> list[SimpleNamespace]:
        names = [".", "..", *self._names(remote)]
        return [SimpleNamespace(filename=name) for name in names]

    async def listdir(self, remote: str) -> list[str]:
        return [".", "..", *self._names(remote)]

    async def remove(self, remote: str) -> None:
        self.files.discard(remote)
        if self.late is not None:
            self.files.add(self.late)
            self.late = None

    async def rmdir(self, remote: str) -> None:
        if self.refusal is not None:
            raise self.refusal
        if self._names(remote):
            raise asyncssh.SFTPFailure("Failure")
        self.dirs.discard(remote)


def _accessor(sftp: _FakeSFTP) -> SSHAccessor:
    accessor = SSHAccessor(SSHConfig(host="example.test"))
    accessor._sftp = sftp
    return accessor


def _path(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path=virtual.lstrip("/")
    )


@pytest.mark.asyncio
async def test_rm_r_removes_the_tree():
    sftp = _FakeSFTP({"/d/a.txt", "/d/sub/b.txt"}, {"/d", "/d/sub"})
    await rm_r(_accessor(sftp), _path("/d"))
    assert (sftp.files, sftp.dirs) == (set(), set())


@pytest.mark.asyncio
async def test_rm_r_refuses_a_file_written_during_the_walk():
    # SFTP 3 refuses a non-empty rmdir with its one generic code; a listing
    # decides it was a child written after the walk's: ENOTEMPTY on the root.
    sftp = _FakeSFTP({"/d/sub/a.txt"}, {"/d", "/d/sub"}, late="/d/sub/late")
    with pytest.raises(OSError) as refused:
        await rm_r(_accessor(sftp), _path("/d"))
    assert refused.value.errno == errno.ENOTEMPTY
    assert refused.value.filename == "/d"
    assert sftp.files == {"/d/sub/late"}


@pytest.mark.asyncio
async def test_rm_r_keeps_another_generic_refusal_as_itself():
    sftp = _FakeSFTP(
        {"/d/a.txt"}, {"/d"}, refusal=asyncssh.SFTPFailure("Failure")
    )
    with pytest.raises(asyncssh.SFTPFailure):
        await rm_r(_accessor(sftp), _path("/d"))
