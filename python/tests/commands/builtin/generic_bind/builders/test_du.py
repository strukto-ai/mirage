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
from typing import Any

import pytest

from mirage.commands.builtin.generic_bind import generic
from mirage.commands.config import Context
from mirage.context import reset_mount_gate, set_mount_gate
from mirage.errors.fs import enotsup, walk_declined
from mirage.errors.types import OperationNotSupportedError
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.types import DirListing, FileStat, FileType, MountMode, PathSpec
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.files import Files
from mirage.workspace.types import MountRow
from tests.fixtures.readers import readers

TREE = {
    "/db": ["/db/a.txt", "/db/sub"],
    "/db/sub": ["/db/sub/b.txt"],
}
SIZES = {"/db/a.txt": 3, "/db/sub/b.txt": 2}
STOPPED_AT_2 = "du: /db: stopped after 2 files (walk_limit); narrow the path\n"


async def _readdir(path: PathSpec) -> list[str]:
    return TREE.get(path.virtual.rstrip("/") or "/", [])


async def _stat(path: PathSpec) -> FileStat:
    virtual = path.virtual
    if virtual in TREE:
        return FileStat(name=virtual, type=FileType.DIRECTORY)
    if virtual in SIZES:
        return FileStat(type=FileType.FILE, name=virtual, size=SIZES[virtual])
    raise FileNotFoundError(virtual)


class _Mount:
    """The dispatcher a du on one mount reads through: its listings, its
    stats and, where the mount has one, its one-call tree read.

    Args:
        readdir (Any): ``readdir(path)``.
        stat (Any): ``stat(path)``, a link's own row.
        read_tree (Any): ``read_tree(path)``, or None for none.
        walk_limit (int): the mount's limit, -1 for none.
        followed (Any): ``stat(path)`` with links followed, for the
            namespace's own probes.
    """

    def __init__(
        self,
        readdir: Any = _readdir,
        stat: Any = _stat,
        read_tree: Any = None,
        walk_limit: int = -1,
        followed: Any = None,
    ) -> None:
        self.readdir = readdir
        self.stat = stat
        self.read_tree = read_tree
        self.followed = followed
        self.row = MountRow(
            prefix="/",
            resource_type="ram",
            mode=MountMode.WRITE,
            walk_limit=walk_limit,
            calls=frozenset({"read_tree"} if read_tree is not None else ()),
        )

    async def __call__(
        self, name: str, path: PathSpec, /, **kwargs: Any
    ) -> tuple[Any, IOResult]:
        if name == "stat" and not kwargs.get("nofollow"):
            if self.followed is not None:
                return await self.followed(path), IOResult()
        if name == "stat":
            return await self.stat(path), IOResult()
        if name == "readdir":
            return await self.readdir(path), IOResult()
        if name == "read_tree":
            return await self.read_tree(path), IOResult()
        raise AssertionError(name)


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path=virtual.lstrip("/")
    )


async def _du(
    mount: _Mount, paths: list[str], links: Any = None, **flags: Any
) -> tuple[str, int, str]:
    ctx = Context(
        flags={**flags},
        vfs=Files(mount, readers([mount.row], links), ledger=False),
    )
    token = set_mount_gate("/", MountMode.WRITE)
    try:
        stream, io = await generic("du").fn(
            None, [_spec(p) for p in paths], [], ctx
        )
    finally:
        reset_mount_gate(token)
    return (
        (await materialize(stream)).decode(),
        io.exit_code,
        (io.stderr or b"").decode(),
    )


def _tree(refusal: Any = None) -> Any:
    async def read_tree(path: PathSpec) -> dict[str, FileStat]:
        if refusal is not None:
            raise refusal("ram", "read_tree", path)
        return {
            "a.txt": FileStat(name="a.txt", type=FileType.FILE, size=3),
            "sub": FileStat(name="sub", type=FileType.DIRECTORY),
            "sub/b.txt": FileStat(name="b.txt", type=FileType.FILE, size=2),
        }

    return read_tree


@pytest.mark.asyncio
async def test_walks_when_the_dispatcher_declines_read_tree():
    out, code, _ = await _du(_Mount(read_tree=_tree(walk_declined)), ["/db"])
    assert (out, code) == ("2\t/db/sub\n5\t/db\n", 0)


@pytest.mark.asyncio
async def test_a_backends_own_refusal_is_not_walked():
    with pytest.raises(OperationNotSupportedError):
        await _du(_Mount(read_tree=_tree(enotsup)), ["/db"])


@pytest.mark.asyncio
async def test_a_tree_answer_counts_against_the_limit():
    """A tree read in one call is still a walk of every entry in it."""
    mount = _Mount(read_tree=_tree(), walk_limit=2)
    out, code, err = await _du(mount, ["/db"])
    assert (out, code, err) == ("0\t/db/sub\n3\t/db\n", 1, STOPPED_AT_2)


async def _root_stat(path: PathSpec) -> FileStat:
    if path.virtual == "/":
        return FileStat(name="/", type=FileType.DIRECTORY)
    return await _stat(path)


@pytest.mark.asyncio
async def test_a_walk_of_the_root_names_the_root_where_it_stops():
    mount = _Mount(stat=_root_stat, read_tree=_tree(), walk_limit=2)
    out, code, err = await _du(mount, ["/"])
    assert (out, code) == ("0\t/sub\n3\t/\n", 1)
    assert err == STOPPED_AT_2.replace("/db:", "/:")


