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
import time

import pytest
import pytest_asyncio

from mirage.errors import FsCondition, posix_errno
from mirage.mount.core import MountCore
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
    import mirage.mount.core as core

    assert not hasattr(core, "fuse")
    assert "mfusepy" not in str(core.__dict__.keys())


@pytest.mark.asyncio
async def test_getattr_file(seeded):
    attrs = await seeded.getattr("/a.txt")
    assert attrs.mode & stat.S_IFREG
    assert attrs.size == len(b"hello world")


@pytest.mark.asyncio
async def test_getattr_dir(seeded):
    attrs = await seeded.getattr("/sub")
    assert attrs.mode & stat.S_IFDIR
    assert attrs.size == DIR_SIZE


@pytest.mark.asyncio
async def test_getattr_missing_raises_native_exception(seeded):
    # Native exception, not FuseOSError: an adapter classifies it, the core
    # does not know what a FUSE error code is.
    with pytest.raises((FileNotFoundError, ValueError)):
        await seeded.getattr("/nope.txt")


@pytest.mark.asyncio
async def test_readdir_lists_children(seeded):
    entries = await seeded.readdir("/")
    assert entries[:2] == [".", ".."]
    assert "a.txt" in entries
    assert "sub" in entries


@pytest.mark.asyncio
async def test_read_slices(seeded):
    assert await seeded.read("/a.txt", 5, 0, None) == b"hello"
    assert await seeded.read("/a.txt", 100, 6, None) == b"world"


@pytest.mark.asyncio
async def test_open_release_tracks_handles(seeded):
    fh = await seeded.open("/a.txt")
    assert fh in seeded.handles
    await seeded.release(fh)
    assert fh not in seeded.handles


@pytest.mark.asyncio
async def test_release_flushes_buffered_writes(seeded):
    # The macFUSE FSKit shim issues WRITE then RELEASE with no FLUSH in
    # between (the kext always flushes on close); dropping the buffer at
    # release silently lost data written through an fskit mount.
    fh = await seeded.open("/a.txt")
    await seeded.write("/a.txt", b"hello world, appended", 0, fh)
    await seeded.release(fh)
    assert (
        await seeded.read("/a.txt", 100, 0, None) == b"hello world, appended"
    )


@pytest.mark.asyncio
async def test_open_with_o_trunc_drops_the_old_body(seeded):
    # libfuse 3 negotiates atomic O_TRUNC, so the kernel never sends a
    # separate truncate before an O_TRUNC open; the flag on the open has
    # to do it. Ignoring it left `printf BB > f` holding BB plus the tail
    # of the longer body it replaced (#1032).
    fh = await seeded.open("/a.txt", os.O_WRONLY | os.O_TRUNC)
    assert (await seeded.fgetattr("/a.txt", fh)).size == 0
    await seeded.write("/a.txt", b"BB\n", 0, fh)
    await seeded.release(fh)
    assert await seeded.read("/a.txt", 100, 0, None) == b"BB\n"


@pytest.mark.asyncio
async def test_o_trunc_open_settles_writes_buffered_on_another_handle(seeded):
    # A write the kernel already acknowledged on handle A precedes the
    # O_TRUNC open on handle B, so it must land before the truncation,
    # not stay queued to overwrite B's body when A is released.
    first = await seeded.open("/a.txt", os.O_WRONLY)
    await seeded.write("/a.txt", b"QUEUED", 0, first)
    second = await seeded.open("/a.txt", os.O_WRONLY | os.O_TRUNC)
    await seeded.write("/a.txt", b"BB\n", 0, second)
    await seeded.release(second)
    await seeded.release(first)
    assert await seeded.read("/a.txt", 100, 0, None) == b"BB\n"


