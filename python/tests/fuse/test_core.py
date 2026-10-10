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
import errno
import logging
import os
import stat
import threading
import time

import pytest
import pytest_asyncio

from mirage.errors import FsCondition, posix_errno
from mirage.fuse.core import MountCore
from mirage.observe import OpRecord
from mirage.policy import Deny, Policy
from mirage.runtime.handles.constants import READ_CHUNK
from mirage.types import ContentType, FileStat, FileType, MountMode, PathSpec
from mirage.utils.stat_view import DIR_SIZE, mtime_ns
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import render


@pytest_asyncio.fixture
async def seeded():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("tee /a.txt", stdin=b"hello world")
    await ws.shell("mkdir /sub")
    await ws.shell("tee /sub/b.txt", stdin=b"nested")
    return MountCore(ws.vfs)


def test_core_needs_no_fuse_module():
    # The whole point of the split: MountCore imports nothing from mfusepy,
    # so the mount layer is exercisable without the [fuse] extra or a kernel.
    import mirage.fuse.core as core

    assert not hasattr(core, "fuse")
    assert "mfusepy" not in str(core.__dict__.keys())


@pytest.mark.asyncio
async def test_getattr_file(seeded):
    attrs = seeded.getattr("/a.txt")
    assert attrs["st_mode"] & stat.S_IFREG
    assert attrs["st_size"] == len(b"hello world")


@pytest.mark.asyncio
async def test_getattr_dir(seeded):
    attrs = seeded.getattr("/sub")
    assert attrs["st_mode"] & stat.S_IFDIR
    assert attrs["st_size"] == DIR_SIZE


@pytest.mark.asyncio
async def test_getattr_missing_raises_native_exception(seeded):
    # Native exception, not FuseOSError: an adapter classifies it, the core
    # does not know what a FUSE error code is.
    with pytest.raises((FileNotFoundError, ValueError)):
        seeded.getattr("/nope.txt")


@pytest.mark.asyncio
async def test_readdir_lists_children(seeded):
    entries = seeded.readdir("/")
    assert entries[:2] == [".", ".."]
    assert "a.txt" in entries
    assert "sub" in entries


@pytest.mark.asyncio
async def test_read_slices(seeded):
    assert seeded.read("/a.txt", 5, 0, None) == b"hello"
    assert seeded.read("/a.txt", 100, 6, None) == b"world"


@pytest.mark.asyncio
async def test_open_release_tracks_handles(seeded):
    fh = seeded.open("/a.txt")
    assert fh in seeded.handles
    seeded.release(fh)
    assert fh not in seeded.handles


@pytest.mark.asyncio
async def test_release_flushes_buffered_writes(seeded):
    # The macFUSE FSKit shim issues WRITE then RELEASE with no FLUSH in
    # between (the kext always flushes on close); dropping the buffer at
    # release silently lost data written through an fskit mount.
    fh = seeded.open("/a.txt")
    seeded.write("/a.txt", b"hello world, appended", 0, fh)
    seeded.release(fh)
    assert seeded.read("/a.txt", 100, 0, None) == b"hello world, appended"


@pytest.mark.asyncio
async def test_open_with_o_trunc_drops_the_old_body(seeded):
    # libfuse 3 negotiates atomic O_TRUNC, so the kernel never sends a
    # separate truncate before an O_TRUNC open; the flag on the open has
    # to do it. Ignoring it left `printf BB > f` holding BB plus the tail
    # of the longer body it replaced (#1032).
    fh = seeded.open("/a.txt", os.O_WRONLY | os.O_TRUNC)
    assert seeded.getattr("/a.txt", fh)["st_size"] == 0
    seeded.write("/a.txt", b"BB\n", 0, fh)
    seeded.release(fh)
    assert seeded.read("/a.txt", 100, 0, None) == b"BB\n"


@pytest.mark.asyncio
async def test_o_trunc_open_settles_writes_buffered_on_another_handle(seeded):
    # A write the kernel already acknowledged on handle A precedes the
    # O_TRUNC open on handle B, so it must land before the truncation,
    # not stay queued to overwrite B's body when A is released.
    first = seeded.open("/a.txt", os.O_WRONLY)
    seeded.write("/a.txt", b"QUEUED", 0, first)
    second = seeded.open("/a.txt", os.O_WRONLY | os.O_TRUNC)
    seeded.write("/a.txt", b"BB\n", 0, second)
    seeded.release(second)
    seeded.release(first)
    assert seeded.read("/a.txt", 100, 0, None) == b"BB\n"


