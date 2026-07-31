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
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.ssh.config import SSHConfig
from mirage.core.ssh.read import read_bytes
from mirage.core.ssh.readdir import readdir
from mirage.core.ssh.stat import stat
from mirage.types import FileType, PathSpec

_MTIME = 1_750_000_000


class _FakeFile:

    def __init__(self, data: bytes) -> None:
        self._data = data
        self._pos = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return None

    async def seek(self, offset: int) -> None:
        self._pos = offset

    async def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            out = self._data[self._pos:]
        else:
            out = self._data[self._pos:self._pos + size]
        self._pos += len(out)
        return out


class _FakeSFTP:
    """Just enough of asyncssh's SFTPClient for readdir/stat/read.

    Args:
        files (dict[str, bytes]): absolute remote path to content.
        dirs (set[str]): absolute remote directory paths.
    """

    def __init__(self, files: dict[str, bytes], dirs: set[str]) -> None:
        self.files = files
        self.dirs = dirs

    def _attrs(self, path: str) -> SimpleNamespace:
        if path in self.dirs:
            return SimpleNamespace(type=asyncssh.FILEXFER_TYPE_DIRECTORY,
                                   size=4096,
                                   mtime=_MTIME,
                                   permissions=None,
                                   atime=None)
        return SimpleNamespace(type=asyncssh.FILEXFER_TYPE_REGULAR,
                               size=len(self.files[path]),
                               mtime=_MTIME,
                               permissions=None,
                               atime=None)

    async def readdir(self, path: str):
        base = path.rstrip("/") or "/"
        if base not in self.dirs:
            raise asyncssh.SFTPNoSuchFile("no such directory")
        out = []
        for child in sorted(self.files | {d: b"" for d in self.dirs}):
            parent = child.rsplit("/", 1)[0] or "/"
            if parent != base or child == base:
                continue
            leaf = child.rsplit("/", 1)[-1]
            out.append(SimpleNamespace(filename=leaf,
                                       attrs=self._attrs(child)))
        return out

    async def stat(self, path: str) -> SimpleNamespace:
        key = path.rstrip("/") or "/"
        if key not in self.dirs and key not in self.files:
            raise asyncssh.SFTPNoSuchFile("no such file")
        return self._attrs(key)

    def open(self, path: str, mode: str) -> _FakeFile:
        if path not in self.files:
            raise asyncssh.SFTPNoSuchFile("no such file")
        return _FakeFile(self.files[path])


def _accessor(files: dict[str, bytes], dirs: set[str]) -> SSHAccessor:
    accessor = SSHAccessor(SSHConfig(host="example.test"))
    accessor._sftp = _FakeSFTP(files, dirs)
    return accessor


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_readdir_stores_sftp_attrs_in_index(index):
    accessor = _accessor(
        {
            "/a.txt": b"hello",
            "/docs/b.bin": b"abc"
        },
        {"/", "/docs"},
    )
    listing = await readdir(accessor, PathSpec.from_str_path("/"), index)
    assert listing == ["/a.txt", "/docs"]
    entry = (await index.get("/a.txt")).entry
    assert entry is not None
    assert entry.resource_type == "file"
    assert entry.size == 5
    assert entry.remote_time != ""
    folder = (await index.get("/docs")).entry
    assert folder is not None
    assert folder.resource_type == "folder"
    assert folder.size is None


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file(index):
    # The fskit invariant behind SIZES_ALWAYS_KNOWN: the size stat reports
    # must equal the byte length a read delivers, 0-byte files included.
    accessor = _accessor(
        {
            "/a.txt": b"hello",
            "/empty.txt": b"",
            "/docs/b.bin": b"abc"
        },
        {"/", "/docs"},
    )
    files: list[str] = []
    stack = ["/"]
    while stack:
        current = stack.pop()
        listing = await readdir(accessor, PathSpec.from_str_path(current),
                                index)
        for child in listing:
            info = await stat(accessor, PathSpec.from_str_path(child), index)
            if info.type == FileType.DIRECTORY:
                stack.append(child)
                continue
            assert info.size is not None, child
            body = await read_bytes(accessor, PathSpec.from_str_path(child),
                                    index)
            assert info.size == len(body), child
            files.append(child)
    assert sorted(files) == ["/a.txt", "/docs/b.bin", "/empty.txt"]