@pytest.mark.asyncio
async def test_o_trunc_open_through_a_link_settles_the_targets_handle():
    # The dispatcher follows both paths to one file, so a handle opened on
    # the target and an O_TRUNC open through a link to it are the same
    # file: the queued write lands first and the truncation wins.
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("tee /a.txt", stdin=b"hello world")
    await ws.shell("ln -s a.txt /lk")
    core = MountCore(ws.vfs)
    first = await core.open("/a.txt", os.O_WRONLY)
    await core.write("/a.txt", b"QUEUED", 0, first)
    second = await core.open("/lk", os.O_WRONLY | os.O_TRUNC)
    await core.write("/lk", b"BB\n", 0, second)
    await core.release(second)
    await core.release(first)
    assert await core.read("/a.txt", 100, 0, None) == b"BB\n"


@pytest.mark.asyncio
async def test_failed_settlement_keeps_the_other_handles_buffer():
    # When the settling flush is refused, the acknowledged bytes must stay
    # buffered on their handle so its own flush reports the refusal rather
    # than silently succeeding over an empty buffer.
    res = RAMVFS()
    seed = Workspace({"/": res}, mode=MountMode.WRITE)
    await seed.shell("tee /a.txt", stdin=b"seed")
    core = MountCore(Workspace({"/": res}, mode=MountMode.READ).vfs)
    first = await core.open("/a.txt", os.O_WRONLY)
    await core.write("/a.txt", b"QUEUED", 0, first)
    with pytest.raises(OSError):
        await core.open("/a.txt", os.O_WRONLY | os.O_TRUNC)
    with pytest.raises(OSError):
        await core.flush("/a.txt", first)
    assert await seed.vfs.read("/a.txt") == b"seed"


@pytest.mark.asyncio
async def test_open_without_o_trunc_keeps_the_body(seeded):
    fh = await seeded.open("/a.txt", os.O_RDWR)
    await seeded.write("/a.txt", b"J", 0, fh)
    await seeded.release(fh)
    assert await seeded.read("/a.txt", 100, 0, None) == b"Jello world"


class _NoTruncateRAM(RAMVFS):
    truncate = BaseVFS.truncate


@pytest.mark.asyncio
async def test_a_truncating_open_replaces_a_file_the_store_cannot_truncate():
    ws = Workspace({"/d": _NoTruncateRAM()}, mode=MountMode.WRITE)
    await ws.shell("echo hello > /d/f")
    core = MountCore(ws.vfs)
    fh = await core.open("/d/f", os.O_WRONLY | os.O_TRUNC)
    await core.write("/d/f", b"new", 0, fh)
    await core.release(fh)
    assert await ws.vfs.read("/d/f") == b"new"
    await core.truncate("/d/f", 1)
    assert await ws.vfs.read("/d/f") == b"n"


@pytest.mark.asyncio
async def test_a_handle_opened_through_a_link_stats_its_target(seeded):
    await seeded.files.symlink("/lnk", "a.txt")
    fh = await seeded.open("/lnk", os.O_RDONLY)
    attrs = await seeded.fgetattr("/lnk", fh)
    assert stat.S_ISREG(attrs.mode)
    assert attrs.size == len(b"hello world")


@pytest.mark.asyncio
async def test_metadata_through_a_link_path_lands_on_the_link(seeded):
    await seeded.files.symlink("/lnk", "a.txt")
    await seeded.files.symlink("/gone", "missing.txt")
    await seeded.setattr("/lnk", uid=1234)
    await seeded.setattr("/gone", uid=4321)
    assert (await seeded.getattr("/lnk")).uid == 1234
    assert (await seeded.getattr("/gone")).uid == 4321
    assert (await seeded.getattr("/a.txt")).uid != 1234


@pytest.mark.asyncio
async def test_a_scoped_mount_root_shows_its_own_mode():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    core = MountCore(ws.vfs, root_prefix="/data")
    await core.setattr("/", mode=0o700)
    assert stat.S_IMODE((await core.getattr("/")).mode) == 0o700
    assert stat.S_ISDIR((await MountCore(ws.vfs).getattr("/")).mode)