@pytest.mark.asyncio
async def test_o_trunc_open_through_a_link_settles_the_targets_handle():
    # The dispatcher follows both paths to one file, so a handle opened on
    # the target and an O_TRUNC open through a link to it are the same
    # file: the queued write lands first and the truncation wins.
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("tee /a.txt", stdin=b"hello world")
    await ws.shell("ln -s a.txt /lk")
    core = MountCore(ws.vfs)
    first = core.open("/a.txt", os.O_WRONLY)
    core.write("/a.txt", b"QUEUED", 0, first)
    second = core.open("/lk", os.O_WRONLY | os.O_TRUNC)
    core.write("/lk", b"BB\n", 0, second)
    core.release(second)
    core.release(first)
    assert core.read("/a.txt", 100, 0, None) == b"BB\n"


@pytest.mark.asyncio
async def test_failed_settlement_keeps_the_other_handles_buffer():
    # When the settling flush is refused, the acknowledged bytes must stay
    # buffered on their handle so its own flush reports the refusal rather
    # than silently succeeding over an empty buffer.
    res = RAMVFS()
    seed = Workspace({"/": res}, mode=MountMode.WRITE)
    await seed.shell("tee /a.txt", stdin=b"seed")
    core = MountCore(Workspace({"/": res}, mode=MountMode.READ).vfs)
    first = core.open("/a.txt", os.O_WRONLY)
    core.write("/a.txt", b"QUEUED", 0, first)
    with pytest.raises(OSError):
        core.open("/a.txt", os.O_WRONLY | os.O_TRUNC)
    with pytest.raises(OSError):
        core.flush("/a.txt", first)
    assert await seed.vfs.read("/a.txt") == b"seed"


@pytest.mark.asyncio
async def test_open_without_o_trunc_keeps_the_body(seeded):
    fh = seeded.open("/a.txt", os.O_RDWR)
    seeded.write("/a.txt", b"J", 0, fh)
    seeded.release(fh)
    assert seeded.read("/a.txt", 100, 0, None) == b"Jello world"


class _NoTruncateRAM(RAMVFS):
    truncate = BaseVFS.truncate


@pytest.mark.asyncio
async def test_a_truncating_open_replaces_a_file_the_store_cannot_truncate():
    ws = Workspace({"/d": _NoTruncateRAM()}, mode=MountMode.WRITE)
    await ws.shell("echo hello > /d/f")
    core = MountCore(ws.vfs)
    fh = core.open("/d/f", os.O_WRONLY | os.O_TRUNC)
    core.write("/d/f", b"new", 0, fh)
    core.release(fh)
    assert await ws.vfs.read("/d/f") == b"new"
    core.truncate("/d/f", 1)
    assert await ws.vfs.read("/d/f") == b"n"


@pytest.mark.asyncio
async def test_a_handle_opened_through_a_link_stats_its_target(seeded):
    seeded._run(seeded.files.symlink("/lnk", "a.txt"))
    fh = seeded.open("/lnk", os.O_RDONLY)
    attrs = seeded.getattr("/lnk", fh)
    assert stat.S_ISREG(attrs["st_mode"])
    assert attrs["st_size"] == len(b"hello world")


@pytest.mark.asyncio
async def test_metadata_through_a_link_path_lands_on_the_link(seeded):
    seeded._run(seeded.files.symlink("/lnk", "a.txt"))
    seeded._run(seeded.files.symlink("/gone", "missing.txt"))
    seeded.setattr("/lnk", uid=1234)
    seeded.setattr("/gone", uid=4321)
    assert seeded.getattr("/lnk")["st_uid"] == 1234
    assert seeded.getattr("/gone")["st_uid"] == 4321
    assert seeded.getattr("/a.txt")["st_uid"] != 1234


@pytest.mark.asyncio
async def test_a_scoped_mount_root_shows_its_own_mode():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    core = MountCore(ws.vfs, root_prefix="/data")
    core.setattr("/", mode=0o700)
    assert stat.S_IMODE(core.getattr("/")["st_mode"]) == 0o700
    assert stat.S_ISDIR(MountCore(ws.vfs).getattr("/")["st_mode"])


