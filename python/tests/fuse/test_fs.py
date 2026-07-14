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
import os
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

import pytest
import pytest_asyncio

from mirage.fuse.fs import MirageFS
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace

_fuse_available = sys.platform in ("linux", "darwin")


@pytest_asyncio.fixture
async def seed_ws():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("tee /a.txt", stdin=b"hello world")
    await ws.execute("mkdir /sub")
    await ws.execute("tee /sub/b.txt", stdin=b"nested")
    return ws


@pytest.fixture
def rw_ws():
    return Workspace({"/": RAMResource()}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_getattr_root(seed_ws):
    fs = MirageFS(seed_ws.ops)
    attrs = fs.getattr("/")
    assert attrs["st_mode"] & stat.S_IFDIR


@pytest.mark.asyncio
async def test_getattr_file(seed_ws):
    fs = MirageFS(seed_ws.ops)
    attrs = fs.getattr("/a.txt")
    assert attrs["st_mode"] & stat.S_IFREG
    assert attrs["st_size"] == len(b"hello world")


@pytest.mark.asyncio
async def test_getattr_dir(seed_ws):
    fs = MirageFS(seed_ws.ops)
    attrs = fs.getattr("/sub")
    assert attrs["st_mode"] & stat.S_IFDIR


@pytest.mark.asyncio
async def test_getattr_missing(seed_ws):
    fs = MirageFS(seed_ws.ops)
    with pytest.raises(OSError) as exc:
        fs.getattr("/no_such_file.txt")
    assert exc.value.errno == errno.ENOENT


@pytest.mark.asyncio
async def test_getattr_empty_readdir_not_ghost_dir():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("mkdir /emptydir")
    fs = MirageFS(ws.ops)
    with pytest.raises(OSError) as exc:
        fs.getattr("/typo_command")
    assert exc.value.errno == errno.ENOENT


@pytest.mark.asyncio
async def test_readdir_root(seed_ws):
    fs = MirageFS(seed_ws.ops)
    entries = fs.readdir("/", None)
    assert "." in entries
    assert ".." in entries
    assert "a.txt" in entries
    assert "sub" in entries


@pytest.mark.asyncio
async def test_readdir_subdir(seed_ws):
    fs = MirageFS(seed_ws.ops)
    entries = fs.readdir("/sub", None)
    assert "b.txt" in entries


@pytest.mark.asyncio
async def test_readdir_missing(seed_ws):
    fs = MirageFS(seed_ws.ops)
    with pytest.raises(OSError) as exc:
        fs.readdir("/nope", None)
    assert exc.value.errno == errno.ENOENT


@pytest.mark.asyncio
async def test_read_full(seed_ws):
    fs = MirageFS(seed_ws.ops)
    fh = fs.open("/a.txt", os.O_RDONLY)
    data = fs.read("/a.txt", 1024, 0, fh)
    assert data == b"hello world"


@pytest.mark.asyncio
async def test_read_offset(seed_ws):
    fs = MirageFS(seed_ws.ops)
    fh = fs.open("/a.txt", os.O_RDONLY)
    data = fs.read("/a.txt", 5, 6, fh)
    assert data == b"world"


@pytest.mark.asyncio
async def test_open_missing(seed_ws):
    fs = MirageFS(seed_ws.ops)
    with pytest.raises(OSError) as exc:
        fs.open("/missing.txt", os.O_RDONLY)
    assert exc.value.errno == errno.ENOENT


@pytest.mark.asyncio
async def test_create_and_write(rw_ws):
    fs = MirageFS(rw_ws.ops)
    fh = fs.create("/new.txt", 0o644)
    fs.write("/new.txt", b"data", 0, fh)
    fs.flush("/new.txt", fh)
    result = await rw_ws.execute("cat /new.txt")
    assert result.stdout == b"data"


@pytest.mark.asyncio
async def test_mkdir(rw_ws):
    fs = MirageFS(rw_ws.ops)
    fs.mkdir("/newdir", 0o755)
    entries = fs.readdir("/newdir", None)
    assert "." in entries


@pytest.mark.asyncio
async def test_unlink(rw_ws):
    await rw_ws.execute("tee /todel.txt", stdin=b"bye")
    fs = MirageFS(rw_ws.ops)
    fs.unlink("/todel.txt")
    with pytest.raises(OSError) as exc:
        fs.getattr("/todel.txt")
    assert exc.value.errno == errno.ENOENT


@pytest.mark.asyncio
async def test_rename(rw_ws):
    await rw_ws.execute("tee /old.txt", stdin=b"content")
    fs = MirageFS(rw_ws.ops)
    fs.rename("/old.txt", "/new.txt")
    result = await rw_ws.execute("cat /new.txt")
    assert result.stdout == b"content"


@pytest.mark.asyncio
async def test_rmdir_empty(rw_ws):
    await rw_ws.execute("mkdir /emptydir")
    fs = MirageFS(rw_ws.ops)
    fs.rmdir("/emptydir")


@pytest.mark.asyncio
async def test_rmdir_nonempty(rw_ws):
    await rw_ws.execute("mkdir /nonempty")
    await rw_ws.execute("tee /nonempty/file.txt", stdin=b"x")
    fs = MirageFS(rw_ws.ops)
    with pytest.raises(OSError) as exc:
        fs.rmdir("/nonempty")
    assert exc.value.errno == errno.ENOTEMPTY


@pytest.mark.asyncio
async def test_truncate(rw_ws):
    await rw_ws.execute("tee /f.txt", stdin=b"hello world")
    fs = MirageFS(rw_ws.ops)
    fs.truncate("/f.txt", 5)
    result = await rw_ws.execute("cat /f.txt")
    assert result.stdout == b"hello"


@pytest.mark.asyncio
async def test_truncate_extend(rw_ws):
    await rw_ws.execute("tee /f.txt", stdin=b"hi")
    fs = MirageFS(rw_ws.ops)
    fs.truncate("/f.txt", 5)
    result = await rw_ws.execute("cat /f.txt")
    assert result.stdout == b"hi\x00\x00\x00"


@pytest.mark.asyncio
async def test_write_at_offset(rw_ws):
    await rw_ws.execute("tee /f.txt", stdin=b"hello world")
    fs = MirageFS(rw_ws.ops)
    fh = fs.open("/f.txt", os.O_RDWR)
    fs.write("/f.txt", b"WORLD", 6, fh)
    fs.flush("/f.txt", fh)
    result = await rw_ws.execute("cat /f.txt")
    assert result.stdout == b"hello WORLD"


@pytest.mark.asyncio
async def test_statfs(seed_ws):
    fs = MirageFS(seed_ws.ops)
    result = fs.statfs("/")
    assert "f_bsize" in result
    assert "f_blocks" in result
    assert result["f_bsize"] > 0


@pytest.mark.asyncio
async def test_chmod_does_not_raise(seed_ws):
    fs = MirageFS(seed_ws.ops)
    fs.chmod("/a.txt", 0o644)


@pytest.mark.asyncio
async def test_chown_does_not_raise(seed_ws):
    fs = MirageFS(seed_ws.ops)
    fs.chown("/a.txt", os.getuid(), os.getgid())


@pytest.mark.asyncio
async def test_utimens_does_not_raise(seed_ws):
    fs = MirageFS(seed_ws.ops)
    fs.utimens("/a.txt", None)


@pytest.mark.asyncio
async def test_access_does_not_raise(seed_ws):
    fs = MirageFS(seed_ws.ops)
    fs.access("/a.txt", os.R_OK)


@pytest.mark.asyncio
async def test_fsync_delegates_to_flush(rw_ws):
    await rw_ws.execute("tee /f.txt", stdin=b"before")
    fs = MirageFS(rw_ws.ops)
    fh = fs.open("/f.txt", os.O_RDWR)
    fs.write("/f.txt", b"after!", 0, fh)
    fs.fsync("/f.txt", 0, fh)
    result = await rw_ws.execute("cat /f.txt")
    assert result.stdout == b"after!"


@pytest.mark.asyncio
async def test_open_returns_unique_handles(seed_ws):
    fs = MirageFS(seed_ws.ops)
    fh1 = fs.open("/a.txt", os.O_RDONLY)
    fh2 = fs.open("/a.txt", os.O_RDONLY)
    assert fh1 != fh2


@pytest.mark.asyncio
async def test_release_cleans_handles(seed_ws):
    fs = MirageFS(seed_ws.ops)
    fh = fs.open("/a.txt", os.O_RDONLY)
    assert fh in fs._handles
    fs.release("/a.txt", fh)
    assert fh not in fs._handles


@pytest.mark.asyncio
async def test_drain_ops_returns_and_clears(rw_ws):
    await rw_ws.execute("tee /track.txt", stdin=b"x")
    fs = MirageFS(rw_ws.ops)
    fh = fs.create("/new.txt", 0o644)
    fs.write("/new.txt", b"y", 0, fh)
    fs.flush("/new.txt", fh)
    ops = fs.drain_ops()
    assert any(o["op"] == "create" for o in ops)
    assert any(o["op"] == "write" for o in ops)
    assert len(fs.drain_ops()) == 0


@pytest.mark.asyncio
async def test_drain_ops_read_deduplication(seed_ws):
    fs = MirageFS(seed_ws.ops)
    fh = fs.open("/a.txt", os.O_RDONLY)
    fs.read("/a.txt", 1024, 0, fh)
    fs.read("/a.txt", 1024, 0, fh)
    ops = fs.drain_ops()
    read_ops = [o for o in ops if o["op"] == "read" and o["path"] == "/a.txt"]
    assert len(read_ops) >= 1


@pytest.mark.asyncio
async def test_fuse_read_uses_cache_when_populated():
    mem = RAMResource()
    mem.caches_reads = True
    mem._store.files["/a.txt"] = b"hello world"
    ws = Workspace({"/": mem}, mode=MountMode.WRITE)
    await ws.execute("cat /a.txt")
    fs = MirageFS(ws.ops)
    fh = fs.open("/a.txt", os.O_RDONLY)
    data = fs.read("/a.txt", 5, 0, fh)
    assert data == b"hello"
    assert (await ws._cache.get("/a.txt")) is not None


@pytest.mark.asyncio
async def test_readdir_logs_ls_op(seed_ws):
    fs = MirageFS(seed_ws.ops)
    fs.readdir("/", None)
    ops = fs.drain_ops()
    assert any(o["op"] == "readdir" and o["path"] == "/" for o in ops)


@pytest.mark.asyncio
async def test_total_ops_persists_across_drains(seed_ws):
    fs = MirageFS(seed_ws.ops)
    fs.readdir("/", None)
    first = fs.drain_ops()
    fs.readdir("/sub", None)
    second = fs.drain_ops()
    assert len(first) >= 1
    assert len(second) >= 1


@pytest.mark.asyncio
async def test_total_ops_counts_reads_and_writes(rw_ws):
    await rw_ws.execute("tee /f.txt", stdin=b"x")
    fs = MirageFS(rw_ws.ops)
    fs._ops.records.clear()
    fh = fs.open("/f.txt", os.O_RDONLY)
    fs.read("/f.txt", 1024, 0, fh)
    fh2 = fs.create("/g.txt", 0o644)
    fs.write("/g.txt", b"y", 0, fh2)
    fs.flush("/g.txt", fh2)
    ops = fs.drain_ops()
    assert len(ops) >= 3


def test_permission_error_logged_on_create():
    ro_ws = Workspace({"/": RAMResource()}, mode=MountMode.READ)
    fs = MirageFS(ro_ws.ops)
    with pytest.raises(Exception):
        fs.create("/new.txt", 0o644)


def test_permission_error_not_counted_as_op():
    ro_ws = Workspace({"/": RAMResource()}, mode=MountMode.READ)
    fs = MirageFS(ro_ws.ops)
    fs._ops.records.clear()
    with pytest.raises(Exception):
        fs.create("/new.txt", 0o644)
    ops = fs.drain_ops()
    assert len(ops) == 0


@pytest.mark.asyncio
async def test_fuse_dispatches_to_backend_hooks(seed_ws):
    fs = MirageFS(seed_ws.ops)
    fh = fs.open("/a.txt", os.O_RDONLY)
    data = fs.read("/a.txt", 1024, 0, fh)
    assert data == b"hello world"


@pytest.mark.asyncio
async def test_fuse_write_buffered_flush(rw_ws):
    fs = MirageFS(rw_ws.ops)
    await rw_ws.execute("tee /f.txt", stdin=b"hello world")
    fh = fs.open("/f.txt", os.O_RDWR)
    fs.write("/f.txt", b"HELLO", 0, fh)
    fs.flush("/f.txt", fh)
    result = await rw_ws.execute("cat /f.txt")
    assert result.stdout == b"HELLO world"


@pytest.mark.skipif(not _fuse_available,
                    reason="FUSE not available on this platform")
@pytest.mark.asyncio
async def test_mount_background_readable():
    from mirage.fuse.mount import mount_background
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("tee /hello.txt", stdin=b"hi from memory")
    with tempfile.TemporaryDirectory() as mountpoint:
        t = mount_background(ws.ops, mountpoint)
        try:
            import time
            time.sleep(1)
            path = os.path.join(mountpoint, "hello.txt")
            assert os.path.exists(path)
            with open(path, "rb") as f:
                assert f.read() == b"hi from memory"
        finally:
            if sys.platform == "darwin":
                subprocess.run(["diskutil", "unmount", "force", mountpoint],
                               capture_output=True)
            else:
                subprocess.run(["fusermount", "-u", mountpoint],
                               capture_output=True)
            t.join(timeout=3)


@pytest.mark.asyncio
async def test_xattr_set_get_roundtrip(seed_ws):
    fs = MirageFS(seed_ws.ops)
    fs.setxattr("/a.txt", "user.test", b"value", 0)
    assert fs.getxattr("/a.txt", "user.test") == b"value"


@pytest.mark.asyncio
async def test_xattr_get_missing_raises(seed_ws):
    fs = MirageFS(seed_ws.ops)
    with pytest.raises(OSError) as exc:
        fs.getxattr("/a.txt", "user.absent")
    assert exc.value.errno in (errno.ENODATA,
                               getattr(errno, "ENOATTR", errno.ENODATA))


@pytest.mark.asyncio
async def test_xattr_list_and_remove(seed_ws):
    fs = MirageFS(seed_ws.ops)
    fs.setxattr("/a.txt", "user.one", b"1", 0)
    fs.setxattr("/a.txt", "user.two", b"2", 0)
    assert sorted(fs.listxattr("/a.txt")) == ["user.one", "user.two"]
    fs.removexattr("/a.txt", "user.one")
    assert fs.listxattr("/a.txt") == ["user.two"]


@pytest.mark.asyncio
async def test_xattr_probe_succeeds(seed_ws):
    fs = MirageFS(seed_ws.ops)
    assert fs.setxattr("/a.txt", "user.containers._probe", b"x", 0) == 0
    assert fs.removexattr("/a.txt", "user.containers._probe") == 0


@pytest.mark.asyncio
async def test_xattr_cleared_on_unlink(seed_ws):
    fs = MirageFS(seed_ws.ops)
    fs.setxattr("/a.txt", "user.keep", b"v", 0)
    fs.unlink("/a.txt")
    assert fs.listxattr("/sub") == []
    assert "/a.txt" not in fs._xattrs


@pytest.mark.asyncio
async def test_xattr_follows_rename(seed_ws):
    fs = MirageFS(seed_ws.ops)
    fs.setxattr("/a.txt", "user.keep", b"v", 0)
    fs.rename("/a.txt", "/renamed.txt")
    assert fs.getxattr("/renamed.txt", "user.keep") == b"v"
    assert "/a.txt" not in fs._xattrs


class _SizelessOps:

    def __init__(self, ops):
        self._inner = ops
        self.read_calls = 0

    def __getattr__(self, name):
        return getattr(self._inner, name)

    async def stat(self, path):
        s = await self._inner.stat(path)
        return s.model_copy(update={"size": None})

    async def read(self, path):
        self.read_calls += 1
        return await self._inner.read(path)


_PAYLOAD = b"payload-bytes"


@pytest_asyncio.fixture
async def sizeless_fs():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("tee /u.json", stdin=_PAYLOAD)
    ops = _SizelessOps(ws.ops)
    return MirageFS(ops), ops


@pytest.mark.asyncio
async def test_unknown_size_preopen_stats_zero(sizeless_fs):
    fs, ops = sizeless_fs
    attrs = fs.getattr("/u.json")
    assert attrs["st_size"] == 0
    assert ops.read_calls == 0


@pytest.mark.asyncio
async def test_unknown_size_fh_stat_returns_real_size(sizeless_fs):
    fs, _ = sizeless_fs
    fh = fs.open("/u.json", os.O_RDONLY)
    attrs = fs.getattr("/u.json", fh)
    assert attrs["st_size"] == len(_PAYLOAD)


@pytest.mark.asyncio
async def test_unknown_size_path_stat_uses_open_handle(sizeless_fs):
    fs, _ = sizeless_fs
    fs.open("/u.json", os.O_RDONLY)
    attrs = fs.getattr("/u.json")
    assert attrs["st_size"] == len(_PAYLOAD)


@pytest.mark.asyncio
async def test_prefetch_survives_release_within_ttl(sizeless_fs):
    fs, ops = sizeless_fs
    fh = fs.open("/u.json", os.O_RDONLY)
    fs.release("/u.json", fh)
    attrs = fs.getattr("/u.json")
    assert attrs["st_size"] == len(_PAYLOAD)
    assert ops.read_calls == 1


@pytest.mark.asyncio
async def test_prefetch_expires_after_ttl(sizeless_fs):
    fs, _ = sizeless_fs
    fh = fs.open("/u.json", os.O_RDONLY)
    fs.release("/u.json", fh)
    data, _ = fs._prefetch["/u.json"]
    fs._prefetch["/u.json"] = (data, 0.0)
    attrs = fs.getattr("/u.json")
    assert attrs["st_size"] == 0
    assert "/u.json" not in fs._prefetch


@pytest.mark.asyncio
async def test_open_then_read_does_not_refetch(sizeless_fs):
    fs, ops = sizeless_fs
    fh = fs.open("/u.json", os.O_RDONLY)
    assert fs.read("/u.json", 1024, 0, fh) == _PAYLOAD
    assert fs.read("/u.json", 7, 0, fh) == _PAYLOAD[:7]
    assert ops.read_calls == 1


@pytest.mark.asyncio
async def test_flush_drops_prefetch(sizeless_fs):
    fs, _ = sizeless_fs
    fh = fs.open("/u.json", os.O_RDWR)
    assert "/u.json" in fs._prefetch
    fs.write("/u.json", b"NEW", 0, fh)
    fs.flush("/u.json", fh)
    assert "/u.json" not in fs._prefetch


@pytest.mark.asyncio
async def test_unlink_drops_prefetch(sizeless_fs):
    fs, _ = sizeless_fs
    fh = fs.open("/u.json", os.O_RDONLY)
    fs.release("/u.json", fh)
    fs.unlink("/u.json")
    assert "/u.json" not in fs._prefetch


@pytest.mark.asyncio
async def test_getattr_symlink(seed_ws):
    await seed_ws.execute("ln -s /a.txt /lnk")
    fs = MirageFS(seed_ws.ops)
    attrs = fs.getattr("/lnk")
    assert stat.S_ISLNK(attrs["st_mode"])
    assert attrs["st_size"] == len("a.txt")


@pytest.mark.asyncio
async def test_readlink_absolute_target_rewritten_relative(seed_ws):
    await seed_ws.execute("ln -s /sub/b.txt /lnk")
    fs = MirageFS(seed_ws.ops)
    assert fs.readlink("/lnk") == "sub/b.txt"


@pytest.mark.asyncio
async def test_readlink_non_link_einval(seed_ws):
    fs = MirageFS(seed_ws.ops)
    with pytest.raises(OSError) as exc:
        fs.readlink("/a.txt")
    assert exc.value.errno == errno.EINVAL


@pytest.mark.asyncio
async def test_readdir_lists_link(seed_ws):
    await seed_ws.execute("ln -s /a.txt /lnk")
    fs = MirageFS(seed_ws.ops)
    assert "lnk" in fs.readdir("/", None)


@pytest.mark.asyncio
async def test_read_through_link(seed_ws):
    await seed_ws.execute("ln -s /a.txt /lnk")
    fs = MirageFS(seed_ws.ops)
    assert fs.read("/lnk", 1024, 0, 0) == b"hello world"


@pytest.mark.asyncio
async def test_symlink_create_then_read(rw_ws):
    await rw_ws.execute("tee /f.txt", stdin=b"data")
    fs = MirageFS(rw_ws.ops)
    fs.symlink("/lnk", "/f.txt")
    assert fs.readlink("/lnk") == "f.txt"
    assert fs.read("/lnk", 1024, 0, 0) == b"data"


@pytest.mark.asyncio
async def test_unlink_link_keeps_target(seed_ws):
    await seed_ws.execute("ln -s /a.txt /lnk")
    fs = MirageFS(seed_ws.ops)
    fs.unlink("/lnk")
    with pytest.raises(OSError):
        fs.getattr("/lnk")
    assert fs.getattr("/a.txt")["st_size"] == len(b"hello world")


@pytest.mark.asyncio
async def test_scoped_root_link_display(seed_ws):
    await seed_ws.execute("ln -s /sub/b.txt /sub/lnk")
    fs = MirageFS(seed_ws.ops, root_prefix="/sub")
    assert fs.readlink("/lnk") == "b.txt"


@pytest.mark.asyncio
async def test_getattr_honors_chmod_overlay(seed_ws):
    await seed_ws.execute("chmod 640 /a.txt")
    fs = MirageFS(seed_ws.ops)
    attrs = fs.getattr("/a.txt")
    assert stat.S_ISREG(attrs["st_mode"])
    assert stat.S_IMODE(attrs["st_mode"]) == 0o640


@pytest.mark.asyncio
async def test_getattr_honors_touch_mtime(seed_ws):
    await seed_ws.execute("touch -t 202603041200 /a.txt")
    fs = MirageFS(seed_ws.ops)
    stamp = datetime(2026, 3, 4, 12, 0, tzinfo=timezone.utc)
    assert fs.getattr("/a.txt")["st_mtime"] == int(stamp.timestamp()) * 10**9