@pytest.mark.asyncio
async def test_a_handle_reads_its_own_unflushed_writes(seeded):
    fh = await seeded.open("/a.txt", os.O_RDWR)
    assert await seeded.read("/a.txt", 100, 0, fh) == b"hello world"
    await seeded.write("/a.txt", b"HELLO", 0, fh)
    await seeded.write("/a.txt", b"!", 13, fh)
    assert await seeded.read("/a.txt", 100, 0, fh) == b"HELLO world\x00\x00!"
    assert (await seeded.fgetattr("/a.txt", fh)).size == 14
    await seeded.release(fh)
    assert await seeded.read("/a.txt", 100, 0, None) == b"HELLO world\x00\x00!"


@pytest.mark.asyncio
async def test_write_then_read(seeded):
    await seeded.write("/new.txt", b"written", 0, None)
    assert await seeded.read("/new.txt", 100, 0, None) == b"written"


@pytest.mark.asyncio
async def test_readlink_on_non_link_raises_einval(seeded):
    with pytest.raises(OSError) as exc:
        await seeded.readlink("/a.txt")
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
    attrs = await core.getattr("/link")
    assert attrs.mode == stat.S_IFLNK | 0o777
    assert attrs.size == len("a.txt")
    assert attrs.mtime == mtime_ns(
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
        await core.symlink("/extra/lk2", "/data/greeting.txt")
    assert created.value.errno == errno.ENOENT
    with pytest.raises(OSError) as removed:
        await core.unlink("/extra/lk")
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
    await core.unlink("/lk")
    assert not ws.namespace.is_link("/lk")
    assert (await ws.shell("cat /f.txt")).stdout == b"body"


@pytest.mark.asyncio
async def test_xattrs_round_trip(seeded):
    await seeded.setxattr("/a.txt", "user.tag", b"v1")
    assert await seeded.getxattr("/a.txt", "user.tag") == b"v1"
    assert "user.tag" in await seeded.listxattr("/a.txt")
    await seeded.removexattr("/a.txt", "user.tag")
    assert await seeded.listxattr("/a.txt") == []


@pytest.mark.asyncio
async def test_getxattr_missing_raises_no_xattr(seeded):
    with pytest.raises(OSError) as exc:
        await seeded.getxattr("/a.txt", "user.absent")
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
    await core.write("/data/x.txt", b"body", 0, None)
    with pytest.raises(OSError) as exc:
        await core.rename("/data/x.txt", "/other/x.txt")
    assert exc.value.errno == errno.EXDEV
    assert await core.read("/data/x.txt", 100, 0, None) == b"body"


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
    fh = await core.open("/data/books.tally", os.O_WRONLY | os.O_TRUNC)
    assert await core._files.read("/data/books.tally", raw=True) == b""
    rendered = b"RENDERED-AND-MUCH-LONGER"
    assert (await core.fgetattr("/data/books.tally", fh)).size == len(rendered)
    assert await core.read("/data/books.tally", 100, 0, fh) == rendered
    await core.release(fh)


def _tally_core() -> MountCore:
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    render(ws.mount("/data/").vfs, ".tally", _read_tally)
    return MountCore(ws.vfs)


@pytest.mark.asyncio
async def test_read_still_renders_after_a_partial_write():
    # A partial write lands in the stored bytes; a read still renders.
    core = _tally_core()
    await core.write("/data/books.tally", b"0123456789", 0, None)
    await core.write("/data/books.tally", b"XY", 4, None)
    body = await core.read("/data/books.tally", 100, 0, None)
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
    await core.write("/log", b"more\n", 6, None)
    fh = await core.open("/log", os.O_WRONLY)
    await core.write("/log", b"a", 11, fh)
    await core.write("/log", b"b\n", 12, fh)
    await core.release(fh)
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
    reader = await core.open("/f", os.O_RDONLY)
    assert await core.read("/f", 8, 0, reader) == b"abcdefgh"
    fh = await core.open("/f", os.O_WRONLY)
    await core.write("/f", b"X", 0, fh)
    await core.write("/f", b"Y", 5, fh)
    with pytest.raises(PermissionError):
        await core.flush("/f", fh)
    assert await core.read("/f", 8, 0, reader) == b"Xbcdefgh"


@pytest.mark.asyncio
async def test_a_flush_retry_lands_only_the_runs_that_failed():
    vfs = RAMVFS()
    ws = Workspace({"/": vfs}, mode=MountMode.WRITE)
    await ws.shell("printf abcdefgh > /f")
    failing = _SecondPwriteFails(ws.vfs)
    core = MountCore(failing)
    fh = await core.open("/f", os.O_WRONLY)
    await core.write("/f", b"Y", 5, fh)
    await core.write("/f", b"X", 0, fh)
    with pytest.raises(PermissionError):
        await core.flush("/f", fh)
    await ws.vfs.pwrite("/f", b"W", 5)
    await core.flush("/f", fh)
    assert vfs._store.files["/f"] == b"XbcdeWgh"
    assert failing.calls == 3


@pytest.mark.asyncio
async def test_a_failed_direct_write_keeps_its_errno():
    vfs = RAMVFS()
    ws = Workspace({"/": vfs}, mode=MountMode.WRITE)
    await ws.shell("printf abcdefgh > /f")
    core = MountCore(_SecondPwriteFails(ws.vfs))
    await core.write("/f", b"X", 0, None)
    with pytest.raises(PermissionError) as raised:
        await core.write("/f", b"Y", 5, None)
    assert raised.value.errno == errno.EACCES


@pytest.mark.asyncio
async def test_buffered_write_flush_lands_in_the_stored_bytes():
    # A mount that renders this extension must not get the rendering
    # written over the file on a partial write.
    core = _tally_core()
    await core.write("/data/books.tally", b"0123456789", 0, None)
    fh = await core.open("/data/books.tally")
    await core.write("/data/books.tally", b"XY", 4, fh)
    await core.release(fh)
    stored = await core._files.read("/data/books.tally", raw=True)
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
    assert got_naive.mtime == got_aware.mtime
    assert got_naive.mtime == mtime_ns(naive)


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
    assert got.mtime == 0
    assert got.ctime == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("directory", [False, True])
async def test_rename_keeps_open_handles_on_the_moved_file(seeded, directory):
    fh = await seeded.open("/sub/b.txt")
    await seeded.write("/sub/b.txt", b"BEFORE", 0, fh)
    await seeded.rename("/sub" if directory else "/sub/b.txt", "/moved")
    await seeded.write("/sub/b.txt", b"AFTER", 6, fh)
    await seeded.release(fh)
    target = "/moved/b.txt" if directory else "/moved"
    assert await seeded.read(target, 100, 0, None) == b"BEFOREAFTER"
    with pytest.raises(FileNotFoundError):
        await seeded.getattr("/sub/b.txt")


@pytest.mark.asyncio
async def test_a_large_file_reads_a_chunk_at_a_time():
    # The kernel asks in small pieces; hydrating the whole file on the
    # first one moved all of it to answer a `head`.
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.vfs.write("/big.bin", b"\x01" * (3 * READ_CHUNK))
    core = MountCore(ws.vfs)
    fh = await core.open("/big.bin")
    before = len(ws.vfs.records)
    assert await core.read("/big.bin", 4096, 0, fh) == b"\x01" * 4096
    assert await core.read("/big.bin", 4096, 4096, fh) == b"\x01" * 4096
    tail = await core.read("/big.bin", 4096, 3 * READ_CHUNK - 2, fh)
    assert tail == b"\x01\x01"
    moved = [r.bytes for r in ws.vfs.records[before:] if r.op == "read"]
    assert moved == [READ_CHUNK, 2]
    await core.release(fh)


@pytest.mark.asyncio
async def test_a_write_drops_the_chunk_an_open_handle_kept():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.vfs.write("/f.txt", b"old" * READ_CHUNK)
    core = MountCore(ws.vfs)
    reader = await core.open("/f.txt")
    assert await core.read("/f.txt", 3, 0, reader) == b"old"
    writer = await core.open("/f.txt")
    await core.write("/f.txt", b"new", 0, writer)
    await core.release(writer)
    assert await core.read("/f.txt", 3, 0, reader) == b"new"
    await core.release(reader)


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["rename", "unlink"])
async def test_an_open_chunked_handle_outlives_a_rename_or_unlink(change):
    # POSIX keeps an open descriptor on its file: a rename moves it and an
    # unlink leaves its bytes readable, chunks it has not fetched included.
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    body = bytes(i % 251 for i in range(3 * READ_CHUNK))
    await ws.vfs.write("/big.bin", body)
    core = MountCore(ws.vfs)
    fh = await core.open("/big.bin")
    assert await core.read("/big.bin", 3, 0, fh) == body[:3]
    if change == "rename":
        await core.rename("/big.bin", "/moved.bin")
    else:
        await core.unlink("/big.bin")
    far = 2 * READ_CHUNK + 5
    assert await core.read("/big.bin", 4, far, fh) == body[far : far + 4]
    await core.release(fh)