@pytest.mark.asyncio
async def test_a_handle_reads_its_own_unflushed_writes(seeded):
    fh = seeded.open("/a.txt", os.O_RDWR)
    assert seeded.read("/a.txt", 100, 0, fh) == b"hello world"
    seeded.write("/a.txt", b"HELLO", 0, fh)
    seeded.write("/a.txt", b"!", 13, fh)
    assert seeded.read("/a.txt", 100, 0, fh) == b"HELLO world\x00\x00!"
    assert seeded.getattr("/a.txt", fh)["st_size"] == 14
    seeded.release(fh)
    assert seeded.read("/a.txt", 100, 0, None) == b"HELLO world\x00\x00!"


@pytest.mark.asyncio
async def test_write_then_read(seeded):
    seeded.write("/new.txt", b"written", 0, None)
    assert seeded.read("/new.txt", 100, 0, None) == b"written"


@pytest.mark.asyncio
async def test_readlink_on_non_link_raises_einval(seeded):
    with pytest.raises(OSError) as exc:
        seeded.readlink("/a.txt")
    assert exc.value.errno == errno.EINVAL


@pytest.mark.asyncio
async def test_getattr_of_a_link_reports_the_nodes_own_row():
    # A link has no backend inode, so the node table is the only place
    # its stamps live. Built from the target string alone, getattr
    # answered the mount's construction time for every link, so a
    # `touch -h` through the mount was invisible right after it landed.
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("tee /a.txt", stdin=b"hello")
    await ws.shell("ln -s a.txt /link")
    core = MountCore(ws.vfs)
    await ws.dispatch(
        "setattr",
        PathSpec.from_str_path("/link"),
        mode=None,
        uid=None,
        gid=None,
        atime=None,
        mtime="2020-01-02T03:04:05Z",
        nofollow=True,
    )
    attrs = core.getattr("/link")
    assert attrs["st_mode"] == stat.S_IFLNK | 0o777
    assert attrs["st_size"] == len("a.txt")
    assert attrs["st_mtime"] == mtime_ns(
        FileStat(
            name="link", type=FileType.SYMLINK, modified="2020-01-02T03:04:05Z"
        )
    )


@pytest.mark.asyncio
async def test_scoped_mount_may_not_touch_a_link_on_hidden_turf():
    # Both halves of one hole: a session-scoped kernel mount could
    # write the namespace table directly, at a layer no session view
    # covers. Creation was closed by routing through the dispatcher;
    # removal stayed open until unlink stopped calling the table too.
    # Both refuse as ENOENT: symlink is a create, and a create under a
    # hidden directory answers as every read of that directory does
    # (only a hidden name under a visible directory keeps EACCES),
    # while every other op on a hidden path is ENOENT under the
    # no-name-leak rule.
    ws = Workspace(
        {"/data/": RAMVFS(), "/extra/": RAMVFS()}, mode=MountMode.WRITE
    )
    await ws.shell("tee /data/greeting.txt", stdin=b"hello")
    await ws.shell("tee /extra/secret.txt", stdin=b"classified")
    await ws.shell("ln -s secret.txt /extra/lk")
    sess = ws.create_session("agent", profile={"paths": {"hide": ["/extra"]}})
    core = MountCore(ws.vfs, session=sess)

    with pytest.raises(OSError) as created:
        core.symlink("/extra/lk2", "/data/greeting.txt")
    assert created.value.errno == errno.ENOENT
    with pytest.raises(OSError) as removed:
        core.unlink("/extra/lk")
    assert removed.value.errno == errno.ENOENT
    assert ws.namespace.is_link("/extra/lk")


@pytest.mark.asyncio
async def test_unlink_removes_a_link_and_keeps_its_target():
    # The other side of routing removal through the dispatcher: an unscoped
    # mount still drops the link entry, and only that, the way
    # unlink(2) on a symlink leaves the pointee alone.
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("tee /f.txt", stdin=b"body")
    await ws.shell("ln -s f.txt /lk")
    core = MountCore(ws.vfs)
    core.unlink("/lk")
    assert not ws.namespace.is_link("/lk")
    assert (await ws.shell("cat /f.txt")).stdout == b"body"


