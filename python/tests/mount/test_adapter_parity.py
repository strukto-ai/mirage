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

import stat as stat_bits

import pytest

from mirage.mount.core import MountCore
from mirage.mount.errors import classify_error
from mirage.nfs.delegate import MirageNFS
from mirage.resource.ram import RAMResource
from mirage.types import FileStat, MountMode
from mirage.workspace import Workspace

HELLO = b"hello world"


class SizelessOps:
    """Ops proxy that strips stat sizes.

    Stands in for an API-backed resource whose byte length is unknown
    until the content is fetched, which is the one place the two
    adapters are allowed to answer differently.
    """

    def __init__(self, inner) -> None:
        self._inner = inner

    def __getattr__(self, name: str):
        return getattr(self._inner, name)

    async def stat(self, path: str) -> FileStat:
        result = await self._inner.stat(path)
        return result.model_copy(update={"size": None})


class Pair:
    """The two adapters over identical, independent workspaces.

    Two trees rather than one, because every case mutates the tree and
    the point is to ask both adapters the same question of the same
    starting state.

    Both sides are awaited on one loop: the core became async, so the
    private loop thread it used to drive its ops from is gone, and with
    it the reason this harness once needed two loops.

    Args:
        core (MountCore): the fuse tier's core, over its own tree.
        nfs (MirageNFS): the nfs adapter, over an identical tree.
    """

    def __init__(self, core: MountCore, nfs: MirageNFS) -> None:
        self.core = core
        self.nfs = nfs

    @classmethod
    async def make(cls, sizeless: bool = False) -> "Pair":
        """Build both adapters over identically seeded workspaces.

        Args:
            sizeless (bool): strip stat sizes, standing in for a backend
                that cannot size a file without fetching it.
        """
        trees = []
        for _ in range(2):
            ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
            await ws.execute("tee /a.txt", stdin=HELLO)
            await ws.execute("mkdir /sub")
            await ws.execute("tee /sub/b.txt", stdin=b"nested")
            trees.append(SizelessOps(ws.ops) if sizeless else ws.ops)
        return cls(MountCore(trees[0]), MirageNFS(trees[1]))

    async def nfs_id(self, *parts: str) -> int:
        """Resolve a path to a fileid the way a client walks it."""
        fileid = self.nfs.root_dir()
        for part in parts:
            fileid = await self.nfs.lookup(fileid, part)
        return fileid

    async def nfs_attrs(self, *parts: str) -> tuple[bool, bool, int]:
        """(is_dir, is_symlink, size) for a path, nfs side."""
        attrs = await self.nfs.getattr(await self.nfs_id(*parts))
        return attrs.is_dir, attrs.is_symlink, attrs.size

    async def fuse_attrs(self, path: str) -> tuple[bool, bool, int]:
        """(is_dir, is_symlink, size) for a path, fuse side."""
        entry = await self.core.getattr(path)
        mode = entry.mode
        return (bool(stat_bits.S_ISDIR(mode)), bool(stat_bits.S_ISLNK(mode)),
                entry.size)


async def errno_of(call) -> int:
    """The errno an adapter's failure classifies to.

    Both adapters raise ordinary exceptions and both are classified by
    the same table, which is what makes the comparison meaningful.

    Args:
        call: an awaitable expected to fail.

    Returns:
        int: the classified errno.
    """
    try:
        await call
    except Exception as exc:
        return classify_error(exc)
    raise AssertionError("expected the call to fail")


@pytest.mark.asyncio
async def test_file_attrs_agree():
    pair = await Pair.make()
    assert await pair.fuse_attrs("/a.txt") == await pair.nfs_attrs("a.txt")
    assert await pair.nfs_attrs("a.txt") == (False, False, len(HELLO))


@pytest.mark.asyncio
async def test_directory_attrs_agree():
    pair = await Pair.make()
    assert await pair.fuse_attrs("/sub") == await pair.nfs_attrs("sub")
    assert (await pair.nfs_attrs("sub"))[0] is True


@pytest.mark.asyncio
async def test_a_missing_path_classifies_to_the_same_errno():
    pair = await Pair.make()
    assert (await errno_of(pair.core.getattr("/nope.txt")) == await
            errno_of(pair.nfs_id("nope.txt")))


@pytest.mark.asyncio
async def test_readdir_names_agree():
    # The fuse core prepends "." and ".." because libfuse's readdir must
    # emit them; NFSv3 carries them in the reply header instead, so the
    # comparison is over real entries.
    pair = await Pair.make()
    fuse = [n for n in await pair.core.readdir("/") if n not in (".", "..")]
    nfs = sorted(e.name for e in await pair.nfs.readdir(pair.nfs.root_dir()))
    assert fuse == nfs


@pytest.mark.asyncio
async def test_whole_file_reads_agree():
    pair = await Pair.make()
    fuse = await pair.core.read("/a.txt", len(HELLO), 0, None)
    nfs = await pair.nfs.read(await pair.nfs_id("a.txt"), 0, len(HELLO))
    assert fuse == nfs == HELLO


@pytest.mark.asyncio
async def test_offset_reads_agree():
    pair = await Pair.make()
    fuse = await pair.core.read("/a.txt", 5, 6, None)
    nfs = await pair.nfs.read(await pair.nfs_id("a.txt"), 6, 5)
    assert fuse == nfs == b"world"


