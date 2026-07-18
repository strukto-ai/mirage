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
from unittest.mock import MagicMock

import asyncssh
import pytest

from mirage.resource.ssh import SSHConfig, SSHResource
from mirage.types import MountMode
from mirage.workspace import Workspace


class MockSFTPAttrs:

    def __init__(self, *, is_dir=False, size=0, mtime=None):
        self.type = (asyncssh.FILEXFER_TYPE_DIRECTORY
                     if is_dir else asyncssh.FILEXFER_TYPE_REGULAR)
        self.size = size
        self.mtime = mtime or int(
            datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp())


class MockSFTPName:

    def __init__(self, filename, *, is_dir=False, size=0, mtime=None):
        self.filename = filename
        self.attrs = MockSFTPAttrs(is_dir=is_dir, size=size, mtime=mtime)


class MockSFTPFile:

    def __init__(self, store, path, mode):
        self._store = store
        self._path = path
        self._mode = mode
        self._pos = 0
        self._buf = io.BytesIO()
        if "r" in mode and path in store:
            self._buf = io.BytesIO(store[path])

    async def read(self, size=-1):
        self._buf.seek(self._pos)
        data = self._buf.read(size if size > 0 else -1)
        self._pos = self._buf.tell()
        return data

    async def write(self, data):
        if self._mode == "ab":
            existing = self._store.get(self._path, b"")
            self._store[self._path] = existing + data
        else:
            self._buf.write(data)

    async def seek(self, offset):
        self._pos = offset

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        if "w" in self._mode:
            self._store[self._path] = self._buf.getvalue()


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
            rel = key[len(prefix):]
            name = rel.split("/")[0]
            if name not in seen:
                seen.add(name)
                child_path = prefix + name
                is_dir = child_path in self.dirs
                entries.append(
                    MockSFTPName(name,
                                 is_dir=is_dir,
                                 size=0 if is_dir else len(self.files[key])))
        for d in sorted(self.dirs):
            if not d.startswith(prefix):
                continue
            rel = d[len(prefix):]
            name = rel.split("/")[0]
            if name and name not in seen:
                seen.add(name)
                entries.append(MockSFTPName(name, is_dir=True, size=4096))
        if self.filename_bytes:
            for entry in entries:
                entry.filename = entry.filename.encode("utf-8")
        return entries

    def open(self, path, mode):
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
            to_move = [(k, v) for k, v in self.files.items()
                       if k.startswith(src + "/")]
            for k, v in to_move:
                new_key = dst + k[len(src):]
                self.files[new_key] = v
                del self.files[k]
        else:
            raise asyncssh.SFTPNoSuchFile("not found")

    async def posix_rename(self, src, dst):
        await self.rename(src, dst)

    async def truncate(self, path, length):
        if path in self.files:
            self.files[path] = self.files[path][:length]