@pytest.mark.asyncio
async def test_xattrs_round_trip(seeded):
    seeded.setxattr("/a.txt", "user.tag", b"v1")
    assert seeded.getxattr("/a.txt", "user.tag") == b"v1"
    assert "user.tag" in seeded.listxattr("/a.txt")
    seeded.removexattr("/a.txt", "user.tag")
    assert seeded.listxattr("/a.txt") == []


@pytest.mark.asyncio
async def test_getxattr_missing_raises_no_xattr(seeded):
    with pytest.raises(OSError) as exc:
        seeded.getxattr("/a.txt", "user.absent")
    assert exc.value.errno == posix_errno(FsCondition.NO_XATTR)


@pytest.mark.asyncio
async def test_resolve_honors_root_prefix():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    core = MountCore(ws.vfs, root_prefix="/data/")
    assert core.resolve("/") == "/data"
    assert core.resolve("/x.txt") == "/data/x.txt"


@pytest.mark.asyncio
async def test_rename_across_mounts_reports_exdev():
    # A whole-workspace mount spans several backends; the kernel probes
    # rename first and falls back to copy+unlink only on EXDEV, so the
    # facade's refusal is what keeps `mv` between two backends working.
    ws = Workspace(
        {"/data/": RAMVFS(), "/other/": RAMVFS()}, mode=MountMode.WRITE
    )
    core = MountCore(ws.vfs)
    core.write("/data/x.txt", b"body", 0, None)
    with pytest.raises(OSError) as exc:
        core.rename("/data/x.txt", "/other/x.txt")
    assert exc.value.errno == errno.EXDEV
    assert core.read("/data/x.txt", 100, 0, None) == b"body"


async def _read_tally(accessor, path: PathSpec, **kwargs) -> bytes:
    return b"RENDERED-AND-MUCH-LONGER"


class _Sizeless:
    def __init__(self, ops):
        self._inner = ops

    def __getattr__(self, name):
        return getattr(self._inner, name)

    async def stat(self, path, nofollow=False):
        s = await self._inner.stat(path, nofollow=nofollow)
        return s.model_copy(update={"size": None})


@pytest.mark.asyncio
async def test_o_trunc_open_hydrates_through_the_renderer():
    # An O_TRUNC open of a size-unknown file whose extension renders must
    # serve the rendered body of the now-empty file, not raw emptiness.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    render(ws.mount("/data/").vfs, ".tally", _read_tally)
    await ws.shell("tee /data/books.tally", stdin=b"0123456789")
    core = MountCore(_Sizeless(ws.vfs))
    fh = core.open("/data/books.tally", os.O_WRONLY | os.O_TRUNC)
    assert core._run(core._files.read("/data/books.tally", raw=True)) == b""
    rendered = b"RENDERED-AND-MUCH-LONGER"
    assert core.getattr("/data/books.tally", fh)["st_size"] == len(rendered)
    assert core.read("/data/books.tally", 100, 0, fh) == rendered
    core.release(fh)


def _tally_core() -> MountCore:
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    render(ws.mount("/data/").vfs, ".tally", _read_tally)
    return MountCore(ws.vfs)


@pytest.mark.asyncio
async def test_read_still_renders_after_a_partial_write():
    # A partial write lands in the stored bytes; a read still renders.
    core = _tally_core()
    core.write("/data/books.tally", b"0123456789", 0, None)
    core.write("/data/books.tally", b"XY", 4, None)
    body = core.read("/data/books.tally", 100, 0, None)
    assert body == b"RENDERED-AND-MUCH-LONGER"


class _NoReads(Policy):
    async def pre_vfs(self, ctx):
        return Deny("write-only") if ctx.op == "read" else None


@pytest.mark.asyncio
async def test_a_write_lands_on_a_file_the_session_may_not_read():
    # Writing at an offset is one write at the dispatcher, so a policy that
    # refuses reads leaves FUSE writes alone, as a write-only descriptor
    # takes pwrite(2). The flush used to read the file first and fail.
    vfs = RAMVFS()
    ws = Workspace({"/": vfs}, mode=MountMode.WRITE)
    await ws.shell("printf 'line1\\n' > /log")
    ws.policies.add(_NoReads())
    core = MountCore(ws.vfs)
    core.write("/log", b"more\n", 6, None)
    fh = core.open("/log", os.O_WRONLY)
    core.write("/log", b"a", 11, fh)
    core.write("/log", b"b\n", 12, fh)
    core.release(fh)
    assert vfs._store.files["/log"] == b"line1\nmore\nab\n"