@pytest.mark.asyncio
async def test_a_write_is_readable_before_it_is_stored_on_both():
    # The adapters buffer differently -- fuse merges through a handle,
    # nfs holds a per-fileid buffer flushed on an idle timer -- and the
    # point of the nfs overlay is that a client cannot tell.
    pair = await Pair.make()
    await pair.core.write("/a.txt", b"HELLO", 0, None)
    fileid = await pair.nfs_id("a.txt")
    await pair.nfs.write(fileid, 0, b"HELLO")

    assert (await pair.core.read("/a.txt", len(HELLO), 0, None) == await
            pair.nfs.read(fileid, 0, len(HELLO)))
    assert await pair.fuse_attrs("/a.txt") == await pair.nfs_attrs("a.txt")


@pytest.mark.asyncio
async def test_a_write_past_the_end_grows_the_file_the_same_way():
    pair = await Pair.make()
    await pair.core.write("/a.txt", b"!", len(HELLO), None)
    fileid = await pair.nfs_id("a.txt")
    await pair.nfs.write(fileid, len(HELLO), b"!")
    assert ((await pair.fuse_attrs("/a.txt"))[2] ==
            (await pair.nfs_attrs("a.txt"))[2] == len(HELLO) + 1)


@pytest.mark.asyncio
async def test_symlink_and_readlink_agree():
    # MountCore names the link first (`symlink(link, target)`), the nfs
    # trait names the parent and the link's name; both store the target
    # verbatim.
    pair = await Pair.make()
    await pair.core.symlink("/lnk", "a.txt")
    await pair.nfs.symlink(pair.nfs.root_dir(), "lnk", "a.txt")

    assert (pair.core.readlink("/lnk") == await
            pair.nfs.readlink(await pair.nfs_id("lnk")))
    assert ((await pair.fuse_attrs("/lnk"))[1] ==
            (await pair.nfs_attrs("lnk"))[1] is True)


@pytest.mark.asyncio
async def test_mkdir_then_stat_agrees():
    pair = await Pair.make()
    await pair.core.mkdir("/fresh")
    await pair.nfs.mkdir(pair.nfs.root_dir(), "fresh")
    assert await pair.fuse_attrs("/fresh") == await pair.nfs_attrs("fresh")


@pytest.mark.asyncio
async def test_rename_agrees():
    pair = await Pair.make()
    await pair.core.rename("/a.txt", "/renamed.txt")
    root = pair.nfs.root_dir()
    await pair.nfs.rename(root, "a.txt", root, "renamed.txt")

    assert (await pair.fuse_attrs("/renamed.txt") == await
            pair.nfs_attrs("renamed.txt"))
    assert (await errno_of(pair.core.getattr("/a.txt")) == await
            errno_of(pair.nfs_id("a.txt")))


@pytest.mark.asyncio
async def test_unlink_agrees():
    pair = await Pair.make()
    await pair.core.unlink("/a.txt")
    await pair.nfs.remove(pair.nfs.root_dir(), "a.txt")
    assert (await errno_of(pair.core.getattr("/a.txt")) == await
            errno_of(pair.nfs_id("a.txt")))


@pytest.mark.asyncio
async def test_truncate_agrees():
    pair = await Pair.make()
    await pair.core.truncate("/a.txt", 5)
    await pair.nfs.set_size(await pair.nfs_id("a.txt"), 5)
    assert await pair.fuse_attrs("/a.txt") == await pair.nfs_attrs("a.txt")
    assert (await pair.core.read("/a.txt", 99, 0, None) == await pair.nfs.read(
        await pair.nfs_id("a.txt"), 0, 99) == HELLO[:5])


@pytest.mark.asyncio
async def test_a_size_unknown_file_stats_zero_on_both():
    # Neither adapter may invent a size it cannot know.
    pair = await Pair.make(sizeless=True)
    assert (await pair.fuse_attrs("/a.txt"))[2] == 0
    assert (await pair.nfs_attrs("a.txt"))[2] == 0


@pytest.mark.asyncio
async def test_size_unknown_bytes_agree_when_the_bytes_are_asked_for():
    # Both adapters answer a READ with the real content: neither one
    # truncates to the size it stated.
    pair = await Pair.make(sizeless=True)
    fh = await pair.core.open("/a.txt")
    fuse = await pair.core.read("/a.txt", len(HELLO), 0, fh)
    nfs = await pair.nfs.read(await pair.nfs_id("a.txt"), 0, len(HELLO))
    assert fuse == nfs == HELLO


@pytest.mark.asyncio
async def test_the_post_open_size_is_the_one_deliberate_divergence():
    # FUSE hydrates on OPEN, so the fstat that follows reports the real
    # length. NFSv3 has no OPEN to hang that on, so the size stays 0 and
    # the client stops there -- which is why the file reads empty through
    # a real mount although the adapter would have answered the bytes.
    pair = await Pair.make(sizeless=True)
    fh = await pair.core.open("/a.txt")
    assert (await pair.core.getattr("/a.txt", fh)).size == len(HELLO)
    assert (await pair.nfs_attrs("a.txt"))[2] == 0
