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

import pytest

from mirage.mount.types import SetAttrs
from mirage.nfs.config import NFSConfig
from mirage.nfs.delegate import MirageNFS
from mirage.nfs.errors import StaleHandleError
from mirage.types import FileStat, FileType


class FakeLinks:
    """The NamespaceLinks slice MirageNFS consumes.

    Args:
        table (dict[str, str]): link path -> stored target, verbatim.
    """

    def __init__(self, table: dict[str, str]) -> None:
        self._table = table

    def is_link(self, path: str) -> bool:
        return path in self._table

    def readlink(self, path: str) -> str | None:
        return self._table.get(path)

    async def unlink(self, path: str) -> None:
        """Remove a link entry, the way the door special-cases one."""
        self._table.pop(path, None)

    def link_stat_at(self, path: str) -> FileStat | None:
        """The node row for a link, or None when the table has no
        overlay for it.

        Present because the real facade has it and the mount core asks:
        a fake that carries only what one adapter happened to call is
        how an adapter that starts sharing the core meets an
        AttributeError instead of an answer.
        """
        del path
        return None


class FakeOps:
    """Faithful to the real facade: ``stat`` follows namespace links and
    never reports one, ``unlink`` removes a link entry (the door
    special-cases it), and links are visible only through ``links``.
    """

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {"/a.txt": b"hello"}
        # A real facade dates its rows, and a fake that does not is how
        # an adapter shipped every file to clients as 1970 with a green
        # unit suite. None here means "this backend cannot date a file",
        # which is a case worth covering too.
        self.stamp: str | None = "2026-01-02T03:04:05+00:00"
        self.dirs: set[str] = {"/", "/sub"}
        self.link_table: dict[str, str] = {}
        self.mount_roots: set[str] = set()
        self.calls: list[tuple[str, str]] = []

    @property
    def links(self) -> FakeLinks:
        return FakeLinks(self.link_table)

    def _follow(self, path: str) -> str:
        target = self.link_table.get(path)
        if target is None:
            return path
        if target.startswith("/"):
            return target
        parent = path.rsplit("/", 1)[0] or "/"
        return (parent.rstrip("/") + "/" +
                target) if parent != "/" else ("/" + target)

    async def stat(self, path: str) -> FileStat:
        self.calls.append(("stat", path))
        path = self._follow(path)
        if path in self.dirs or path in self.mount_roots:
            return FileStat(name=path,
                            type=FileType.DIRECTORY,
                            modified=self.stamp)
        if path in self.files:
            return FileStat(name=path,
                            type=FileType.FILE,
                            size=len(self.files[path]),
                            modified=self.stamp)
        raise FileNotFoundError(path)

    async def read(self, path: str, offset: int = 0, size=None, raw=False):
        self.calls.append(("read", path))
        if path not in self.files:
            raise FileNotFoundError(path)
        return self.files[path]

    async def write(self, path: str, data: bytes) -> None:
        self.calls.append(("write", path))
        self.files[path] = data

    async def create(self, path: str) -> None:
        self.files[path] = b""

    async def mkdir(self, path: str) -> None:
        self.dirs.add(path)

    async def unlink(self, path: str) -> None:
        if path in self.link_table:
            self.link_table.pop(path)
            return
        self.files.pop(path, None)

    async def rmdir(self, path: str) -> None:
        self.dirs.discard(path)

    async def rename(self, src: str, dst: str) -> None:
        if src in self.files:
            self.files[dst] = self.files.pop(src)
        if src in self.dirs:
            self.dirs.discard(src)
            self.dirs.add(dst)

    async def symlink(self, path: str, target: str) -> None:
        self.link_table[path] = target

    async def readdir(self, path: str) -> list[str]:
        # The real facade answers in paths, child mounts with a
        # trailing slash; names are the adapter's job to derive.
        prefix = path.rstrip("/") + "/"
        found = {
            prefix + k[len(prefix):].split("/")[0]
            for k in list(self.files) + list(self.dirs) + list(self.link_table)
            if k.startswith(prefix) and k != path
        }
        found |= {p + "/" for p in self.mount_roots if p.startswith(prefix)}
        return sorted(found)

    async def truncate(self, path: str, length: int) -> None:
        self.files[path] = self.files.get(path, b"")[:length]


def make() -> tuple[MirageNFS, FakeOps]:
    ops = FakeOps()
    return MirageNFS(ops), ops