class _SecondPwriteFails:
    def __init__(self, ops):
        self._inner = ops
        self.calls = 0

    def __getattr__(self, name):
        return getattr(self._inner, name)

    async def pwrite(self, path, data, offset):
        self.calls += 1
        if self.calls == 2:
            raise PermissionError(errno.EACCES, "denied", path)
        await self._inner.pwrite(path, data, offset)


@pytest.mark.asyncio
async def test_a_flush_that_fails_after_a_run_landed_still_refreshes():
    vfs = RAMVFS()
    ws = Workspace({"/": vfs}, mode=MountMode.WRITE)
    await ws.shell("printf abcdefgh > /f")
    core = MountCore(_SecondPwriteFails(ws.vfs))
    reader = core.open("/f", os.O_RDONLY)
    assert core.read("/f", 8, 0, reader) == b"abcdefgh"
    fh = core.open("/f", os.O_WRONLY)
    core.write("/f", b"X", 0, fh)
    core.write("/f", b"Y", 5, fh)
    with pytest.raises(PermissionError):
        core.flush("/f", fh)
    assert core.read("/f", 8, 0, reader) == b"Xbcdefgh"


@pytest.mark.asyncio
async def test_a_flush_retry_lands_only_the_runs_that_failed():
    vfs = RAMVFS()
    ws = Workspace({"/": vfs}, mode=MountMode.WRITE)
    await ws.shell("printf abcdefgh > /f")
    failing = _SecondPwriteFails(ws.vfs)
    core = MountCore(failing)
    fh = core.open("/f", os.O_WRONLY)
    core.write("/f", b"Y", 5, fh)
    core.write("/f", b"X", 0, fh)
    with pytest.raises(PermissionError):
        core.flush("/f", fh)
    await ws.vfs.pwrite("/f", b"W", 5)
    core.flush("/f", fh)
    assert vfs._store.files["/f"] == b"XbcdeWgh"
    assert failing.calls == 3


@pytest.mark.asyncio
async def test_a_failed_direct_write_keeps_its_errno():
    vfs = RAMVFS()
    ws = Workspace({"/": vfs}, mode=MountMode.WRITE)
    await ws.shell("printf abcdefgh > /f")
    core = MountCore(_SecondPwriteFails(ws.vfs))
    core.write("/f", b"X", 0, None)
    with pytest.raises(PermissionError) as raised:
        core.write("/f", b"Y", 5, None)
    assert raised.value.errno == errno.EACCES


@pytest.mark.asyncio
async def test_buffered_write_flush_lands_in_the_stored_bytes():
    # A mount that renders this extension must not get the rendering
    # written over the file on a partial write.
    core = _tally_core()
    core.write("/data/books.tally", b"0123456789", 0, None)
    fh = core.open("/data/books.tally")
    core.write("/data/books.tally", b"XY", 4, fh)
    core.release(fh)
    stored = core._run(core._files.read("/data/books.tally", raw=True))
    assert stored == b"0123XY6789"


@pytest.fixture
def new_york_clock():
    # Mirrors tests/utils/test_stat_view.py: a non-UTC host zone makes a
    # local-time parse of an offset-less stamp visibly wrong.
    if not hasattr(time, "tzset"):
        pytest.skip("tzset unavailable on this platform")
    previous = os.environ.get("TZ")
    os.environ["TZ"] = "America/New_York"
    time.tzset()
    yield
    if previous is None:
        os.environ.pop("TZ", None)
    else:
        os.environ["TZ"] = previous
    time.tzset()


@pytest.mark.asyncio
async def test_overlay_mtime_reads_offsetless_stamps_as_utc(
    seeded, new_york_clock
):
    # The R6 acceptance pin: the FUSE translator answers the same epoch
    # as mirage.utils.stat_view for an offset-less stamp. Only a
    # backend can produce one (the touch overlay always emits Z), so
    # this is latent until a backend like nextcloud reports naive
    # stamps; the pin is what keeps it latent.
    naive = FileStat(
        name="f",
        type=FileType.FILE,
        content=ContentType.TEXT,
        modified="2026-01-02T03:04:05",
    )
    aware = FileStat(
        name="f",
        type=FileType.FILE,
        content=ContentType.TEXT,
        modified="2026-01-02T03:04:05+00:00",
    )
    got_naive = seeded.attrs(naive)
    got_aware = seeded.attrs(aware)
    assert got_naive["st_mtime"] == got_aware["st_mtime"]
    assert got_naive["st_mtime"] == mtime_ns(naive)


