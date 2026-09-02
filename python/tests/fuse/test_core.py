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
import time

import pytest
import pytest_asyncio

from mirage.fuse.core import PREFETCH_TTL, MountCore
from mirage.ops.registry import op
from mirage.resource.ram import RAMResource
from mirage.types import ContentType, FileStat, FileType, MountMode, PathSpec
from mirage.utils.clock import ManualClock
from mirage.utils.stat_view import mtime_ns
from mirage.workspace import Workspace


@pytest_asyncio.fixture
async def seeded():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("tee /a.txt", stdin=b"hello world")
    await ws.execute("mkdir /sub")
    await ws.execute("tee /sub/b.txt", stdin=b"nested")
    return MountCore(ws.fs)


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
    assert seeded.getattr("/sub")["st_mode"] & stat.S_IFDIR


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
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("tee /a.txt", stdin=b"hello")
    await ws.execute("ln -s a.txt /link")
    core = MountCore(ws.fs)
    await ws.dispatch("setattr",
                      PathSpec.from_str_path("/link"),
                      mode=None,
                      uid=None,
                      gid=None,
                      atime=None,
                      mtime="2020-01-02T03:04:05Z",
                      nofollow=True)
    attrs = core.getattr("/link")
    assert attrs["st_mode"] == stat.S_IFLNK | 0o777
    assert attrs["st_size"] == len("a.txt")
    assert attrs["st_mtime"] == mtime_ns(
        FileStat(name="link",
                 type=FileType.SYMLINK,
                 modified="2020-01-02T03:04:05Z"))


@pytest.mark.asyncio
async def test_scoped_mount_may_not_touch_a_link_on_hidden_turf():
    # Both halves of one hole: a session-scoped kernel mount could
    # write the namespace table directly, at a layer no session view
    # covers. Creation was closed by routing through the op door;
    # removal stayed open until unlink stopped calling the table too.
    # The two refusals differ by design: symlink is a create, which
    # answers EACCES because "does not exist" is nonsense as the answer
    # to a name the caller spelled out, while every other op on a
    # hidden path answers ENOENT under the no-name-leak rule.
    ws = Workspace({
        "/data/": RAMResource(),
        "/extra/": RAMResource()
    },
                   mode=MountMode.WRITE)
    await ws.execute("tee /data/greeting.txt", stdin=b"hello")
    await ws.execute("tee /extra/secret.txt", stdin=b"classified")
    await ws.execute("ln -s secret.txt /extra/lk")
    sess = ws.create_session("agent", profile={"paths": {"hide": ["/extra"]}})
    core = MountCore(ws.fs, session=sess)

    with pytest.raises(OSError) as created:
        core.symlink("/extra/lk2", "/data/greeting.txt")
    assert created.value.errno == errno.EACCES
    with pytest.raises(OSError) as removed:
        core.unlink("/extra/lk")
    assert removed.value.errno == errno.ENOENT
    assert ws.namespace.is_link("/extra/lk")


@pytest.mark.asyncio
async def test_unlink_removes_a_link_and_keeps_its_target():
    # The other side of routing removal through the door: an unscoped
    # mount still drops the link entry, and only that, the way
    # unlink(2) on a symlink leaves the pointee alone.
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("tee /f.txt", stdin=b"body")
    await ws.execute("ln -s f.txt /lk")
    core = MountCore(ws.fs)
    core.unlink("/lk")
    assert not ws.namespace.is_link("/lk")
    assert (await ws.execute("cat /f.txt")).stdout == b"body"


@pytest.mark.asyncio
async def test_xattrs_round_trip(seeded):
    seeded.setxattr("/a.txt", "user.tag", b"v1")
    assert seeded.getxattr("/a.txt", "user.tag") == b"v1"
    assert "user.tag" in seeded.listxattr("/a.txt")
    seeded.removexattr("/a.txt", "user.tag")
    assert seeded.listxattr("/a.txt") == []


@pytest.mark.asyncio
async def test_getxattr_missing_raises_no_xattr(seeded):
    from mirage.fuse.errors import NO_XATTR

    with pytest.raises(OSError) as exc:
        seeded.getxattr("/a.txt", "user.absent")
    assert exc.value.errno == NO_XATTR


@pytest.mark.asyncio
async def test_resolve_honors_root_prefix():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    core = MountCore(ws.fs, root_prefix="/data/")
    assert core.resolve("/") == "/data"
    assert core.resolve("/x.txt") == "/data/x.txt"


@pytest.mark.asyncio
async def test_rename_across_mounts_reports_exdev():
    # A whole-workspace mount spans several backends; the kernel probes
    # rename first and falls back to copy+unlink only on EXDEV, so the
    # facade's refusal is what keeps `mv` between two backends working.
    ws = Workspace({
        "/data/": RAMResource(),
        "/other/": RAMResource()
    },
                   mode=MountMode.WRITE)
    core = MountCore(ws.fs)
    core.write("/data/x.txt", b"body", 0, None)
    with pytest.raises(OSError) as exc:
        core.rename("/data/x.txt", "/other/x.txt")
    assert exc.value.errno == errno.EXDEV
    assert core.read("/data/x.txt", 100, 0, None) == b"body"


@op("read", resource="ram", filetype=".tally")
async def _read_tally(accessor, path: PathSpec, **kwargs) -> bytes:
    return b"RENDERED-AND-MUCH-LONGER"