class SSHTestEnv:

    def __init__(self):
        self.config = SSHConfig(host="mock", root="/data", known_hosts=None)
        self.resource = SSHResource(self.config)
        self._files: dict[str, bytes] = {}
        self._dirs: set[str] = {"/data"}
        self._sftp = MockSFTPClient(self._files, self._dirs)
        self.resource.accessor._sftp = self._sftp
        self.resource.accessor._conn = MagicMock()
        self.ws = Workspace(
            {"/ssh": (self.resource, MountMode.WRITE)},
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
        io = asyncio.run(self.ws.execute(cmd, stdin=stdin))
        stdout = io.stdout
        if stdout is None:
            return ""
        if isinstance(stdout, bytes):
            return stdout.decode(errors="replace")
        chunks = asyncio.run(_drain(stdout))
        return b"".join(chunks).decode(errors="replace")

    def run_io(self, cmd: str, stdin: bytes | None = None):
        return asyncio.run(self.ws.execute(cmd, stdin=stdin))

    def run_io_provision(self, cmd: str):
        return asyncio.run(self.ws.execute(cmd, provision=True))


async def _drain(ait):
    return [chunk async for chunk in ait]


@pytest.fixture
def env():
    return SSHTestEnv()


# ── ls ─────────────────────────────────────────


def test_ls(env):
    env.create_file("a.txt", b"aaa")
    env.create_file("b.txt", b"bbb")
    names = set(env.run("ls /ssh/").strip().split("\n"))
    assert names == {"a.txt", "b.txt"}


def test_ls_subdir(env):
    env.create_file("sub/f.txt", b"hello")
    result = env.run("ls /ssh/")
    assert "sub" in result


def test_ls_a(env):
    env.create_file(".hidden", b"h")
    env.create_file("visible.txt", b"v")
    result = env.run("ls -a /ssh/")
    assert ".hidden" in result
    assert "visible.txt" in result


# ── cat / head / tail / wc ─────────────────────


def test_cat(env):
    env.create_file("f.txt", b"hello world\n")
    assert env.run("cat /ssh/f.txt") == "hello world\n"


def test_cat_populates_cache_and_provision_sees_hit(env):
    """Regression: ssh cat must wrap its stream in CachableAsyncIterator
    so apply_io can populate the cache. Then provision should report
    cache_hits=1 instead of network_read on the second call."""
    env.create_file("f.txt", b"hello world\n")
    env.run("cat /ssh/f.txt")
    cache_keys = list(env.ws._cache._entries)
    assert "/ssh/f.txt" in cache_keys, (
        f"cache should have /ssh/f.txt after cat; got {cache_keys}")

    pr = env.run_io_provision("cat /ssh/f.txt")
    leaf = pr.children[0] if pr.children else pr
    assert leaf.cache_hits == 1, (
        f"expected cache_hits=1 after warm cat, got {leaf.cache_hits}")
    assert leaf.network_read_low == 0, (
        f"expected network_read=0 after warm cat, got {leaf.network_read_low}")
    assert leaf.cache_read_low > 0, (
        f"expected cache_read>0 after warm cat, got {leaf.cache_read_low}")


def test_head(env):
    env.create_file("f.txt", b"line1\nline2\nline3\n")
    result = env.run("head -n 2 /ssh/f.txt")
    assert result == "line1\nline2\n"


def test_wc(env):
    env.create_file("f.txt", b"hello world\n")
    result = env.run("wc /ssh/f.txt")
    assert "1" in result


# ── stat ───────────────────────────────────────


def test_stat_file(env):
    env.create_file("f.txt", b"hello")
    result = env.run("stat /ssh/f.txt")
    assert "name=f.txt" in result
    assert "size=5" in result


def test_stat_directory(env):
    env.create_file("sub/f.txt", b"hi")
    result = env.run("stat /ssh/sub")
    assert "name=sub" in result
    assert "directory" in result


# ── tree ───────────────────────────────────────


def test_tree(env):
    env.create_file("a.txt", b"a")
    env.create_file("sub/b.txt", b"b")
    result = env.run("tree /ssh/")
    assert "a.txt" in result
    assert "sub" in result
    assert "b.txt" in result


def test_tree_nested(env):
    env.create_file("d1/d2/f.txt", b"deep")
    result = env.run("tree /ssh/")
    assert "d1" in result
    assert "d2" in result
    assert "f.txt" in result


# ── find ───────────────────────────────────────


def test_find(env):
    env.create_file("a.txt", b"a")
    env.create_file("sub/b.txt", b"b")
    result = env.run("find /ssh/")
    assert "/ssh/a.txt" in result
    assert "/ssh/sub" in result
    assert "/ssh/sub/b.txt" in result


def test_find_decodes_byte_filenames(env):
    env.create_file("a.txt", b"a")
    env._sftp.filename_bytes = True
    result = env.run("find /ssh/")
    assert "/ssh/a.txt" in result
    assert "b'a.txt'" not in result


def test_find_name(env):
    env.create_file("a.txt", b"a")
    env.create_file("b.py", b"b")
    result = env.run("find /ssh/ -name '*.txt'")
    assert "a.txt" in result
    assert "b.py" not in result


def test_find_type_f(env):
    env.create_file("sub/f.txt", b"hi")
    result = env.run("find /ssh/ -type f")
    lines = result.strip().splitlines()
    assert any("f.txt" in line for line in lines)
    assert not any(line.endswith("/sub") for line in lines)


def test_find_type_d(env):
    env.create_file("sub/f.txt", b"hi")
    result = env.run("find /ssh/ -type d")
    assert "sub" in result


def test_find_maxdepth(env):
    env.create_file("a.txt", b"a")
    env.create_file("sub/nested.txt", b"n")
    env.create_file("sub/deep/deeper.txt", b"d")
    result = env.run("find /ssh/ -maxdepth 1 -type f")
    assert "a.txt" in result
    assert "nested.txt" not in result


def test_find_empty_matches_zero_length_file(env):
    env.create_file("empty.txt", b"")
    env.create_file("full.txt", b"full")
    result = env.run("find /ssh/ -empty")
    assert "empty.txt" in result
    assert "full.txt" not in result
    assert "deeper.txt" not in result


def test_find_size_skips_dirs(env):
    env.create_file("one.txt", b"x")
    env.create_file("big.txt", b"x" * 100)
    env.create_file("sub/f.txt", b"x" * 100)
    result = env.run("find /ssh/ -size -5c")
    assert "one.txt" in result
    assert "big.txt" not in result
    assert "/ssh/sub" in result


# ── du ─────────────────────────────────────────


def test_du(env):
    env.create_file("f.txt", b"hello")
    result = env.run("du /ssh/")
    assert "5" in result


def test_du_s(env):
    env.create_file("a.txt", b"aaa")
    env.create_file("b.txt", b"bb")
    result = env.run("du -s /ssh/")
    assert "5" in result


# ── grep ───────────────────────────────────────


def test_grep(env):
    env.create_file("f.txt", b"hello world\nfoo bar\nhello again\n")
    result = env.run("grep hello /ssh/f.txt")
    assert "hello world" in result
    assert "hello again" in result
    assert "foo bar" not in result


def test_grep_i(env):
    env.create_file("f.txt", b"Hello World\n")
    result = env.run("grep -i hello /ssh/f.txt")
    assert "Hello World" in result


def test_grep_c(env):
    env.create_file("f.txt", b"a\nb\na\n")
    result = env.run("grep -c a /ssh/f.txt")
    assert "2" in result


# ── cp ─────────────────────────────────────────


def test_cp(env):
    env.create_file("src.txt", b"data")
    env.run("cp /ssh/src.txt /ssh/dst.txt")
    assert env.run("cat /ssh/dst.txt") == "data"


def test_cp_shows_in_ls(env):
    env.create_file("a.txt", b"hello")
    env.run("cp /ssh/a.txt /ssh/b.txt")
    result = env.run("ls /ssh/")
    assert "a.txt" in result
    assert "b.txt" in result


# ── mv ─────────────────────────────────────────


def test_mv(env):
    env.create_file("old.txt", b"data")
    env.run("mv /ssh/old.txt /ssh/new.txt")
    assert env.run("cat /ssh/new.txt") == "data"


def test_mv_shows_in_ls(env):
    env.create_file("old.txt", b"data")
    env.run("mv /ssh/old.txt /ssh/new.txt")
    result = env.run("ls /ssh/")
    assert "new.txt" in result
    assert "old.txt" not in result


# ── mkdir ──────────────────────────────────────


def test_mkdir(env):
    env.run("mkdir /ssh/newdir")
    result = env.run("ls /ssh/")
    assert "newdir" in result


def test_mkdir_p(env):
    env.run("mkdir -p /ssh/a/b/c")
    result = env.run("stat /ssh/a/b/c")
    assert "directory" in result


# ── rm ─────────────────────────────────────────


def test_rm(env):
    env.create_file("f.txt", b"data")
    env.run("rm /ssh/f.txt")
    result = env.run("ls /ssh/")
    assert "f.txt" not in result


def test_rm_r(env):
    env.create_file("sub/a.txt", b"a")
    env.create_file("sub/b.txt", b"b")
    env.run("rm -r /ssh/sub")
    result = env.run("ls /ssh/")
    assert "sub" not in result


def test_rm_f_nonexistent(env):
    io = env.run_io("rm -f /ssh/nope.txt")
    assert io.exit_code == 0


# ── echo redirect ──────────────────────────────


def test_echo_redirect(env):
    env.run("echo hello > /ssh/out.txt")
    assert env.run("cat /ssh/out.txt") == "hello\n"


def test_echo_redirect_shows_in_ls(env):
    env.run("echo hello > /ssh/out.txt")
    result = env.run("ls /ssh/")
    assert "out.txt" in result


# ── cd + relative paths ────────────────────────


def test_cd_ls(env):
    env.create_file("a.txt", b"a")
    env.create_file("b.txt", b"b")
    env.run("cd /ssh/")
    result = env.run("ls")
    assert "a.txt" in result
    assert "b.txt" in result


def test_cd_subdir_cat(env):
    env.create_file("sub/f.txt", b"nested content")
    env.run("cd /ssh/sub")
    result = env.run("cat f.txt")
    assert result == "nested content"


def test_cd_parent(env):
    env.create_file("f.txt", b"root file")
    env.create_file("sub/g.txt", b"nested")
    env.run("cd /ssh/sub")
    env.run("cd ..")
    result = env.run("ls")
    assert "f.txt" in result
    assert "sub" in result


def test_pwd(env):
    env.run("cd /ssh/")
    result = env.run("pwd")
    assert "/ssh" in result


# ── cache invalidation ─────────────────────────


def test_write_invalidates_ls_cache(env):
    env.create_file("a.txt", b"a")
    env.run("ls /ssh/")
    env.run("echo new > /ssh/b.txt")
    result = env.run("ls /ssh/")
    assert "b.txt" in result


def test_mkdir_invalidates_ls_cache(env):
    env.create_file("a.txt", b"a")
    env.run("ls /ssh/")
    env.run("mkdir /ssh/newdir")
    result = env.run("ls /ssh/")
    assert "newdir" in result


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


def test_mv_invalidates_ls_cache(env):
    env.create_file("old.txt", b"data")
    env.run("ls /ssh/")
    env.run("mv /ssh/old.txt /ssh/new.txt")
    result = env.run("ls /ssh/")
    assert "new.txt" in result
    assert "old.txt" not in result


# ── pipe ───────────────────────────────────────


def test_pipe_grep_wc(env):
    env.create_file("f.txt", b"a\nb\na\nc\na\n")
    result = env.run("grep a /ssh/f.txt | wc -l")
    assert result.strip() == "3"


def test_pipe_cat_head(env):
    env.create_file("f.txt", b"1\n2\n3\n4\n5\n")
    result = env.run("cat /ssh/f.txt | head -n 2")
    assert result == "1\n2\n"
