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
import importlib
import os
import stat
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

import pytest
import pytest_asyncio

from mirage.fuse.constants import XATTR_CREATE, XATTR_REPLACE
from mirage.fuse.fs import MirageFS
from mirage.types import FileType, HiddenPaths, MountMode, Visibility
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

try:
    importlib.import_module("mfusepy")
    _driver_present = True
except (ImportError, OSError, AttributeError):
    # mfusepy imports only where it finds a libfuse it can use; without one
    # mount_background raises before it mounts anything.
    _driver_present = False

_fuse_available = sys.platform in ("linux", "darwin") and _driver_present


@pytest_asyncio.fixture
async def seed_ws():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("tee /a.txt", stdin=b"hello world")
    await ws.shell("mkdir /sub")
    await ws.shell("tee /sub/b.txt", stdin=b"nested")
    return ws


@pytest.fixture
def rw_ws():
    return Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_getattr_missing(seed_ws):
    fs = MirageFS(seed_ws.vfs)
    with pytest.raises(OSError) as exc:
        fs.getattr("/no_such_file.txt")
    assert exc.value.errno == errno.ENOENT


@pytest.mark.asyncio
async def test_read_offset(seed_ws):
    fs = MirageFS(seed_ws.vfs)
    fh = fs.open("/a.txt", os.O_RDONLY)
    data = fs.read("/a.txt", 5, 6, fh)
    assert data == b"world"


@pytest.mark.asyncio
async def test_create_and_write(rw_ws):
    fs = MirageFS(rw_ws.vfs)
    fh = fs.create("/new.txt", 0o644)
    fs.write("/new.txt", b"data", 0, fh)
    fs.flush("/new.txt", fh)
    result = await rw_ws.shell("cat /new.txt")
    assert result.stdout == b"data"


@pytest.mark.asyncio
async def test_rmdir_nonempty(rw_ws):
    await rw_ws.shell("mkdir /nonempty")
    await rw_ws.shell("tee /nonempty/file.txt", stdin=b"x")
    fs = MirageFS(rw_ws.vfs)
    with pytest.raises(OSError) as exc:
        fs.rmdir("/nonempty")
    assert exc.value.errno == errno.ENOTEMPTY


@pytest.mark.asyncio
async def test_truncate_extend(rw_ws):
    await rw_ws.shell("tee /f.txt", stdin=b"hi")
    fs = MirageFS(rw_ws.vfs)
    fs.truncate("/f.txt", 5)
    result = await rw_ws.shell("cat /f.txt")
    assert result.stdout == b"hi\x00\x00\x00"


@pytest.mark.asyncio
async def test_open_forwards_o_trunc(rw_ws):
    # The adapter used to drop the open flags, so a fuse3 O_TRUNC open
    # (no separate truncate op arrives) merged the new bytes over the
    # old body (#1032).
    await rw_ws.shell("tee /f.txt", stdin=b"AAAAAAAAAAAAAAAAAAAA\n")
    fs = MirageFS(rw_ws.vfs)
    fh = fs.open("/f.txt", os.O_WRONLY | os.O_TRUNC)
    fs.write("/f.txt", b"BB\n", 0, fh)
    fs.flush("/f.txt", fh)
    fs.release("/f.txt", fh)
    result = await rw_ws.shell("cat /f.txt")
    assert result.stdout == b"BB\n"


@pytest.mark.asyncio
async def test_statfs(seed_ws):
    fs = MirageFS(seed_ws.vfs)
    result = fs.statfs("/")
    assert "f_bsize" in result
    assert "f_blocks" in result
    assert result["f_bsize"] > 0


@pytest.mark.asyncio
async def test_chmod_is_what_the_shell_stat_reads(seed_ws):
    fs = MirageFS(seed_ws.vfs)
    fs.chmod("/a.txt", stat.S_IFREG | 0o600)
    result = await seed_ws.shell("stat -c %a /a.txt")
    assert result.stdout == b"600\n"
    assert stat.S_IMODE(fs.getattr("/a.txt")["st_mode"]) == 0o600


