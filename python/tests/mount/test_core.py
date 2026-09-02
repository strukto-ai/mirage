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
import stat

import pytest
import pytest_asyncio

from mirage.mount.core import MountCore
from mirage.ops.registry import op
from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.utils.dates import iso_timestamp
from mirage.workspace import Workspace


@pytest_asyncio.fixture
async def seeded():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("tee /a.txt", stdin=b"hello world")
    await ws.execute("mkdir /sub")
    await ws.execute("tee /sub/b.txt", stdin=b"nested")
    return MountCore(ws.ops)


@pytest.mark.asyncio
async def test_core_needs_no_fuse_module():
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
    assert (await seeded.getattr("/sub")).mode & stat.S_IFDIR


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
    assert await seeded.read("/a.txt", 100, 0,
                             None) == b"hello world, appended"


@pytest.mark.asyncio
async def test_write_then_read(seeded):
    await seeded.write("/new.txt", b"written", 0, None)
    assert await seeded.read("/new.txt", 100, 0, None) == b"written"


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
    core = MountCore(ws.ops)
    await ws.dispatch("setattr",
                      PathSpec.from_str_path("/link"),
                      mode=None,
                      uid=None,
                      gid=None,
                      atime=None,
                      mtime="2020-01-02T03:04:05Z",
                      nofollow=True)
    attrs = await core.getattr("/link")
    assert attrs.mode == stat.S_IFLNK | 0o777
    assert attrs.size == len("a.txt")
    assert attrs.mtime == iso_timestamp("2020-01-02T03:04:05Z")


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
    core = MountCore(ws.ops, session=sess)

    with pytest.raises(OSError) as created:
        await core.symlink("/extra/lk2", "/data/greeting.txt")
    assert created.value.errno == errno.EACCES
    with pytest.raises(OSError) as removed:
        await core.unlink("/extra/lk")
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
    core = MountCore(ws.ops)
    await core.unlink("/lk")
    assert not ws.namespace.is_link("/lk")
    assert (await ws.execute("cat /f.txt")).stdout == b"body"


@pytest.mark.asyncio
async def test_xattrs_round_trip(seeded):
    await seeded.setxattr("/a.txt", "user.tag", b"v1")
    assert await seeded.getxattr("/a.txt", "user.tag") == b"v1"
    assert "user.tag" in await seeded.listxattr("/a.txt")
    await seeded.removexattr("/a.txt", "user.tag")
    assert await seeded.listxattr("/a.txt") == []


@pytest.mark.asyncio
async def test_getxattr_missing_raises_no_xattr(seeded):
    from mirage.mount.errors import NO_XATTR

    with pytest.raises(OSError) as exc:
        await seeded.getxattr("/a.txt", "user.absent")
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
    await core.write("/data/x.txt", b"body", 0, None)
    with pytest.raises(OSError) as exc:
        await core.rename("/data/x.txt", "/other/x.txt")
    assert exc.value.errno == errno.EXDEV
    assert await core.read("/data/x.txt", 100, 0, None) == b"body"


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
    await core.write("/data/books.tally", b"0123456789", 0, None)
    await core.write("/data/books.tally", b"XY", 4, None)
    stored = await core._ops.read("/data/books.tally", raw=True)
    assert stored == b"0123XY6789"


@pytest.mark.asyncio
async def test_read_still_renders_after_a_partial_write():
    # The other half of the same rule: only the write path reads raw.
    core = _tally_core()
    await core.write("/data/books.tally", b"0123456789", 0, None)
    await core.write("/data/books.tally", b"XY", 4, None)
    body = await core.read("/data/books.tally", 100, 0, None)
    assert body == b"RENDERED-AND-MUCH-LONGER"


@pytest.mark.asyncio
async def test_buffered_write_flush_merges_against_stored_bytes():
    core = _tally_core()
    await core.write("/data/books.tally", b"0123456789", 0, None)
    fh = await core.open("/data/books.tally")
    await core.write("/data/books.tally", b"XY", 4, fh)
    await core.release(fh)
    stored = await core._ops.read("/data/books.tally", raw=True)
    assert stored == b"0123XY6789"


@pytest.mark.asyncio
async def test_every_mutation_drops_the_prefetched_bytes(seeded):
    # Size-unknown backends are read through the prefetch cache, and a
    # mutation that left the entry in place would make the next read
    # answer pre-write bytes for the rest of the TTL. The TS twin pins
    # the same four points (it only invalidated on unlink until now).
    path = "/a.txt"
    mutations = [
        ("write", lambda: seeded.write(path, b"x", 0, None)),
        ("truncate", lambda: seeded.truncate(path, 4)),
        ("create", lambda: seeded.create(path)),
        ("rename", lambda: seeded.rename(path, path)),
    ]
    for name, mutate in mutations:
        await seeded.prefetch_read(path)
        assert seeded.cached_data(path) is not None, f"{name}: nothing cached"

        await mutate()

        assert seeded.cached_data(path) is None, f"{name} served a stale read"