@pytest.mark.asyncio
async def test_holding_reads_once_and_never_blocks_the_removal(monkeypatch):
    # One read serves every open handle; a read a policy refuses leaves
    # them chunked rather than refusing the unlink it allows.
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    for name in ("/a.bin", "/b.bin"):
        await ws.vfs.write(name, b"x" * (2 * READ_CHUNK))
    core = MountCore(ws.vfs)
    shared = [await core.open("/a.bin") for _ in range(2)]
    for fh in shared:
        await core.read("/a.bin", 1, 0, fh)
    before = len(ws.vfs.records)
    await core.unlink("/a.bin")
    assert [r.op for r in ws.vfs.records[before:]].count("read") == 1
    refused = await core.open("/b.bin")
    await core.read("/b.bin", 1, 0, refused)

    async def refuse(*args, **kwargs):
        raise PermissionError(errno.EACCES, os.strerror(errno.EACCES))

    monkeypatch.setattr(ws.vfs, "read", refuse)
    await core.unlink("/b.bin")
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
    fh = await core.open("/real.bin")
    await core.read("/real.bin", 1, 0, fh)
    before = len(ws.vfs.records)
    await core.unlink("/alias")
    assert "read" not in [r.op for r in ws.vfs.records[before:]]
    await core.release(fh)


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
    with caplog.at_level(logging.WARNING, logger="mirage.mount.core"):
        MountCore(ws.vfs, session=ruled)
    assert "commands.deny: no rm" in caplog.text
    assert "keys" not in caplog.text
    caplog.clear()
    pathed = ws.create_session(
        "pathed", profile={"commands": {"deny": [keys]}}
    )
    with caplog.at_level(logging.WARNING, logger="mirage.mount.core"):
        MountCore(ws.vfs, session=pathed)
    assert caplog.text == ""