def _tally_core() -> MountCore:
    resource = RAMResource()
    resource.register_op(_read_tally)
    ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
    return MountCore(ws.fs)


@pytest.mark.asyncio
async def test_partial_write_merges_against_stored_bytes():
    # Read-modify-write hands its merged buffer to `write`, which
    # stores, so the read that feeds it has to be the stored bytes. A
    # mount that renders this extension would otherwise have the
    # rendering written over the file on any partial write.
    core = _tally_core()
    core.write("/data/books.tally", b"0123456789", 0, None)
    core.write("/data/books.tally", b"XY", 4, None)
    stored = core._run(core._ops.read("/data/books.tally", raw=True))
    assert stored == b"0123XY6789"


@pytest.mark.asyncio
async def test_read_still_renders_after_a_partial_write():
    # The other half of the same rule: only the write path reads raw.
    core = _tally_core()
    core.write("/data/books.tally", b"0123456789", 0, None)
    core.write("/data/books.tally", b"XY", 4, None)
    body = core.read("/data/books.tally", 100, 0, None)
    assert body == b"RENDERED-AND-MUCH-LONGER"


@pytest.mark.asyncio
async def test_buffered_write_flush_merges_against_stored_bytes():
    core = _tally_core()
    core.write("/data/books.tally", b"0123456789", 0, None)
    fh = core.open("/data/books.tally")
    core.write("/data/books.tally", b"XY", 4, fh)
    core.release(fh)
    stored = core._run(core._ops.read("/data/books.tally", raw=True))
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
        seeded, new_york_clock):
    # The R6 acceptance pin: the FUSE translator answers the same epoch
    # as mirage.utils.stat_view for an offset-less stamp. Only a
    # backend can produce one (the touch overlay always emits Z), so
    # this is latent until a backend like nextcloud reports naive
    # stamps; the pin is what keeps it latent.
    naive = FileStat(name="f",
                     type=FileType.FILE,
                     content=ContentType.TEXT,
                     modified="2026-01-02T03:04:05")
    aware = FileStat(name="f",
                     type=FileType.FILE,
                     content=ContentType.TEXT,
                     modified="2026-01-02T03:04:05+00:00")
    entry = {"st_mode": 0o100644, "st_mtime": 0, "st_ctime": 0}
    got_naive = seeded._apply_stat_attrs(dict(entry), naive)
    got_aware = seeded._apply_stat_attrs(dict(entry), aware)
    assert got_naive["st_mtime"] == got_aware["st_mtime"]
    assert got_naive["st_mtime"] == mtime_ns(naive)


@pytest.mark.asyncio
async def test_epoch_zero_mtime_lands_instead_of_reading_as_unknown(seeded):
    # 1970-01-01T00:00:00Z is a real answer, not a missing stamp: the
    # fold keys on None, so epoch zero overwrites the construction-time
    # default instead of leaving it in place.
    epoch = FileStat(name="f",
                     type=FileType.FILE,
                     content=ContentType.TEXT,
                     modified="1970-01-01T00:00:00Z")
    entry = {"st_mode": 0o100644, "st_mtime": 12345, "st_ctime": 12345}
    got = seeded._apply_stat_attrs(dict(entry), epoch)
    assert got["st_mtime"] == 0
    assert got["st_ctime"] == 0


class SteppingClock:
    """A clock whose wall reading can jump while monotonic stands still.

    ManualClock moves both readings together, which is right for virtual
    time passing but cannot express the case a deadline has to survive:
    NTP stepping the system clock while no real time has elapsed.
    """

    def __init__(self) -> None:
        self.wall = 1_700_000_000.0
        self.mono = 0.0

    def now(self) -> float:
        return self.wall

    def monotonic(self) -> float:
        return self.mono


@pytest.mark.asyncio
async def test_prefetch_ttl_boundary_on_an_injected_clock():
    # The prefetch cache is a deadline in monotonic seconds, so an
    # injected clock is the only way to sit on the boundary exactly:
    # fresh one second before the TTL, gone the second it lands.
    clock = ManualClock()
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE, clock=clock)
    await ws.execute("tee /u.json", stdin=b"payload")
    core = MountCore(ws.fs)
    assert core.prefetch_read("/u.json") == b"payload"
    clock.advance(PREFETCH_TTL - 1)
    assert core.cached_data("/u.json") == b"payload"
    assert core.cached_size("/u.json") == len(b"payload")
    clock.advance(1)
    assert core.cached_data("/u.json") is None
    assert core.cached_size("/u.json") is None
    assert "/u.json" not in core._prefetch


@pytest.mark.asyncio
async def test_prefetch_deadline_ignores_a_wall_clock_jump():
    # The deadline is a duration, so it must be measured on the
    # monotonic reading. Reading wall clock instead would expire every
    # prefetched file the moment NTP stepped the system clock forward.
    clock = SteppingClock()
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE, clock=clock)
    await ws.execute("tee /u.json", stdin=b"payload")
    core = MountCore(ws.fs)
    assert core.prefetch_read("/u.json") == b"payload"
    clock.wall += 10 * 365 * 24 * 3600
    assert core.cached_data("/u.json") == b"payload"


@pytest.mark.asyncio
async def test_core_takes_the_workspace_clock_from_the_facade():
    clock = ManualClock()
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE, clock=clock)
    core = MountCore(ws.fs)
    assert core._clock is clock