@pytest.mark.asyncio
async def test_epoch_zero_mtime_lands_instead_of_reading_as_unknown(seeded):
    # 1970-01-01T00:00:00Z is a real answer, not a missing stamp: the
    # translator keys on None, so epoch zero replaces the mount's start
    # time instead of reading as unknown.
    epoch = FileStat(
        name="f",
        type=FileType.FILE,
        content=ContentType.TEXT,
        modified="1970-01-01T00:00:00Z",
    )
    got = seeded.attrs(epoch)
    assert got["st_mtime"] == 0
    assert got["st_ctime"] == 0


def test_drain_ops_omits_internal_mount_identity():
    ws = Workspace({"/data": RAMVFS()})
    record = OpRecord(
        op="read",
        path="/data/file",
        source="ram",
        bytes=3,
        timestamp=1,
        duration_ms=2,
        mount_id="internal-mount",
    )
    ws.vfs.records.append(record)
    core = MountCore(ws.vfs)
    assert core.drain_ops() == [record.to_dict()]
    assert core.drain_ops() == []


@pytest.mark.asyncio
async def test_ops_run_on_a_loop_the_caller_hands_in():
    # The daemon's SFTP adapter serves a workspace pinned to its runner
    # loop, so the core must run ops there instead of on a private loop.
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("tee /a.txt", stdin=b"on the given loop")
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        core = MountCore(ws.vfs, loop=loop)
        assert core._loop is loop
        data = await asyncio.to_thread(core.read, "/a.txt", 64, 0, None)
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join()
        loop.close()
    assert data == b"on the given loop"


@pytest.mark.asyncio
@pytest.mark.parametrize("directory", [False, True])
async def test_rename_keeps_open_handles_on_the_moved_file(seeded, directory):
    fh = seeded.open("/sub/b.txt")
    seeded.write("/sub/b.txt", b"BEFORE", 0, fh)
    seeded.rename("/sub" if directory else "/sub/b.txt", "/moved")
    seeded.write("/sub/b.txt", b"AFTER", 6, fh)
    seeded.release(fh)
    target = "/moved/b.txt" if directory else "/moved"
    assert seeded.read(target, 100, 0, None) == b"BEFOREAFTER"
    with pytest.raises(FileNotFoundError):
        seeded.getattr("/sub/b.txt")


@pytest.mark.asyncio
async def test_a_large_file_reads_a_chunk_at_a_time():
    # The kernel asks in small pieces; hydrating the whole file on the
    # first one moved all of it to answer a `head`.
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.vfs.write("/big.bin", b"\x01" * (3 * READ_CHUNK))
    core = MountCore(ws.vfs)
    fh = core.open("/big.bin")
    before = len(ws.vfs.records)
    assert core.read("/big.bin", 4096, 0, fh) == b"\x01" * 4096
    assert core.read("/big.bin", 4096, 4096, fh) == b"\x01" * 4096
    tail = core.read("/big.bin", 4096, 3 * READ_CHUNK - 2, fh)
    assert tail == b"\x01\x01"
    moved = [r.bytes for r in ws.vfs.records[before:] if r.op == "read"]
    assert moved == [READ_CHUNK, 2]
    core.release(fh)


@pytest.mark.asyncio
async def test_a_write_drops_the_chunk_an_open_handle_kept():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.vfs.write("/f.txt", b"old" * READ_CHUNK)
    core = MountCore(ws.vfs)
    reader = core.open("/f.txt")
    assert core.read("/f.txt", 3, 0, reader) == b"old"
    writer = core.open("/f.txt")
    core.write("/f.txt", b"new", 0, writer)
    core.release(writer)
    assert core.read("/f.txt", 3, 0, reader) == b"new"
    core.release(reader)


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["rename", "unlink"])
async def test_an_open_chunked_handle_outlives_a_rename_or_unlink(change):
    # POSIX keeps an open descriptor on its file: a rename moves it and an
    # unlink leaves its bytes readable, chunks it has not fetched included.
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    body = bytes(i % 251 for i in range(3 * READ_CHUNK))
    await ws.vfs.write("/big.bin", body)
    core = MountCore(ws.vfs)
    fh = core.open("/big.bin")
    assert core.read("/big.bin", 3, 0, fh) == body[:3]
    if change == "rename":
        core.rename("/big.bin", "/moved.bin")
    else:
        core.unlink("/big.bin")
    far = 2 * READ_CHUNK + 5
    assert core.read("/big.bin", 4, far, fh) == body[far : far + 4]
    core.release(fh)