@pytest.mark.asyncio
async def test_generated_documents_refresh_even_on_an_open_handle():
    ws = Workspace({"/": RAMVFS(), "/secret": RAMVFS()}, mode=MountMode.WRITE)
    session = ws.create_session("reader")
    await ws.skill_md("/SKILL.md", session_id="reader")
    await ws.vfs_md("/VFS.md")
    core = MountCore(ws.vfs, session=session)
    skill = await core.open("/SKILL.md")
    assert b"name: mirage" in await core.read("/SKILL.md", 100000, 0, skill)
    await core.release(skill)
    handle = await core.open("/VFS.md")
    assert b"/secret" in await core.read("/VFS.md", 100000, 0, handle)
    await ws.set_session_profile("reader", {"paths": {"hide": ["/secret"]}})
    changed = await core.read("/VFS.md", 100000, 0, handle)
    assert b"/secret" not in changed
    assert changed == (await ws.vfs_md(session_id="reader")).encode()
    assert (await core.fgetattr("/VFS.md", handle)).size == len(changed)
    await ws.set_session_profile("reader", {"paths": {"hide": ["/VFS.md"]}})
    with pytest.raises(FileNotFoundError):
        await core.read("/VFS.md", 100000, 0, handle)
    await core.release(handle)
    await ws.close()