def run(coro):
    return asyncio.run(coro)


def test_root_dir_is_allocated_not_hardcoded():
    fs, _ = make()
    assert fs.root_dir() > 0
    assert fs.root_dir() == fs.root_dir()


def test_lookup_returns_a_stable_id_for_a_child():
    fs, _ = make()
    root = fs.root_dir()
    first = run(fs.lookup(root, "a.txt"))
    assert first == run(fs.lookup(root, "a.txt"))


def test_lookup_of_a_missing_child_raises():
    fs, _ = make()
    with pytest.raises(FileNotFoundError):
        run(fs.lookup(fs.root_dir(), "nope.txt"))


def test_getattr_reports_size_and_type():
    fs, _ = make()
    fileid = run(fs.lookup(fs.root_dir(), "a.txt"))
    attr = run(fs.getattr(fileid))
    assert attr.size == 5
    assert attr.is_dir is False


def test_getattr_on_an_unknown_id_is_stale():
    fs, _ = make()
    with pytest.raises(StaleHandleError):
        run(fs.getattr(4242))


def test_read_returns_the_requested_slice():
    fs, _ = make()
    fileid = run(fs.lookup(fs.root_dir(), "a.txt"))
    assert run(fs.read(fileid, 1, 3)) == b"ell"


def test_write_is_buffered_not_stored_immediately():
    fs, ops = make()
    fileid = run(fs.lookup(fs.root_dir(), "a.txt"))
    run(fs.write(fileid, 0, b"HELLO"))
    assert ops.files["/a.txt"] == b"hello"
    assert ("write", "/a.txt") not in ops.calls


def test_a_buffered_write_is_visible_to_read_and_getattr():
    fs, _ = make()
    fileid = run(fs.lookup(fs.root_dir(), "a.txt"))
    run(fs.write(fileid, 0, b"HELLO"))
    assert run(fs.read(fileid, 0, 5)) == b"HELLO"
    assert run(fs.getattr(fileid)).size == 5


def test_a_write_past_the_end_extends_the_reported_size():
    fs, _ = make()
    fileid = run(fs.lookup(fs.root_dir(), "a.txt"))
    run(fs.write(fileid, 10, b"xy"))
    assert run(fs.getattr(fileid)).size == 12


def test_flush_stores_merged_out_of_order_writes():
    fs, ops = make()
    fileid = run(fs.lookup(fs.root_dir(), "a.txt"))
    run(fs.write(fileid, 4, b"dd"))
    run(fs.write(fileid, 0, b"aa"))
    run(fs.write(fileid, 2, b"bb"))
    run(fs.flush(fileid))
    assert ops.files["/a.txt"] == b"aabbdd"


def test_flush_all_stores_every_buffered_file():
    fs, ops = make()
    root = fs.root_dir()
    one = run(fs.create(root, "one.txt"))
    two = run(fs.create(root, "two.txt"))
    run(fs.write(one, 0, b"1"))
    run(fs.write(two, 0, b"2"))
    run(fs.flush_all())
    assert ops.files["/one.txt"] == b"1"
    assert ops.files["/two.txt"] == b"2"


def test_create_makes_the_file_and_returns_an_id():
    fs, ops = make()
    fileid = run(fs.create(fs.root_dir(), "new.txt"))
    assert "/new.txt" in ops.files
    assert run(fs.getattr(fileid)).size == 0


def test_mkdir_makes_a_directory():
    fs, ops = make()
    fileid = run(fs.mkdir(fs.root_dir(), "d"))
    assert "/d" in ops.dirs
    assert run(fs.getattr(fileid)).is_dir is True


def test_remove_of_a_file_unlinks_and_drops_buffered_writes():
    fs, ops = make()
    root = fs.root_dir()
    fileid = run(fs.lookup(root, "a.txt"))
    run(fs.write(fileid, 0, b"doomed"))
    run(fs.remove(root, "a.txt"))
    assert "/a.txt" not in ops.files
    run(fs.flush_all())
    assert "/a.txt" not in ops.files


def test_remove_of_a_directory_routes_to_rmdir():
    fs, ops = make()
    run(fs.remove(fs.root_dir(), "sub"))
    assert "/sub" not in ops.dirs