@pytest.mark.asyncio
async def test_chown_is_what_the_shell_stat_reads(seed_ws):
    fs = MirageFS(seed_ws.vfs)
    fs.chown("/a.txt", 1234, 5678)
    fs.chown("/a.txt", -1, 4321)
    result = await seed_ws.shell("stat -c '%u %g' /a.txt")
    assert result.stdout == b"1234 4321\n"


@pytest.mark.asyncio
async def test_utimens_leaves_an_omitted_time(seed_ws):
    # `touch -m` marks the access time UTIME_OMIT.
    fs = MirageFS(seed_ws.vfs)
    fs.utimens(
        "/a.txt", (1_000_000_000_000_000_000, 1_000_000_000_000_000_000)
    )
    fs.utimens("/a.txt", (None, 1_100_000_000_000_000_000))
    result = await seed_ws.shell("stat -c '%X %Y' /a.txt")
    assert result.stdout == b"1000000000 1100000000\n"


@pytest.mark.asyncio
async def test_utimens_with_no_times_is_now(seed_ws):
    fs = MirageFS(seed_ws.vfs)
    before = time.time()
    fs.utimens(
        "/a.txt", (1_000_000_000_000_000_000, 1_000_000_000_000_000_000)
    )
    fs.utimens("/a.txt", None)
    result = await seed_ws.shell("stat -c '%Y' /a.txt")
    assert int(result.stdout) >= int(before)


@pytest.mark.asyncio
async def test_create_and_mkdir_keep_the_mode_asked_for(rw_ws):
    # open(O_CREAT, 0600) and mkdir(0700) arrive with the mode, umask
    # applied; a shell stat reads it back.
    fs = MirageFS(rw_ws.vfs)
    fh = fs.create("/secret", stat.S_IFREG | 0o600)
    fs.release("/secret", fh)
    fs.mkdir("/private", 0o700)
    result = await rw_ws.shell("stat -c '%a %n' /secret /private")
    assert result.stdout == b"600 /secret\n700 /private\n"


@pytest.mark.asyncio
async def test_setattr_x_metadata_only_accepts(seed_ws):
    # The FSKit shim finalizes every created item through setattr_x; a
    # metadata-only payload must succeed for create/mkdir to work at all.
    fs = MirageFS(seed_ws.vfs)
    assert fs.setattr_x("/a.txt", {"mode": 0o640, "uid": 501, "gid": 20}) == 0
    result = await seed_ws.shell("stat -c '%a %u %g' /a.txt")
    assert result.stdout == b"640 501 20\n"


@pytest.mark.asyncio
async def test_setattr_x_size_truncates(rw_ws):
    await rw_ws.shell("tee /t.txt", stdin=b"longcontent")
    fs = MirageFS(rw_ws.vfs)
    assert fs.setattr_x("/t.txt", {"size": 4}) == 0
    result = await rw_ws.shell("cat /t.txt")
    assert result.stdout == b"long"


@pytest.mark.asyncio
async def test_fsetattr_x_routes_to_setattr_x(rw_ws):
    await rw_ws.shell("tee /t2.txt", stdin=b"longcontent")
    fs = MirageFS(rw_ws.vfs)
    assert fs.fsetattr_x("/t2.txt", {"size": 2}, fh=7) == 0
    result = await rw_ws.shell("cat /t2.txt")
    assert result.stdout == b"lo"


@pytest.mark.asyncio
async def test_renamex_plain(rw_ws):
    await rw_ws.shell("tee /rx.txt", stdin=b"content")
    fs = MirageFS(rw_ws.vfs)
    assert fs.renamex("/rx.txt", "/rx2.txt", 0) == 0
    result = await rw_ws.shell("cat /rx2.txt")
    assert result.stdout == b"content"


