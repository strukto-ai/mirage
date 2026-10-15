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
from mirage.core.ssh.read import read
from mirage.core.ssh.readdir import readdir
from mirage.core.ssh.stat import stat
from mirage.types import FileType, PathSpec
from mirage.vfs.ssh.config import SSHConfig

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
            out = self._data[self._pos :]
        else:
            out = self._data[self._pos : self._pos + size]
        self._pos += len(out)
        return out


class _FakeSFTP:
    """Just enough of asyncssh's SFTPClient for readdir/stat/read.

    Args:
        files (dict[str, bytes]): absolute remote path to content.
        dirs (set[str]): absolute remote directory paths.
    """

    def __init__(
        self,
        files: dict[str, bytes],
        dirs: set[str],
        links: dict[str, str] | None = None,
    ) -> None:
        self.files = files
        self.dirs = dirs
        self.links = links or {}

    def _attrs(self, path: str) -> SimpleNamespace:
        if path in self.links:
            return SimpleNamespace(
                type=asyncssh.FILEXFER_TYPE_SYMLINK,
                size=len(self.links[path]),
                mtime=_MTIME,
                permissions=None,
                atime=None,
            )
        if path in self.dirs:
            return SimpleNamespace(
                type=asyncssh.FILEXFER_TYPE_DIRECTORY,
                size=4096,
                mtime=_MTIME,
                permissions=None,
                atime=None,
            )
        return SimpleNamespace(
            type=asyncssh.FILEXFER_TYPE_REGULAR,
            size=len(self.files[path]),
            mtime=_MTIME,
            permissions=None,
            atime=None,
        )

    async def readdir(self, path: str):
        base = path.rstrip("/") or "/"
        if base not in self.dirs:
            raise asyncssh.SFTPNoSuchFile("no such directory")
        out = []
        names = self.files | {d: b"" for d in self.dirs} | self.links
        for child in sorted(names):
            parent = child.rsplit("/", 1)[0] or "/"
            if parent != base or child == base:
                continue
            leaf = child.rsplit("/", 1)[-1]
            out.append(
                SimpleNamespace(filename=leaf, attrs=self._attrs(child))
            )
        return out

    async def stat(self, path: str) -> SimpleNamespace:
        key = path.rstrip("/") or "/"
        key = self.links.get(key, key)
        if key not in self.dirs and key not in self.files:
            raise asyncssh.SFTPNoSuchFile("no such file")
        return self._attrs(key)

    def open(self, path: str, mode: str) -> _FakeFile:
        if path not in self.files:
            raise asyncssh.SFTPNoSuchFile("no such file")
        return _FakeFile(self.files[path])


def _accessor(
    files: dict[str, bytes],
    dirs: set[str],
    links: dict[str, str] | None = None,
) -> SSHAccessor:
    accessor = SSHAccessor(SSHConfig(host="example.test"))
    accessor._sftp = _FakeSFTP(files, dirs, links)
    return accessor


@pytest.mark.asyncio
async def test_readdir_under_a_file_is_enotdir():
    # SFTP 3 answers `/a.txt/x` with NO_SUCH_FILE exactly as it does a name
    # that is simply absent, so only the ancestor walk can tell GNU's "Not a
    # directory" from "No such file or directory".
    accessor = _accessor({"/a.txt": b"hello"}, {"/"})
    with pytest.raises(NotADirectoryError):
        await readdir(accessor, PathSpec.from_str_path("/a.txt/x"))
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, PathSpec.from_str_path("/nope/deeper"))


@pytest.mark.asyncio
async def test_each_row_is_what_stat_answers():
    # Readdir attrs are lstat-style, so a link's row is its target's stat.
    accessor = _accessor(
        {"/a.txt": b"hello", "/docs/b.bin": b"abc"},
        {"/", "/docs"},
        {"/link": "/a.txt", "/gone": "/nowhere"},
    )
    rows = await readdir(accessor, PathSpec.from_str_path("/"))
    assert [row.name for row in rows] == ["a.txt", "docs", "gone", "link"]
    for row in rows[:2] + rows[3:]:
        expected = await stat(accessor, PathSpec.from_str_path(f"/{row.name}"))
        assert row == expected
    assert rows[1].size is None
    assert rows[3].size == 5
    assert rows[2].type == FileType.FILE


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file():
    # The fskit invariant behind sizes_always_known: the size stat reports
    # must equal the byte length a read delivers, 0-byte files included.
    # A directory has no byte length, so its remote 4096 never surfaces.
    accessor = _accessor(
        {"/a.txt": b"hello", "/empty.txt": b"", "/docs/b.bin": b"abc"},
        {"/", "/docs"},
    )
    files: list[str] = []
    stack = ["/"]
    while stack:
        current = stack.pop()
        rows = await readdir(accessor, PathSpec.from_str_path(current))
        for row in rows:
            child = f"{current.rstrip('/')}/{row.name}"
            info = await stat(accessor, PathSpec.from_str_path(child))
            if info.type == FileType.DIRECTORY:
                assert info.size is None, child
                stack.append(child)
                continue
            assert info.size is not None, child
            body = await read(accessor, PathSpec.from_str_path(child))
            assert info.size == len(body), child
            files.append(child)
    assert sorted(files) == ["/a.txt", "/docs/b.bin", "/empty.txt"]