def test_remove_invalidates_the_id():
    fs, _ = make()
    root = fs.root_dir()
    fileid = run(fs.lookup(root, "a.txt"))
    run(fs.remove(root, "a.txt"))
    with pytest.raises(StaleHandleError):
        run(fs.getattr(fileid))


def test_rename_moves_the_file_and_keeps_the_id():
    fs, ops = make()
    root = fs.root_dir()
    fileid = run(fs.lookup(root, "a.txt"))
    run(fs.rename(root, "a.txt", root, "b.txt"))
    assert "/b.txt" in ops.files
    assert run(fs.getattr(fileid)).size == 5


def test_rename_flushes_pending_writes_to_the_new_path():
    fs, ops = make()
    root = fs.root_dir()
    fileid = run(fs.lookup(root, "a.txt"))
    run(fs.write(fileid, 0, b"moved"))
    run(fs.rename(root, "a.txt", root, "b.txt"))
    run(fs.flush_all())
    assert ops.files["/b.txt"] == b"moved"


def test_setattr_truncate_clips_pending_writes():
    fs, ops = make()
    fileid = run(fs.lookup(fs.root_dir(), "a.txt"))
    run(fs.write(fileid, 0, b"abcdef"))
    run(fs.setattr(fileid, SetAttrs(size=3)))
    run(fs.flush_all())
    assert ops.files["/a.txt"] == b"abc"


def test_setattr_ignores_mode_and_owner():
    fs, _ = make()
    fileid = run(fs.lookup(fs.root_dir(), "a.txt"))
    attr = run(fs.setattr(fileid, SetAttrs()))
    assert attr.size == 5


def test_symlink_and_readlink_round_trip():
    # An absolute target names a virtual path, so it is presented
    # relative to the link's directory -- returned raw, the client
    # would resolve it against the host root and escape the mount.
    fs, _ = make()
    root = fs.root_dir()
    fileid = run(fs.symlink(root, "link", "/a.txt"))
    assert run(fs.readlink(fileid)) == "a.txt"


def test_readlink_keeps_a_relative_target_verbatim():
    fs, _ = make()
    fileid = run(fs.symlink(fs.root_dir(), "link", "a.txt"))
    assert run(fs.readlink(fileid)) == "a.txt"


def test_getattr_on_a_link_reports_the_link_not_the_target():
    fs, _ = make()
    fileid = run(fs.symlink(fs.root_dir(), "link", "/a.txt"))
    attr = run(fs.getattr(fileid))
    assert attr.is_symlink is True
    assert attr.is_dir is False
    assert attr.size == len(b"a.txt")


def test_remove_of_a_link_to_a_directory_keeps_the_target():
    fs, ops = make()
    root = fs.root_dir()
    run(fs.symlink(root, "dlink", "/sub"))
    run(fs.remove(root, "dlink"))
    assert "/dlink" not in ops.link_table
    assert "/sub" in ops.dirs


def test_remove_of_a_broken_link_succeeds():
    fs, ops = make()
    root = fs.root_dir()
    run(fs.symlink(root, "ghost", "/nope.txt"))
    run(fs.remove(root, "ghost"))
    assert "/ghost" not in ops.link_table


def test_lookup_finds_a_broken_link():
    fs, _ = make()
    root = fs.root_dir()
    made = run(fs.symlink(root, "ghost", "/nope.txt"))
    assert run(fs.lookup(root, "ghost")) == made


def test_readdir_derives_names_from_facade_paths():
    # The op facade answers readdir in paths (a child mount with a
    # trailing slash); the adapter derives bare names, the way
    # MountCore.readdir does.
    fs, ops = make()
    ops.mount_roots.add("/dev")
    names = [e.name for e in run(fs.readdir(fs.root_dir()))]
    assert "dev" in names
    assert "a.txt" in names
    assert not any("/" in n for n in names)


def test_readdir_skips_macos_metadata_names():
    fs, ops = make()
    ops.files["/.DS_Store"] = b"x"
    ops.files["/._shadow"] = b"x"
    names = [e.name for e in run(fs.readdir(fs.root_dir()))]
    assert ".DS_Store" not in names and "._shadow" not in names


def test_lookup_of_a_metadata_name_is_enoent_without_backend_hit():
    fs, ops = make()
    before = len(ops.calls)
    with pytest.raises(FileNotFoundError):
        run(fs.lookup(fs.root_dir(), ".DS_Store"))
    assert len(ops.calls) == before