@pytest.mark.asyncio
async def test_a_walk_past_the_limit_reports_partial_output_and_exits_one():
    """A tree bigger than the limit must not report a wrong size silently."""
    out, code, err = await _du(_Mount(walk_limit=2), ["/db"])
    assert (out, code, err) == ("0\t/db/sub\n3\t/db\n", 1, STOPPED_AT_2)


@pytest.mark.asyncio
async def test_each_operand_walks_under_its_own_limit():
    out, code, err = await _du(_Mount(walk_limit=2), ["/db", "/db/sub"])
    assert (out, code, err) == (
        "0\t/db/sub\n3\t/db\n2\t/db/sub\n",
        1,
        STOPPED_AT_2,
    )


_SEALED_TREE = {
    "/db": ["/db/a.txt", "/db/empty", "/db/sealed", "/db/walled"],
    "/db/empty": [],
    "/db/sealed": [],
}


async def _sealed_readdir(path: PathSpec) -> list[str]:
    # /db/sealed lists as refused and /db/walled refuses its stat, the two
    # calls a rule or the host can shut.
    if path.virtual == "/db/sealed":
        raise PermissionError(13, "Permission denied", path.virtual)
    return _SEALED_TREE.get(path.virtual, [])


async def _sealed_stat(path: PathSpec) -> FileStat:
    if path.virtual == "/db/walled":
        raise PermissionError(13, "Permission denied", path.virtual)
    if path.virtual in _SEALED_TREE:
        return FileStat(name=path.virtual, type=FileType.DIRECTORY)
    if path.virtual == "/db/a.txt":
        return FileStat(name=path.virtual, type=FileType.FILE, size=3)
    raise FileNotFoundError(path.virtual)


@pytest.mark.asyncio
async def test_a_directory_no_file_points_at_still_gets_its_row():
    # GNU prints a row for an empty directory and for one it cannot open
    # (0 under -ab); a refused stat names the path but proves no directory.
    notes = (
        "du: cannot read directory '/db/sealed': Permission denied\n"
        "du: cannot read directory '/db/walled': Permission denied\n"
    )
    rows = "0\t/db/empty\n0\t/db/sealed\n3\t/db\n"
    sealed = _Mount(readdir=_sealed_readdir, stat=_sealed_stat)
    assert await _du(sealed, ["/db"]) == (rows, 1, notes)
    everything = "3\t/db/a.txt\n" + rows
    assert await _du(sealed, ["/db"], a=True) == (everything, 1, notes)


LINKED = FileStat(name="f", type=FileType.FILE, size=6)


# /db/private refuses its listing, though its file answers a stat by name,
# the way a directory without read permission does.
async def _unlisted_readdir(path: PathSpec) -> list[str]:
    if path.virtual == "/db/private":
        raise PermissionError(errno.EACCES, "Permission denied")
    return ["/db/link", "/db/private"] if path.virtual == "/db" else []


async def _unlisted_stat(path: PathSpec) -> FileStat:
    if path.virtual == "/db/link":
        return FileStat(name="link", type=FileType.SYMLINK, size=9)
    return FileStat(name=path.virtual, type=FileType.DIRECTORY)


class _OneLink:
    """A link table holding /db/link, which leads to /db/private/f."""

    def follow(self, path: str) -> str:
        return "/db/private/f" if path == "/db/link" else path

    def link_stat_at(self, path: str) -> None:
        return None

    def link_stats_below(self, directory: str) -> list:
        return []

    def symlink_targets(self) -> dict[str, str]:
        return {}


async def _linked(path: PathSpec) -> FileStat:
    if path.virtual == "/db/private/f":
        return LINKED
    if path.virtual == "/db":
        return FileStat(name="db", type=FileType.DIRECTORY)
    raise FileNotFoundError(path.virtual)


@pytest.mark.asyncio
async def test_du_L_counts_a_link_whose_file_only_it_reaches():
    # A link into the operand's tree is left to the file's own name, but
    # a directory the walk may not list hides that name, and GNU then
    # counts the file under the link (coreutils 9.7).
    mount = _Mount(
        readdir=_unlisted_readdir, stat=_unlisted_stat, followed=_linked
    )
    out, code, err = await _du(mount, ["/db"], _OneLink(), a=True, L=True)
    assert out == "6\t/db/link\n0\t/db/private\n6\t/db\n"
    assert (code, err) == (
        1,
        "du: cannot read directory '/db/private': Permission denied\n",
    )


class CutRAM(RAMVFS):
    """A RAM mount held to two files, with no tree read, whose listing
    stops at a walk's ``limit``."""

    read_tree = BaseVFS.read_tree
    walk_limit = 2

    async def readdir(self, path, limit=None):
        rows = list(await super().readdir(path))
        if limit is None or len(rows) < limit:
            return rows
        return DirListing(rows[:limit], partial=True)


@pytest.mark.asyncio
async def test_du_x_counts_a_file_listed_past_the_mounts_below():
    vfs = CutRAM()
    vfs._store.dirs.update({"/d", "/d/m1", "/d/m2", "/d/m3"})
    vfs._store.files["/d/z"] = b"zz"
    mounts = {"/ram/": vfs} | {f"/ram/d/m{i}/": RAMVFS() for i in (1, 2, 3)}
    with Workspace(mounts) as ws:
        out = await ws.shell("du -x -a /ram/d")
        assert await out.stdout_str() == "2\t/ram/d/z\n2\t/ram/d\n"
