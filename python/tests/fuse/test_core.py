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

from mirage.fuse.core import MountCore
from mirage.ops.registry import op
from mirage.resource.ram import RAMResource
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.utils.stat_view import mtime_ns
from mirage.workspace import Workspace


@pytest_asyncio.fixture
async def seeded():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("tee /a.txt", stdin=b"hello world")
    await ws.execute("mkdir /sub")
    await ws.execute("tee /sub/b.txt", stdin=b"nested")
    return MountCore(ws.ops)


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
    core = MountCore(ws.ops, root_prefix="/data/")
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
    core = MountCore(ws.ops)
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
    return MountCore(ws.ops)


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
                     type=FileType.TEXT,
                     modified="2026-01-02T03:04:05")
    aware = FileStat(name="f",
                     type=FileType.TEXT,
                     modified="2026-01-02T03:04:05+00:00")
    entry = {"st_mode": 0o100644, "st_mtime": 0, "st_ctime": 0}
    got_naive = seeded._apply_stat_attrs(dict(entry), naive)
    got_aware = seeded._apply_stat_attrs(dict(entry), aware)
    assert got_naive["st_mtime"] == got_aware["st_mtime"]
    assert got_naive["st_mtime"] == mtime_ns(naive)