@pytest.mark.asyncio
async def test_renamex_excl_rejects_existing_target(rw_ws):
    await rw_ws.shell("tee /src.txt", stdin=b"a")
    await rw_ws.shell("tee /dst.txt", stdin=b"b")
    fs = MirageFS(rw_ws.vfs)
    with pytest.raises(OSError) as exc:
        fs.renamex("/src.txt", "/dst.txt", 0x4)
    assert exc.value.errno == errno.EEXIST


@pytest.mark.asyncio
async def test_renamex_swap_is_enotsup(rw_ws):
    await rw_ws.shell("tee /s1.txt", stdin=b"a")
    await rw_ws.shell("tee /s2.txt", stdin=b"b")
    fs = MirageFS(rw_ws.vfs)
    with pytest.raises(OSError) as exc:
        fs.renamex("/s1.txt", "/s2.txt", 0x2)
    assert exc.value.errno == errno.ENOTSUP


@pytest.mark.asyncio
async def test_fsync_delegates_to_flush(rw_ws):
    await rw_ws.shell("tee /f.txt", stdin=b"before")
    fs = MirageFS(rw_ws.vfs)
    fh = fs.open("/f.txt", os.O_RDWR)
    fs.write("/f.txt", b"after!", 0, fh)
    fs.fsync("/f.txt", 0, fh)
    result = await rw_ws.shell("cat /f.txt")
    assert result.stdout == b"after!"


@pytest.mark.asyncio
async def test_mount_ops_land_on_the_workspace_ledger(rw_ws):
    await rw_ws.shell("tee /track.txt", stdin=b"x")
    fs = MirageFS(rw_ws.vfs)
    fh = fs.create("/new.txt", 0o644)
    fs.write("/new.txt", b"y", 0, fh)
    fs.flush("/new.txt", fh)
    ops = [r.op for r in rw_ws.vfs.records]
    assert "create" in ops
    assert "write" in ops


@pytest.mark.skipif(
    not _fuse_available, reason="FUSE not available on this platform"
)
@pytest.mark.asyncio
async def test_mount_background_readable():
    from mirage.fuse.mount import mount_background

    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("tee /hello.txt", stdin=b"hi from memory")
    with tempfile.TemporaryDirectory() as mountpoint:
        t = mount_background(ws.vfs, mountpoint)
        try:
            import time

            time.sleep(1)
            path = os.path.join(mountpoint, "hello.txt")
            assert os.path.exists(path)
            with open(path, "rb") as f:
                assert f.read() == b"hi from memory"
        finally:
            if sys.platform == "darwin":
                subprocess.run(
                    ["diskutil", "unmount", "force", mountpoint],
                    capture_output=True,
                )
            else:
                subprocess.run(
                    ["fusermount", "-u", mountpoint], capture_output=True
                )
            t.join(timeout=3)


@pytest.mark.asyncio
async def test_xattr_create_and_replace_flags_reach_the_dispatcher(seed_ws):
    fs = MirageFS(seed_ws.vfs)
    fs.setxattr("/a.txt", "user.once", b"1", XATTR_CREATE)
    with pytest.raises(OSError) as exists:
        fs.setxattr("/a.txt", "user.once", b"2", XATTR_CREATE)
    assert exists.value.errno == errno.EEXIST
    with pytest.raises(OSError) as absent:
        fs.setxattr("/a.txt", "user.none", b"2", XATTR_REPLACE)
    assert absent.value.errno in (
        errno.ENODATA,
        getattr(errno, "ENOATTR", errno.ENODATA),
    )


class _SizelessOps:
    def __init__(self, ops):
        self._inner = ops
        self.read_calls = 0
        self.read_error: Exception | None = None

    def __getattr__(self, name):
        return getattr(self._inner, name)

    async def stat(self, path, nofollow=False):
        s = await self._inner.stat(path, nofollow=nofollow)
        return s.model_copy(update={"size": None})

    async def read(self, path, offset=0, size=None, raw=False):
        self.read_calls += 1
        if self.read_error is not None:
            raise self.read_error
        return await self._inner.read(path, offset, size, raw)


_PAYLOAD = b"payload-bytes"