def test_readdir_marks_a_link_entry():
    fs, _ = make()
    root = fs.root_dir()
    run(fs.symlink(root, "link", "/a.txt"))
    entries = {e.name: e for e in run(fs.readdir(root))}
    assert entries["link"].attrs.is_symlink is True
    assert entries["a.txt"].attrs.is_symlink is False


def test_rename_into_own_subtree_leaves_backend_untouched():
    fs, ops = make()
    root = fs.root_dir()
    subid = run(fs.lookup(root, "sub"))
    with pytest.raises(OSError):
        run(fs.rename(root, "sub", subid, "inner"))
    assert "/sub" in ops.dirs


def test_readdir_lists_entries_with_ids():
    fs, _ = make()
    entries = run(fs.readdir(fs.root_dir()))
    names = [e.name for e in entries]
    assert "a.txt" in names and "sub" in names
    assert all(e.fileid > 0 for e in entries)


def test_readdir_paginates_from_a_cookie():
    # The cookie is the last entry's fileid -- the server crate derives
    # the wire cookie from it and hands it back as start_after.
    fs, _ = make()
    root = fs.root_dir()
    first = run(fs.readdir(root, cookie=0, max_entries=1))
    assert len(first) == 1
    assert first[0].cookie == first[0].fileid
    rest = run(fs.readdir(root, cookie=first[-1].cookie))
    assert first[0].name not in [e.name for e in rest]
    assert [e.name for e in first] + [e.name for e in rest] == sorted(
        e.name for e in run(fs.readdir(root)))


def test_readdir_resume_survives_id_order_not_matching_name_order():
    # Ids are minted in access order, so a later entry can carry a
    # smaller fileid than an earlier one; resume must key on identity,
    # never on comparing cookie magnitudes.
    fs, ops = make()
    root = fs.root_dir()
    run(fs.lookup(root, "sub"))
    ops.files["/0first.txt"] = b"x"
    first = run(fs.readdir(root, cookie=0, max_entries=2))
    rest = run(fs.readdir(root, cookie=first[-1].cookie))
    assert [e.name for e in first] + [e.name for e in rest] == sorted(
        e.name for e in run(fs.readdir(root)))


def test_set_size_delegates_to_setattr():
    fs, ops = make()
    fileid = run(fs.lookup(fs.root_dir(), "a.txt"))
    attr = run(fs.set_size(fileid, 3))
    assert attr.size == 3
    assert ops.files["/a.txt"] == b"hel"
    attr = run(fs.set_size(fileid, None))
    assert attr.size == 3


def test_attrs_carry_a_real_mtime():
    # vfs.rs reads mtime_epoch and nothing else; an adapter that fills a
    # prettier field instead dates every file 1970 on the client, which
    # is what shipped before this test existed.
    fs, ops = make()
    attrs = run(fs.getattr(run(fs.lookup(fs.root_dir(), "a.txt"))))
    assert attrs.mtime_epoch > 1_000_000_000


def test_an_undated_row_is_dated_from_the_mount():
    # This asserted the epoch, on the argument that a fabricated time is
    # a lie. Sharing the core settles it the other way: the fuse tier has
    # always answered its mount time for a row the backend cannot date,
    # and two kernel mounts of one tree disagreeing about a file's age is
    # worse than either answer. Neither says 1970 when the backend knows.
    fs, ops = make()
    ops.stamp = None
    attrs = run(fs.getattr(run(fs.lookup(fs.root_dir(), "a.txt"))))
    assert attrs.mtime_epoch > 1_000_000_000


def test_overlapping_flushes_do_not_lose_an_acknowledged_write():
    # The losing interleaving is specific: the first flush must already
    # have taken its batch and be parked in the store when the second
    # reads the base, so both merge onto the same bytes and the later
    # store drops the earlier batch. Waiting for the store to be entered
    # is what makes that deterministic rather than a timing guess.
    fs, ops = make()
    fileid = run(fs.lookup(fs.root_dir(), "a.txt"))
    real_write = ops.write

    async def scenario() -> bytes:
        gate = asyncio.Event()
        entered = asyncio.Event()
        held = False

        async def slow_write(path: str, data: bytes) -> None:
            nonlocal held
            if not held:
                held = True
                entered.set()
                await gate.wait()
            await real_write(path, data)

        ops.write = slow_write
        await fs.write(fileid, 0, b"AAAAA")
        first = asyncio.create_task(fs.flush(fileid))
        await entered.wait()
        await fs.write(fileid, 5, b"BBBBB")
        second = asyncio.create_task(fs.flush(fileid))
        gate.set()
        await asyncio.gather(first, second)
        ops.write = real_write
        return ops.files["/a.txt"]

    assert run(scenario()) == b"AAAAABBBBB"