class _Held:
    """Files double whose first call of one op waits until let go: before
    it reaches the store, or with ``answered`` after, its answer in
    flight."""

    def __init__(self, ops, op, answered=False):
        self._inner = ops
        self._op = op
        self._answered = answered
        self.out = asyncio.Event()
        self.go = asyncio.Event()
        self.calls = 0

    def __getattr__(self, name):
        attr = getattr(self._inner, name)
        if name != self._op:
            return attr

        async def held(*args, **kwargs):
            self.calls += 1
            if self.calls > 1:
                return await attr(*args, **kwargs)
            if self._answered:
                answer = await attr(*args, **kwargs)
            self.out.set()
            await self.go.wait()
            return answer if self._answered else await attr(*args, **kwargs)

        return held


@pytest.mark.asyncio
async def test_a_hydration_out_across_a_truncate_reads_again():
    # The first open's read was out when the O_TRUNC open landed; what it
    # fetched is the old body, and installing it would let that handle
    # serve pre-truncation content.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.vfs.write("/data/api.json", b"hydrated bytes")
    files = _Held(_Sizeless(ws.vfs), "read", answered=True)
    core = MountCore(files)
    reading = asyncio.create_task(core.open("/data/api.json"))
    await files.out.wait()
    truncating = asyncio.create_task(
        core.open("/data/api.json", os.O_WRONLY | os.O_TRUNC)
    )
    while await ws.vfs.read("/data/api.json") != b"":
        await asyncio.sleep(0)
    files.go.set()
    writer = await truncating
    reader = await reading
    assert (await core.fgetattr("/data/api.json", reader)).size == 0
    await core.release(writer)
    await core.release(reader)


@pytest.mark.asyncio
async def test_an_o_trunc_open_waits_for_a_flush_still_landing():
    # Truncating while the flush's write is out would let the flush land
    # afterwards and put the old body back over the truncation.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo 'hello world' > /data/greeting.txt")
    files = _Held(ws.vfs, "pwrite")
    core = MountCore(files)
    first = await core.open("/data/greeting.txt", os.O_WRONLY)
    await core.write("/data/greeting.txt", b"QUEUED", 0, first)
    flushing = asyncio.create_task(core.flush("/data/greeting.txt", first))
    await files.out.wait()
    opening = asyncio.create_task(
        core.open("/data/greeting.txt", os.O_WRONLY | os.O_TRUNC)
    )
    await asyncio.sleep(0.01)
    files.go.set()
    await flushing
    second = await opening
    await core.write("/data/greeting.txt", b"BB\n", 0, second)
    await core.release(second)
    await core.release(first)
    assert await ws.vfs.read("/data/greeting.txt") == b"BB\n"


@pytest.mark.asyncio
async def test_a_read_sees_what_its_flush_still_landing_wrote():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo 'hello world' > /data/f")
    files = _Held(ws.vfs, "pwrite")
    core = MountCore(files)
    fh = await core.open("/data/f", os.O_RDWR)
    await core.read("/data/f", 100, 0, fh)
    await core.write("/data/f", b"HELLO", 0, fh)
    flushing = asyncio.create_task(core.flush("/data/f", fh))
    await files.out.wait()
    reading = asyncio.create_task(core.read("/data/f", 100, 0, fh))
    await asyncio.sleep(0.01)
    files.go.set()
    await flushing
    assert await reading == b"HELLO world\n"


