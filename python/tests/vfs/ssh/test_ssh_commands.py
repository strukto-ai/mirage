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

import asyncio
import io
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import asyncssh
import pytest

from mirage.types import MountMode
from mirage.vfs.ssh import SSHVFS, SSHConfig
from mirage.workspace import Workspace


class MockSFTPAttrs:
    def __init__(self, *, is_dir=False, size=0, mtime=None):
        self.type = (
            asyncssh.FILEXFER_TYPE_DIRECTORY
            if is_dir
            else asyncssh.FILEXFER_TYPE_REGULAR
        )
        self.size = size
        self.mtime = mtime or int(
            datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp()
        )
        # Real asyncssh SFTPAttrs always carry these (default None).
        self.permissions = None
        self.atime = None


class MockSFTPName:
    def __init__(self, filename, *, is_dir=False, size=0, mtime=None):
        self.filename = filename
        self.attrs = MockSFTPAttrs(is_dir=is_dir, size=size, mtime=mtime)


class MockSFTPFile:
    def __init__(self, store, path, mode):
        self._store = store
        self._path = path
        # SFTP open flags (write, create) open the file for update.
        self._mode = "r+b" if isinstance(mode, int) else mode
        self._pos = 0
        self._buf = io.BytesIO()
        if "r" in self._mode and path in store:
            self._buf = io.BytesIO(store[path])

    async def read(self, size=-1):
        self._buf.seek(self._pos)
        data = self._buf.read(size if size > 0 else -1)
        self._pos = self._buf.tell()
        return data

    async def write(self, data, offset=None):
        if self._mode == "ab":
            existing = self._store.get(self._path, b"")
            self._store[self._path] = existing + data
        else:
            if offset is not None:
                self._buf.seek(offset)
            self._buf.write(data)

    async def truncate(self, size):
        held = self._buf.getvalue()[:size]
        self._buf = io.BytesIO(held.ljust(size, b"\0"))

    async def seek(self, offset):
        self._pos = offset

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        if "w" in self._mode or "+" in self._mode:
            self._store[self._path] = self._buf.getvalue()

    def __await__(self):
        return self._opened().__await__()

    async def _opened(self):
        return self


class MockSFTPClient:
    def __init__(self, files: dict[str, bytes], dirs: set[str]):
        self.files = files
        self.dirs = dirs
        self.filename_bytes = False

    async def stat(self, path):
        if path in self.dirs:
            return MockSFTPAttrs(is_dir=True, size=4096)
        if path in self.files:
            return MockSFTPAttrs(size=len(self.files[path]))
        raise asyncssh.SFTPNoSuchFile("not found")

    async def lstat(self, path):
        # No symlinks in the mock tree, so lstat and stat agree (rm uses
        # lstat to avoid following links).
        return await self.stat(path)

    async def readdir(self, path):
        if path not in self.dirs:
            raise asyncssh.SFTPNoSuchFile("not found")
        prefix = path.rstrip("/") + "/"
        entries = [
            MockSFTPName(".", is_dir=True),
            MockSFTPName("..", is_dir=True),
        ]
        seen = set()
        for key in sorted(self.files):
            if not key.startswith(prefix):
                continue
            rel = key[len(prefix) :]
            name = rel.split("/")[0]
            if name not in seen:
                seen.add(name)
                child_path = prefix + name
                is_dir = child_path in self.dirs
                entries.append(
                    MockSFTPName(
                        name,
                        is_dir=is_dir,
                        size=0 if is_dir else len(self.files[key]),
                    )
                )
        for d in sorted(self.dirs):
            if not d.startswith(prefix):
                continue
            rel = d[len(prefix) :]
            name = rel.split("/")[0]
            if name and name not in seen:
                seen.add(name)
                entries.append(MockSFTPName(name, is_dir=True, size=4096))
        if self.filename_bytes:
            for entry in entries:
                entry.filename = entry.filename.encode("utf-8")
        return entries

    def open(self, path, mode="r", encoding="utf-8"):
        return MockSFTPFile(self.files, path, mode)

    async def remove(self, path):
        if path not in self.files:
            raise asyncssh.SFTPNoSuchFile("not found")
        del self.files[path]

    async def rmdir(self, path):
        if path not in self.dirs:
            raise asyncssh.SFTPNoSuchFile("not found")
        self.dirs.discard(path)

    async def mkdir(self, path):
        parent = path.rstrip("/").rsplit("/", 1)[0] or "/"
        if parent != "/" and parent not in self.dirs:
            raise asyncssh.SFTPNoSuchFile("not found")
        self.dirs.add(path)

    async def makedirs(self, path, exist_ok=False):
        parts = path.strip("/").split("/")
        for i in range(1, len(parts) + 1):
            d = "/" + "/".join(parts[:i])
            self.dirs.add(d)

    async def rename(self, src, dst):
        if src in self.files:
            self.files[dst] = self.files.pop(src)
        elif src in self.dirs:
            self.dirs.discard(src)
            self.dirs.add(dst)
            to_move = [
                (k, v)
                for k, v in self.files.items()
                if k.startswith(src + "/")
            ]
            for k, v in to_move:
                new_key = dst + k[len(src) :]
                self.files[new_key] = v
                del self.files[k]
        else:
            raise asyncssh.SFTPNoSuchFile("not found")

    async def posix_rename(self, src, dst):
        await self.rename(src, dst)

    async def truncate(self, path, length):
        if path in self.files:
            self.files[path] = self.files[path][:length]

    async def utime(self, path, times=None, ns=None):
        return None