@pytest_asyncio.fixture
async def sizeless_fs():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("tee /u.json", stdin=_PAYLOAD)
    ops = _SizelessOps(ws.vfs)
    return MirageFS(ops), ops


@pytest.mark.asyncio
async def test_unknown_size_preopen_stats_zero(sizeless_fs):
    fs, ops = sizeless_fs
    attrs = fs.getattr("/u.json")
    assert attrs["st_size"] == 0
    assert ops.read_calls == 0


@pytest.mark.asyncio
async def test_unknown_size_truncate_cuts_the_hydrated_handle(sizeless_fs):
    # A reader hydrated the file at open; an O_TRUNC open elsewhere must
    # not leave that handle serving the pre-truncation bytes.
    fs, _ = sizeless_fs
    reader = fs.open("/u.json", os.O_RDONLY)
    assert fs.getattr("/u.json", reader)["st_size"] == len(_PAYLOAD)
    writer = fs.open("/u.json", os.O_WRONLY | os.O_TRUNC)
    assert fs.getattr("/u.json", reader)["st_size"] == 0
    assert fs.read("/u.json", 100, 0, reader) == b""
    fs.release("/u.json", writer)
    fs.release("/u.json", reader)


@pytest.mark.asyncio
async def test_unknown_size_truncate_rehydrates_with_settled_writes(
    sizeless_fs,
):
    # A nonzero truncate lands after another handle's buffered write, and
    # the hydrated reader must see both: the settled write and the cut.
    fs, _ = sizeless_fs
    reader = fs.open("/u.json", os.O_RDONLY)
    writer = fs.open("/u.json", os.O_WRONLY)
    fs.write("/u.json", b"J", 0, writer)
    fs.truncate("/u.json", 5)
    assert fs.getattr("/u.json", reader)["st_size"] == 5
    assert fs.read("/u.json", 100, 0, reader) == b"J" + _PAYLOAD[1:5]
    fs.release("/u.json", writer)
    fs.release("/u.json", reader)


class _UnsizedRAM(RAMVFS):
    """A caching mount whose backend names no size, as an API mount does."""

    caches_reads = True

    def __init__(self) -> None:
        super().__init__()
        self._store.dirs.add("/")
        self._store.files["/u.json"] = _PAYLOAD
        self.reads = 0

    async def stat(self, path, *args, **kwargs):
        row = await super().stat(path, *args, **kwargs)
        if row.type == FileType.DIRECTORY:
            return row
        return row.model_copy(update={"size": None})

    async def read(self, path, *args, **kwargs):
        self.reads += 1
        return await super().read(path, *args, **kwargs)


@pytest.mark.asyncio
async def test_a_released_files_size_comes_from_the_workspace_cache():
    vfs = _UnsizedRAM()
    fs = MirageFS(Workspace({"/": vfs}, mode=MountMode.WRITE).vfs)
    assert fs.getattr("/u.json")["st_size"] == 0
    fh = fs.open("/u.json", os.O_RDONLY)
    assert fs.read("/u.json", 1024, 0, fh) == _PAYLOAD
    fs.release("/u.json", fh)
    assert fs.getattr("/u.json")["st_size"] == len(_PAYLOAD)
    fh = fs.open("/u.json", os.O_RDONLY)
    fs.release("/u.json", fh)
    assert vfs.reads == 1


@pytest.mark.asyncio
async def test_unknown_size_truncate_through_a_link_leaves_no_stale_size():
    # The target was opened and released as /u.json, leaving its bytes in
    # the workspace cache; an O_TRUNC open through a link to it must not
    # leave the old length for the next stat of /u.json.
    ws = Workspace({"/": _UnsizedRAM()}, mode=MountMode.WRITE)
    await ws.shell("ln -s u.json /lk")
    fs = MirageFS(ws.vfs)
    fh = fs.open("/u.json", os.O_RDONLY)
    fs.release("/u.json", fh)
    assert fs.getattr("/u.json")["st_size"] == len(_PAYLOAD)
    writer = fs.open("/lk", os.O_WRONLY | os.O_TRUNC)
    fs.release("/lk", writer)
    assert fs.getattr("/u.json")["st_size"] == 0