@pytest.mark.asyncio
async def test_holding_reads_once_and_never_blocks_the_removal(monkeypatch):
    # One read serves every open handle; a read a policy refuses leaves
    # them chunked rather than refusing the unlink it allows.
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    for name in ("/a.bin", "/b.bin"):
        await ws.vfs.write(name, b"x" * (2 * READ_CHUNK))
    core = MountCore(ws.vfs)
    shared = [core.open("/a.bin") for _ in range(2)]
    for fh in shared:
        core.read("/a.bin", 1, 0, fh)
    before = len(ws.vfs.records)
    core.unlink("/a.bin")
    assert [r.op for r in ws.vfs.records[before:]].count("read") == 1
    refused = core.open("/b.bin")
    core.read("/b.bin", 1, 0, refused)

    async def refuse(*args, **kwargs):
        raise PermissionError(errno.EACCES, os.strerror(errno.EACCES))

    monkeypatch.setattr(ws.vfs, "read", refuse)
    core.unlink("/b.bin")
    monkeypatch.undo()
    with pytest.raises(FileNotFoundError):
        await ws.vfs.stat("/b.bin")


@pytest.mark.asyncio
async def test_removing_a_link_leaves_its_targets_handles_alone():
    # unlink(2) on a link takes the link entry, never the pointee's bytes,
    # so nothing is read to hold an open handle on the target.
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.vfs.write("/real.bin", b"x" * (2 * READ_CHUNK))
    await ws.shell("ln -s real.bin /alias")
    core = MountCore(ws.vfs)
    fh = core.open("/real.bin")
    core.read("/real.bin", 1, 0, fh)
    before = len(ws.vfs.records)
    core.unlink("/alias")
    assert "read" not in [r.op for r in ws.vfs.records[before:]]
    core.release(fh)


@pytest.mark.asyncio
async def test_a_session_is_told_the_command_rules_fuse_skips(
    caplog,
):
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    keys = {"reason": "keys", "paths": ["/data/*.key"]}
    ruled = ws.create_session(
        "agent",
        profile={
            "commands": {
                "deny": [{"reason": "no rm", "commands": ["rm"]}, keys]
            }
        },
    )
    with caplog.at_level(logging.WARNING, logger="mirage.fuse.core"):
        MountCore(ws.vfs, session=ruled)
    assert "commands.deny: no rm" in caplog.text
    assert "keys" not in caplog.text
    caplog.clear()
    pathed = ws.create_session(
        "pathed", profile={"commands": {"deny": [keys]}}
    )
    with caplog.at_level(logging.WARNING, logger="mirage.fuse.core"):
        MountCore(ws.vfs, session=pathed)
    assert caplog.text == ""


@pytest.mark.asyncio
async def test_generated_documents_refresh_even_on_an_open_handle():
    ws = Workspace({"/": RAMVFS(), "/secret": RAMVFS()}, mode=MountMode.WRITE)
    session = ws.create_session("reader")
    await ws.skill_md("/SKILL.md", session_id="reader")
    await ws.vfs_md("/VFS.md")
    core = MountCore(ws.vfs, session=session)
    skill = core.open("/SKILL.md")
    assert b"name: mirage" in core.read("/SKILL.md", 100000, 0, skill)
    core.release(skill)
    handle = core.open("/VFS.md")
    assert b"/secret" in core.read("/VFS.md", 100000, 0, handle)
    await ws.set_session_profile("reader", {"paths": {"hide": ["/secret"]}})
    changed = core.read("/VFS.md", 100000, 0, handle)
    assert b"/secret" not in changed
    assert changed == (await ws.vfs_md(session_id="reader")).encode()
    assert core.getattr("/VFS.md", handle)["st_size"] == len(changed)
    await ws.set_session_profile("reader", {"paths": {"hide": ["/VFS.md"]}})
    with pytest.raises(FileNotFoundError):
        core.read("/VFS.md", 100000, 0, handle)
    core.release(handle)
    await ws.close()