# --- the three data-loss paths the review found, all in both languages ---


def test_exclusive_create_refuses_an_existing_file_without_touching_it():
    # NFSv3 EXCLUSIVE is O_CREAT|O_EXCL on the wire, so it is every
    # lockfile idiom there is. Routed to the plain create, whose core
    # truncates, it emptied the file it was meant to refuse.
    fs, ops = make()
    ops.files["/keep.txt"] = b"important data\n"

    with pytest.raises(FileExistsError):
        run(fs.create_exclusive(fs.root_dir(), "keep.txt"))

    assert ops.files["/keep.txt"] == b"important data\n"


def test_exclusive_create_still_creates_a_fresh_file():
    fs, ops = make()

    fileid = run(fs.create_exclusive(fs.root_dir(), "new.txt"))

    assert fileid > 0
    assert ops.files["/new.txt"] == b""


def test_a_failed_flush_keeps_the_writes_it_acknowledged():
    # Every buffered write was answered FILE_SYNC, so the client will
    # never send them again. take() up front meant a store that raised
    # lost them for good.
    fs, ops = make()
    fileid = run(fs.lookup(fs.root_dir(), "a.txt"))
    run(fs.write(fileid, 0, b"NEW"))

    async def boom(path: str, data: bytes) -> None:
        raise PermissionError(path)

    ops.write = boom
    with pytest.raises(PermissionError):
        run(fs.flush(fileid))

    assert fs._writes.has_pending(fileid)

    ops.write = FakeOps.write.__get__(ops, FakeOps)
    run(fs.flush(fileid))
    assert ops.files["/a.txt"] == b"NEWlo"


def test_a_failed_remove_keeps_the_writes_it_acknowledged():
    # A denied unlink used to leave the file in place with its
    # pre-write bytes while the acknowledged writes were already gone.
    fs, ops = make()
    fileid = run(fs.lookup(fs.root_dir(), "a.txt"))
    run(fs.write(fileid, 0, b"NEW"))

    async def denied(path: str) -> None:
        raise PermissionError(path)

    ops.unlink = denied
    with pytest.raises(PermissionError):
        run(fs.remove(fs.root_dir(), "a.txt"))

    assert fs._writes.has_pending(fileid)


def test_a_successful_remove_still_drops_the_buffer():
    fs, ops = make()
    fileid = run(fs.lookup(fs.root_dir(), "a.txt"))
    run(fs.write(fileid, 0, b"NEW"))

    run(fs.remove(fs.root_dir(), "a.txt"))

    assert not fs._writes.has_pending(fileid)
    assert "/a.txt" not in ops.files


def test_sequential_reads_fetch_the_object_once():
    # NFSv3 has no OPEN, so the prefetch cache's only fill site (open)
    # never fired for NFS and every 64 KiB READ refetched the whole
    # file: 16 full fetches to serve 1 MiB, one backend request per
    # 64 KiB on an API-backed mount.
    fs, ops = make()
    ops.files["/big.bin"] = bytes(1024 * 1024)
    fileid = run(fs.lookup(fs.root_dir(), "big.bin"))

    async def sixteen_reads() -> int:
        served = 0
        for i in range(16):
            served += len(await fs.read(fileid, i * 65536, 65536))
        return served

    served = run(sixteen_reads())

    assert served == 1024 * 1024
    assert [c for c in ops.calls if c[0] == "read"] == [("read", "/big.bin")]


def test_readdir_resumes_after_the_cookie_entry_was_removed():
    # The resume scan looked for the cookie's fileid and only stopped
    # skipping on an exact match, so removing that entry between pages
    # skipped the whole rest of the directory and the empty page read
    # as end-of-listing.
    fs, ops = make()
    ops.dirs.add("/pages")
    for name in ("a", "b", "c", "e", "f"):
        ops.files[f"/pages/{name}"] = b"x"
    pages = run(fs.lookup(fs.root_dir(), "pages"))
    page1 = run(fs.readdir(pages, 0, 2))
    assert [e.name for e in page1] == ["a", "b"]

    run(fs.remove(pages, "b"))

    page2 = run(fs.readdir(pages, page1[-1].cookie))
    assert [e.name for e in page2] == ["c", "e", "f"]