@pytest.mark.asyncio
async def test_unknown_size_write_refreshes_the_writing_handle(sizeless_fs):
    # The hydrated bytes on the handle that wrote are refreshed at flush,
    # so a read-after-write through the same descriptor sees the write.
    fs, _ = sizeless_fs
    fh = fs.open("/u.json", os.O_RDWR)
    fs.write("/u.json", b"J", 0, fh)
    fs.flush("/u.json", fh)
    assert fs.read("/u.json", 100, 0, fh) == b"J" + _PAYLOAD[1:]
    assert fs.getattr("/u.json", fh)["st_size"] == len(_PAYLOAD)
    fs.release("/u.json", fh)


@pytest.mark.asyncio
async def test_unknown_size_failed_refresh_does_not_fail_the_truncate(
    sizeless_fs,
):
    # The truncation has landed by the time the hydrated reader is
    # refreshed; a backend hiccup there must not turn a committed
    # truncate into a failure. The reader just fetches again next time.
    fs, ops = sizeless_fs
    reader = fs.open("/u.json", os.O_RDONLY)
    ops.read_error = OSError(errno.EIO, "backend hiccup")
    fs.truncate("/u.json", 0)
    ops.read_error = None
    assert fs.read("/u.json", 100, 0, reader) == b""
    fs.release("/u.json", reader)


@pytest.mark.asyncio
async def test_unknown_size_o_trunc_open_survives_a_failed_hydration(
    sizeless_fs,
):
    # The truncation has committed by the time the handle is hydrated; a
    # backend error there must not fail the open, or the old body is gone
    # and the replacement is never written. The next read fetches again.
    fs, ops = sizeless_fs
    ops.read_error = OSError(errno.EIO, "backend hiccup")
    fh = fs.open("/u.json", os.O_WRONLY | os.O_TRUNC)
    ops.read_error = None
    assert fs.getattr("/u.json", fh)["st_size"] == 0
    assert fs.read("/u.json", 100, 0, fh) == b""
    fs.release("/u.json", fh)


@pytest.mark.asyncio
async def test_unknown_size_open_defers_a_failed_hydration_to_read(
    sizeless_fs,
):
    # A plain open stays permissive on any read failure; the error reaches
    # the caller from the read that follows, as open(2) would have it.
    fs, ops = sizeless_fs
    ops.read_error = OSError(errno.EIO, "backend hiccup")
    fh = fs.open("/u.json", os.O_RDONLY)
    with pytest.raises(OSError):
        fs.read("/u.json", 100, 0, fh)
    fs.release("/u.json", fh)


@pytest.mark.asyncio
async def test_unknown_size_path_stat_uses_open_handle(sizeless_fs):
    fs, _ = sizeless_fs
    fs.open("/u.json", os.O_RDONLY)
    attrs = fs.getattr("/u.json")
    assert attrs["st_size"] == len(_PAYLOAD)


@pytest.mark.asyncio
async def test_open_then_read_does_not_refetch(sizeless_fs):
    fs, ops = sizeless_fs
    fh = fs.open("/u.json", os.O_RDONLY)
    assert fs.read("/u.json", 1024, 0, fh) == _PAYLOAD
    assert fs.read("/u.json", 7, 0, fh) == _PAYLOAD[:7]
    assert ops.read_calls == 1


@pytest.mark.asyncio
async def test_readlink_absolute_target_rewritten_relative(seed_ws):
    await seed_ws.shell("ln -s /sub/b.txt /lnk")
    fs = MirageFS(seed_ws.vfs)
    assert fs.readlink("/lnk") == "sub/b.txt"