@pytest.mark.asyncio
async def test_an_open_waits_out_the_removal_it_raced():
    # An open that arrives while an unlink holds the file waits for it,
    # as the kernel orders an open and an unlink of one name, and then
    # finds the file gone; the early descriptor keeps its bytes.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    body = bytes(i % 251 for i in range(3 * READ_CHUNK))
    await ws.vfs.write("/data/a.bin", body)
    core = MountCore(ws.vfs)
    early = await core.open("/data/a.bin")
    await core.read("/data/a.bin", 1, 0, early)
    real = ws.vfs.read
    late: list[asyncio.Task[int]] = []

    async def read(path, offset=0, size=None, **kwargs):
        if size is None and not late:
            late.append(asyncio.create_task(core.open("/data/a.bin")))
            await asyncio.sleep(0.01)
        return await real(path, offset, size, **kwargs)

    ws.vfs.read = read
    try:
        await core.unlink("/data/a.bin")
    finally:
        del ws.vfs.read
    assert len(late) == 1
    with pytest.raises(FileNotFoundError):
        await late[0]
    far = 2 * READ_CHUNK + 5
    assert await core.read("/data/a.bin", 4, far, early) == body[far : far + 4]


@pytest.mark.asyncio
async def test_setattr_stores_times_a_stat_reads_back(seeded):
    await seeded.setattr("/a.txt", atime=981173106_500_000_000, mtime=10**18)
    attrs = await seeded.getattr("/a.txt")
    assert (attrs.atime, attrs.mtime) == (981173106_500_000_000, 10**18)


@pytest.mark.asyncio
async def test_create_and_mkdir_store_a_mode_that_is_not_the_default(seeded):
    fh = await seeded.create("/secret", stat.S_IFREG | 0o600)
    await seeded.release(fh)
    await seeded.mkdir("/private", 0o700)
    await seeded.mkdir("/plain", 0o755)
    assert stat.S_IMODE((await seeded.getattr("/secret")).mode) == 0o600
    assert stat.S_IMODE((await seeded.getattr("/private")).mode) == 0o700
    assert stat.S_IMODE((await seeded.getattr("/plain")).mode) == 0o755


@pytest.mark.asyncio
async def test_times_set_on_an_open_file_outlast_its_buffered_writes(seeded):
    # cp -p writes the copy, sets its times on the file it still holds
    # open, then closes it: the writes precede the times in POSIX order.
    fh = await seeded.open("/a.txt", os.O_WRONLY)
    await seeded.write("/a.txt", b"copied", 0, fh)
    await seeded.setattr("/a.txt", mtime=10**18)
    await seeded.release(fh)
    assert (await seeded.getattr("/a.txt")).mtime == 10**18
    assert await seeded.read("/a.txt", 100, 0, None) == b"copiedworld"


@pytest.mark.asyncio
async def test_a_link_that_loops_can_still_be_renamed_and_removed():
    # unlink(2) and rename(2) act on the name, never on what it points at.
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    core = MountCore(ws.vfs)
    await core.symlink("/loop", "loop")
    await core.rename("/loop", "/spin")
    await core.symlink("/loop", "loop")
    await core.unlink("/loop")
    assert not ws.namespace.is_link("/loop")
    assert ws.namespace.is_link("/spin")


@pytest.mark.asyncio
async def test_an_unlinked_files_handle_stats_what_it_wrote(seeded):
    fh = await seeded.open("/a.txt", os.O_RDWR)
    await seeded.read("/a.txt", 100, 0, fh)
    await seeded.write("/a.txt", b"a longer replacement", 0, fh)
    await seeded.unlink("/a.txt")
    assert (await seeded.fgetattr("/a.txt", fh)).size == 20
    assert await seeded.read("/a.txt", 100, 0, fh) == b"a longer replacement"