def test_readdir_rejects_a_cookie_it_never_minted():
    # Silently returning nothing reads as end-of-directory; a client
    # can recover from an error by restarting the listing.
    fs, _ = make()
    with pytest.raises(StaleHandleError):
        run(fs.readdir(fs.root_dir(), 999_999))


def test_lookup_refuses_a_name_that_is_not_one_component():
    # filename3 is a single component and nfsserve does not filter it,
    # so the delegate is the only guard. Traversal did not escape only
    # because nothing below normalizes "..", which is luck, not a check.
    fs, ops = make()
    ops.dirs.add("/sub/deep")
    ops.files["/sub/deep/b.txt"] = b"x"
    sub = run(fs.lookup(fs.root_dir(), "sub"))
    with pytest.raises(OSError) as caught:
        run(fs.lookup(sub, "deep/b.txt"))
    assert caught.value.errno == errno.EINVAL


def test_lookup_resolves_dot_and_dotdot():
    # The kernel resolves these above the filesystem for FUSE, which is
    # why MountCore never had to; over NFSv3 they are the server's job,
    # and ENOENT was a cold-cache hole.
    fs, _ = make()
    root = fs.root_dir()
    sub = run(fs.lookup(root, "sub"))

    assert run(fs.lookup(sub, ".")) == sub
    assert run(fs.lookup(sub, "..")) == root
    assert run(fs.lookup(root, "..")) == root


def test_mutating_ops_refuse_a_slashed_name():
    fs, _ = make()
    root = fs.root_dir()
    for call in (lambda: fs.create(root, "a/b"), lambda: fs.mkdir(root, "a/b"),
                 lambda: fs.remove(root, "a/b"),
                 lambda: fs.symlink(root, "a/b", "t"),
                 lambda: fs.rename(root, "a/b", root, "c")):
        with pytest.raises(OSError) as caught:
            run(call())
        assert caught.value.errno == errno.EINVAL


def test_the_total_buffer_is_bounded_across_files():
    # max_buffered_bytes bounds one handle, so N files written at once
    # cost N times it and nothing bounded the sum: a `cp -r` of many
    # large files grew the process without limit.
    config = NFSConfig(max_buffered_bytes=1024, max_total_buffered_bytes=2048)
    ops = FakeOps()
    fs = MirageNFS(ops, config)
    root = fs.root_dir()
    for i in range(8):
        ops.files[f"/f{i}"] = b""
        fileid = run(fs.lookup(root, f"f{i}"))
        run(fs.write(fileid, 0, b"x" * 512))

    assert fs._writes.total_bytes() <= 2048


def test_a_failed_truncate_keeps_the_writes_it_acknowledged():
    # setattr clipped the buffer before the truncate landed, so a
    # denied or transient failure discarded acknowledged bytes while
    # the file kept its old length. Same shape as remove's drop.
    fs, ops = make()
    fileid = run(fs.lookup(fs.root_dir(), "a.txt"))
    run(fs.write(fileid, 0, b"NEWDATA"))

    async def denied(path: str, length: int) -> None:
        raise PermissionError(path)

    ops.truncate = denied
    with pytest.raises(PermissionError):
        run(fs.setattr(fileid, SetAttrs(size=2)))

    assert fs._writes.has_pending(fileid)
    ops.truncate = FakeOps.truncate.__get__(ops, FakeOps)
    run(fs.flush(fileid))
    assert ops.files["/a.txt"] == b"NEWDATA"


def test_the_flush_lock_table_does_not_grow_with_files_written():
    # Ids are never reused, so a lock left behind per written file is an
    # unbounded map on a long-lived mount -- the same complaint as an
    # unbounded write buffer, one level down.
    fs, ops = make()
    root = fs.root_dir()
    for i in range(50):
        ops.files[f"/g{i}"] = b""
        fileid = run(fs.lookup(root, f"g{i}"))
        run(fs.write(fileid, 0, b"x"))
        run(fs.flush(fileid))

    assert fs._flush_locks == {}
