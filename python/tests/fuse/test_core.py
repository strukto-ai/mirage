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

from mirage.fuse.core import MountCore
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
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