@pytest.mark.asyncio
async def test_setattr_that_follows_changes_the_target_not_the_link(seeded):
    await seeded.symlink("/lnk", "a.txt")
    await seeded.setattr("/lnk", uid=1234, mtime=10**18, follow=True)
    target = await seeded.getattr("/a.txt")
    assert (target.uid, target.mtime) == (1234, 10**18)
    assert (await seeded.getattr("/lnk")).uid != 1234


@pytest.mark.asyncio
async def test_an_open_while_writes_land_before_a_truncate_breaks_nothing():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo 'hello world' > /data/f; echo other > /data/g")
    files = _Held(ws.vfs, "pwrite")
    core = MountCore(files)
    fh = await core.open("/data/f", os.O_WRONLY)
    await core.write("/data/f", b"HELLO", 0, fh)
    truncating = asyncio.create_task(core.truncate("/data/f", 5))
    await files.out.wait()
    other = await core.open("/data/g")
    files.go.set()
    await truncating
    assert await ws.vfs.read("/data/f") == b"HELLO"
    await core.release(other)
    await core.release(fh)


@pytest.mark.asyncio
async def test_cancelling_one_open_leaves_another_sharing_its_read():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.vfs.write("/data/api.json", b"hydrated bytes")
    files = _Held(_Sizeless(ws.vfs), "read")
    core = MountCore(files)
    first = asyncio.create_task(core.open("/data/api.json"))
    await files.out.wait()
    second = asyncio.create_task(core.open("/data/api.json"))
    for _ in range(10):
        await asyncio.sleep(0)
    first.cancel()
    files.go.set()
    fh = await second
    assert await core.read("/data/api.json", 100, 0, fh) == b"hydrated bytes"
    assert files.calls == 1


class _UmaskRAM(RAMVFS):
    """A store that makes entries the way a disk mount under umask 077 does."""

    async def stat(self, path, *args, **kwargs):
        row = await super().stat(path, *args, **kwargs)
        if row.mode is not None:
            return row
        mode = 0o700 if row.type == FileType.DIRECTORY else 0o600
        return row.model_copy(update={"mode": mode})


@pytest.mark.asyncio
async def test_a_create_keeps_its_mode_over_the_stores_own_umask():
    core = MountCore(Workspace({"/": _UmaskRAM()}, mode=MountMode.WRITE).vfs)
    fh = await core.create("/f", stat.S_IFREG | 0o644)
    await core.release(fh)
    await core.mkdir("/d", 0o755)
    assert stat.S_IMODE((await core.getattr("/f")).mode) == 0o644
    assert stat.S_IMODE((await core.getattr("/d")).mode) == 0o755


class _NoStats(Policy):
    async def pre_vfs(self, ctx):
        return Deny("no stat") if ctx.op == "stat" else None


@pytest.mark.asyncio
async def test_a_create_a_policy_refuses_to_stat_still_lands():
    # The entry exists once the create returns: failing it then would make
    # a retry find it there.
    vfs = RAMVFS()
    ws = Workspace({"/": vfs}, mode=MountMode.WRITE)
    ws.policies.add(_NoStats())
    core = MountCore(ws.vfs)
    await core.mkdir("/d", 0o700)
    await core.release(await core.create("/f", stat.S_IFREG | 0o600))
    assert "/d" in vfs._store.dirs
    assert "/f" in vfs._store.files


@pytest.mark.asyncio
async def test_an_open_through_a_link_waits_out_the_links_removal():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo body > /a.txt; ln -s a.txt /lk")
    files = _Held(ws.vfs, "unlink")
    core = MountCore(files)
    removing = asyncio.create_task(core.unlink("/lk"))
    await files.out.wait()
    opening = asyncio.create_task(core.open("/lk"))
    await asyncio.sleep(0.01)
    assert not opening.done()
    files.go.set()
    await removing
    with pytest.raises(FileNotFoundError):
        await opening