@pytest.mark.asyncio
async def test_symlink_create_then_read(rw_ws):
    await rw_ws.shell("tee /f.txt", stdin=b"data")
    fs = MirageFS(rw_ws.vfs)
    fs.symlink("/lnk", "/f.txt")
    assert fs.readlink("/lnk") == "f.txt"
    assert fs.read("/lnk", 1024, 0, 0) == b"data"


@pytest.mark.asyncio
async def test_scoped_root_link_display(seed_ws):
    await seed_ws.shell("ln -s /sub/b.txt /sub/lnk")
    fs = MirageFS(seed_ws.vfs, root_prefix="/sub")
    assert fs.readlink("/lnk") == "b.txt"


@pytest.mark.asyncio
async def test_fstat_keeps_the_mode_and_mtime(seed_ws):
    await seed_ws.shell("chmod 600 /a.txt; touch -t 202603041200 /a.txt")
    fs = MirageFS(seed_ws.vfs)
    fh = fs.open("/a.txt", os.O_RDONLY)
    fs.read("/a.txt", 1024, 0, fh)
    attrs = fs.getattr("/a.txt", fh)
    stamp = datetime(2026, 3, 4, 12, 0, tzinfo=timezone.utc)
    assert stat.S_IMODE(attrs["st_mode"]) == 0o600
    assert attrs["st_mtime"] == int(stamp.timestamp()) * 10**9
    assert attrs["st_size"] == len(b"hello world")


@pytest.mark.asyncio
async def test_a_device_reports_our_row(seed_ws):
    attrs = MirageFS(seed_ws.vfs).getattr("/dev/null")
    assert stat.S_ISCHR(attrs["st_mode"])
    assert stat.S_IMODE(attrs["st_mode"]) == 0o666
    assert attrs["st_rdev"] == (1 << 8) | 3


@pytest.mark.asyncio
async def test_a_hidden_link_is_absent(seed_ws):
    await seed_ws.shell("ln -s /a.txt /lnk")
    session = seed_ws.create_session("agent")
    session.visibility = Visibility(paths=HiddenPaths(paths=("/lnk",)))
    fs = MirageFS(seed_ws.vfs, session=session)
    for call in (lambda: fs.getattr("/lnk"), lambda: fs.readlink("/lnk")):
        with pytest.raises(OSError) as exc:
            call()
        assert exc.value.errno == errno.ENOENT
    assert MirageFS(seed_ws.vfs).readlink("/lnk") == "a.txt"


@pytest.mark.asyncio
async def test_session_bound_fs_enforces_grants():
    """A MirageFS bound to a session runs every op under its grants:
    the granted mount answers, the ungranted one raises, exactly as a
    shell command in that session would."""
    ws = Workspace(
        {"/open": RAMVFS(), "/secret": RAMVFS()},
        mode=MountMode.WRITE,
    )
    await ws.shell("tee /open/ok.txt", stdin=b"visible")
    await ws.shell("tee /secret/no.txt", stdin=b"hidden")
    session = ws.create_session(
        "narrow", profile={"paths": {"hide": ["/secret"]}}
    )

    bound = MirageFS(ws.vfs, session=session)
    attrs = bound.getattr("/open/ok.txt")
    assert attrs["st_mode"] & stat.S_IFREG
    with pytest.raises(Exception) as excinfo:
        bound.getattr("/secret/no.txt")
    assert excinfo.value is not None

    unbound = MirageFS(ws.vfs)
    assert unbound.getattr("/secret/no.txt")["st_mode"] & stat.S_IFREG


@pytest.mark.asyncio
async def test_session_bound_fs_read_narrowing():
    """A session narrowed to read on a mount can read through its
    bound FUSE tree but not write."""
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("tee /data/f.txt", stdin=b"bytes")
    session = ws.create_session("ro", mounts={"/data": "read"})

    bound = MirageFS(ws.vfs, session=session)
    fh = bound.open("/data/f.txt", os.O_RDONLY)
    assert bound.read("/data/f.txt", 100, 0, fh) == b"bytes"
    bound.release("/data/f.txt", fh)
    with pytest.raises(Exception):
        bound.create("/data/new.txt", 0o644)
