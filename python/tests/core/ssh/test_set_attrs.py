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

import asyncssh
import pytest

from mirage.accessor.ssh import SSHAccessor
from mirage.core.ssh.config import SSHConfig
from mirage.core.ssh.set_attrs import set_attrs
from mirage.types import PathSpec

_MTIME = 1_750_000_000


class _FakeSFTP:
    """Just enough of asyncssh's SFTPClient for set_attrs.

    Args:
        files (set[str]): absolute remote file paths.
        dirs (set[str]): absolute remote directory paths.
    """

    def __init__(self, files: set[str], dirs: set[str]) -> None:
        self.files = files
        self.dirs = dirs
        self.chmods: list[tuple[str, int]] = []
        self.utimes: list[tuple[str, tuple[float, float]]] = []

    async def stat(self, path: str) -> SimpleNamespace:
        key = path.rstrip("/") or "/"
        if key in self.dirs:
            return SimpleNamespace(type=asyncssh.FILEXFER_TYPE_DIRECTORY,
                                   size=4096,
                                   atime=_MTIME,
                                   mtime=_MTIME)
        if key in self.files:
            return SimpleNamespace(type=asyncssh.FILEXFER_TYPE_REGULAR,
                                   size=3,
                                   atime=_MTIME,
                                   mtime=_MTIME)
        raise asyncssh.SFTPNoSuchFile("no such file")

    async def chmod(self, path: str, mode: int) -> None:
        self.chmods.append((path, mode))

    async def utime(self, path: str, times: tuple[float, float]) -> None:
        self.utimes.append((path, times))


def _accessor(files: set[str], dirs: set[str]) -> SSHAccessor:
    accessor = SSHAccessor(SSHConfig(host="example.test"))
    accessor._sftp = _FakeSFTP(files, dirs)
    return accessor


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resolved=False,
                    resource_path=virtual)


@pytest.mark.asyncio
async def test_mtime_applies_natively_with_empty_residual():
    accessor = _accessor({"/a.txt"}, {"/"})
    residual = await set_attrs(accessor,
                               _spec("/a.txt"),
                               mtime="2020-01-01T00:00:00+00:00")
    assert residual == {}
    sftp = accessor._sftp
    assert len(sftp.utimes) == 1
    path, (atime, mtime) = sftp.utimes[0]
    assert path == "/a.txt"
    assert atime == _MTIME
    assert mtime == 1577836800.0


@pytest.mark.asyncio
async def test_mode_clamped_to_keep_owner_access():
    accessor = _accessor({"/a.txt"}, {"/"})
    residual = await set_attrs(accessor, _spec("/a.txt"), mode=0o000)
    assert residual == {"mode": 0}
    assert accessor._sftp.chmods == [("/a.txt", 0o600)]


@pytest.mark.asyncio
async def test_mode_unclamped_applies_cleanly():
    accessor = _accessor({"/a.txt"}, {"/"})
    residual = await set_attrs(accessor, _spec("/a.txt"), mode=0o644)
    assert residual == {}
    assert accessor._sftp.chmods == [("/a.txt", 0o644)]


@pytest.mark.asyncio
async def test_ownership_is_always_residual():
    accessor = _accessor({"/a.txt"}, {"/"})
    residual = await set_attrs(accessor, _spec("/a.txt"), uid=7, gid=8)
    assert residual == {"uid": 7, "gid": 8}
    assert accessor._sftp.chmods == []
    assert accessor._sftp.utimes == []


@pytest.mark.asyncio
async def test_missing_file_raises_enoent():
    accessor = _accessor(set(), {"/"})
    with pytest.raises(FileNotFoundError):
        await set_attrs(accessor, _spec("/nope.txt"), mtime="2020-01-01")