class SSHTestEnv:
    def __init__(self):
        self.config = SSHConfig(host="mock", root="/data", known_hosts=None)
        self.vfs = SSHVFS(self.config)
        self._files: dict[str, bytes] = {}
        self._dirs: set[str] = {"/data"}
        self._sftp = MockSFTPClient(self._files, self._dirs)
        self.vfs.accessor._sftp = self._sftp
        self.vfs.accessor._conn = MagicMock(
            wait_closed=AsyncMock(), is_closed=MagicMock(return_value=False)
        )
        self.ws = Workspace(
            {"/ssh": (self.vfs, MountMode.WRITE)},
            mode=MountMode.WRITE,
        )

    def create_file(self, name: str, content: bytes):
        path = "/data/" + name.lstrip("/")
        parts = path.strip("/").split("/")
        for i in range(1, len(parts)):
            d = "/" + "/".join(parts[:i])
            self._dirs.add(d)
        self._files[path] = content

    def run(self, cmd: str, stdin: bytes | None = None) -> str:
        io = asyncio.run(self.ws.shell(cmd, stdin=stdin))
        stdout = io.stdout
        if stdout is None:
            return ""
        if isinstance(stdout, bytes):
            return stdout.decode(errors="replace")
        chunks = asyncio.run(_drain(stdout))
        return b"".join(chunks).decode(errors="replace")


async def _drain(ait):
    return [chunk async for chunk in ait]


@pytest.fixture
def env():
    return SSHTestEnv()


def test_ls_a(env):
    env.create_file(".hidden", b"h")
    env.create_file("visible.txt", b"v")
    result = env.run("ls -a /ssh/")
    assert ".hidden" in result
    assert "visible.txt" in result


def test_find_decodes_byte_filenames(env):
    env.create_file("a.txt", b"a")
    env._sftp.filename_bytes = True
    result = env.run("find /ssh/")
    assert "/ssh/a.txt" in result
    assert "b'a.txt'" not in result


def test_rm_invalidates_ls_cache(env):
    env.create_file("a.txt", b"a")
    env.create_file("b.txt", b"b")
    env.run("ls /ssh/")
    env.run("rm /ssh/b.txt")
    result = env.run("ls /ssh/")
    assert "a.txt" in result
    assert "b.txt" not in result


def test_cp_invalidates_ls_cache(env):
    env.create_file("a.txt", b"hello")
    env.run("ls /ssh/")
    env.run("cp /ssh/a.txt /ssh/c.txt")
    result = env.run("ls /ssh/")
    assert "c.txt" in result
