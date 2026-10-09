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

import pytest

from mirage.errors.types import OperationNotSupportedError
from mirage.runtime.constants import LISTING_ENTRY_CONCURRENCY
from mirage.runtime.errors import CrossMountError
from mirage.runtime.files import RuntimeFiles
from mirage.runtime.handles import FlushStep
from mirage.runtime.resolver import PrefixResolver
from mirage.runtime.types import VFSEntry, VFSStat
from mirage.types import DEVICE_NUMBERS_KEY, ContentType, FileStat, FileType
from mirage.utils.stat_view import (
    CHAR_MODE,
    DIR_MODE,
    DIR_SIZE,
    FILE_MODE,
    LINK_MODE,
)


class ListingVFS(RuntimeFiles):
    """Core double for the readdir lifting: canned listing and stats."""

    def __init__(self, listing, stats, links=()):
        names = set(links)
        super().__init__(
            dispatch=None,
            loop=None,
            resolver=PrefixResolver(lambda: [], lambda _dir: names),
        )
        self._listing = list(listing)
        self._stats = dict(stats)
        self.stat_calls = []
        self.unfollowed = []

    def _wait(self, pending):
        return asyncio.run(pending)

    async def _call(self, name, path, **kwargs):
        if name == "readdir":
            return list(self._listing)
        if name == "stat":
            self.stat_calls.append(path)
            if kwargs.get("nofollow"):
                self.unfollowed.append(path)
            st = self._stats.get(path)
            if st is None:
                raise FileNotFoundError(path)
            if isinstance(st, Exception):
                raise st
            return st
        raise NotImplementedError(name)


class RecordingVFS(RuntimeFiles):
    """Core with a recorded dispatch, so the routing under test is real."""

    def __init__(self, prefixes=(), no_append=()):
        super().__init__(
            dispatch=None,
            loop=None,
            resolver=PrefixResolver(lambda: list(prefixes)),
        )
        self.calls = []
        self._declines = set(no_append)

    def call(self, op, path, **kwargs):
        self.calls.append((op, path, kwargs))
        if op == "append" and self.mount_of(path) in self._declines:
            raise OperationNotSupportedError("append")
        return b"" if op == "read" else None


class WorldVFS(RuntimeFiles):
    """Core over an empty world, or one where every op is refused."""

    def __init__(self, refuse=None):
        super().__init__(
            dispatch=None,
            loop=None,
            resolver=PrefixResolver(lambda: ["/data/"]),
        )
        self.refuse = refuse

    def _wait(self, pending):
        return asyncio.run(pending)

    async def _call(self, name, path, **kwargs):
        if self.refuse is not None:
            raise self.refuse
        raise FileNotFoundError(path)


class RecordingDispatch:
    """Workspace dispatch double, recording what reached the loop."""

    def __init__(self, result=b"payload", raises=None):
        self.result = result
        self.raises = raises
        self.seen = []

    async def __call__(self, op, path, **kwargs):
        self.seen.append((op, path.virtual))
        if self.raises is not None:
            raise self.raises
        return self.result, None


def test_mount_of_takes_the_longest_prefix():
    vfs = RecordingVFS(prefixes=["/data/", "/data/inner/"])
    assert vfs.mount_of("/data/inner/f.txt") == "/data/inner"
    assert vfs.mount_of("/data/f.txt") == "/data"
    assert vfs.mount_of("/data") == "/data"
    assert vfs.mount_of("/elsewhere/f.txt") is None


def test_a_root_mount_is_a_prefix_like_any_other():
    # It claims every path, which is what mounting at `/` means. The
    # one place that cannot live with an exclusive root claim excludes
    # it itself (WasmView._prefixes), because only it has a build tree
    # to protect.
    vfs = RecordingVFS(prefixes=["/"])
    assert vfs.prefixes() == ["/"]
    assert vfs.mount_of("/x.txt") == "/"
    assert vfs.mount_of("/") == "/"


def test_a_longer_mount_still_wins_over_the_root_one():
    vfs = RecordingVFS(prefixes=["/", "/data/"])
    assert vfs.mount_of("/data/f.txt") == "/data"
    assert vfs.mount_of("/elsewhere/f.txt") == "/"


def test_rename_across_mounts_is_refused_before_any_dispatch():
    vfs = RecordingVFS(prefixes=["/data/", "/other/"])
    with pytest.raises(CrossMountError) as exc:
        vfs.rename("/data/a.txt", "/other/a.txt")
    assert exc.value.src == "/data/a.txt"
    assert exc.value.dst == "/other/a.txt"
    assert vfs.calls == []


def test_rename_within_one_mount_dispatches():
    vfs = RecordingVFS(prefixes=["/data/"])
    vfs.rename("/data/a.txt", "/data/b.txt")
    op, path, kwargs = vfs.calls[0]
    assert (op, path) == ("rename", "/data/a.txt")
    assert kwargs["dst"].virtual == "/data/b.txt"


def test_serves_scopes_to_the_mounts_and_an_unscoped_entry_point_serves_all():
    scoped = RecordingVFS(prefixes=["/data/"])
    assert scoped.serves("/data/a.txt") is True
    assert scoped.serves("/tmp/a.txt") is False
    assert RecordingVFS().serves("/tmp/a.txt") is True


def test_serves_a_path_reached_through_a_link_outside_every_mount():
    # The dispatcher follows a link outside every mount, so what is
    # reached through one is the workspace's too.
    files = RuntimeFiles(
        dispatch=None,
        loop=None,
        resolver=PrefixResolver(
            lambda: ["/data/"],
            lambda directory: {"alias"} if directory == "/" else set(),
        ),
    )
    assert files.serves("/alias") is True
    assert files.serves("/alias/inner.txt") is True
    assert files.serves("/tmp/a.txt") is False


F = "/data/f"


class ViewVFS(RuntimeFiles):
    """Core over /data, with a withheld file and a listed-only directory."""

    def __init__(self):
        super().__init__(
            dispatch=None,
            loop=None,
            resolver=PrefixResolver(lambda: ["/data/"]),
        )

    def _wait(self, pending):
        return asyncio.run(pending)

    async def _call(self, name, path, **kwargs):
        if name == "stat":
            if path in ("/data/a.txt", "/.bash_history"):
                return FileStat(name=path, size=1, type=FileType.FILE)
            raise FileNotFoundError(path)
        if name == "readdir" and path in ("/", "/parent", "/.bash_history"):
            return []
        raise FileNotFoundError(path)


def test_view_stat_opens_structure_and_withholds_content():
    vfs = ViewVFS()
    assert vfs.view_stat("/data/a.txt").is_dir is False
    implied = vfs.view_stat("/parent")
    assert (implied.is_dir, implied.mode) == (True, DIR_MODE)
    # A withheld file stays unseen though its mount lists it as empty,
    # the way the history mount does so a traversal never descends.
    assert vfs.view_stat("/.bash_history") is None


def test_a_refusal_is_not_read_as_an_absence():
    # A backend that will not answer has said nothing about whether the
    # path is there, and "not there" is the one answer a guest cannot
    # tell from the truth.
    vfs = WorldVFS(refuse=PermissionError(errno.EACCES, "denied", F))
    with pytest.raises(PermissionError):
        vfs.stat_or_none(F)
    with pytest.raises(PermissionError):
        vfs.listing_or_none(F)
    assert WorldVFS().stat_or_none(F) is None
    assert WorldVFS().listing_or_none(F) is None


def test_readdir_lifts_names_into_entries():
    # The TS bridge resolves path/size/isDir once at the file adapter, off the
    # stat index the readdir just populated; python answered bare names
    # and every consumer re-parsed the trailing-slash convention, paying
    # one guest stat per entry for a fact the file adapter already had.
    vfs = ListingVFS(
        listing=["/data/sub/", "/data/a.txt", "/data/ghost.txt"],
        stats={
            "/data/a.txt": FileStat(
                name="a.txt",
                size=4,
                type=FileType.FILE,
                content=ContentType.TEXT,
            ),
        },
    )
    assert vfs.readdir("/data/") == [
        VFSEntry(path="/data/sub/", size=0, is_dir=True),
        VFSEntry(
            path="/data/a.txt",
            size=4,
            is_dir=False,
            mode=FILE_MODE,
            mtime_ns=0,
        ),
        VFSEntry(path="/data/ghost.txt", size=0, is_dir=False),
    ]
    # A slash-marked directory skips the stat; a vanished entry (or a
    # dangling link) rides as a size-0 file instead of failing the
    # whole listing.
    assert vfs.stat_calls == ["/data/a.txt", "/data/ghost.txt"]


def test_readdir_keeps_the_listing_when_one_stat_fails(caplog):
    # One record a remote API refuses must not cost the guest the whole
    # directory: the row rides unclassified and the guest's own open of
    # it reports the failure. A missing entry is ordinary and stays
    # quiet; any other failure warns on the host.
    vfs = ListingVFS(
        listing=["/data/a.txt", "/data/bad.txt", "/data/gone.txt"],
        stats={
            "/data/a.txt": FileStat(name="a.txt", size=4, type=FileType.FILE),
            "/data/bad.txt": RuntimeError("upstream 502 Bad Gateway"),
        },
    )
    with caplog.at_level(logging.WARNING, logger="mirage.runtime.files"):
        assert vfs.readdir("/data/") == [
            VFSEntry(
                path="/data/a.txt",
                size=4,
                is_dir=False,
                mode=FILE_MODE,
                mtime_ns=0,
            ),
            VFSEntry(path="/data/bad.txt", size=0, is_dir=False),
            VFSEntry(path="/data/gone.txt", size=0, is_dir=False),
        ]
    assert [
        r.getMessage()
        for r in caplog.records
        if r.name == "mirage.runtime.files"
    ] == [
        "runtime files: readdir /data/: stat /data/bad.txt: "
        "upstream 502 Bad Gateway"
    ]


def test_readdir_names_only_stats_nothing():
    # A guest that only wants names pays for the listing and nothing
    # else, the way a POSIX readdir costs one call.
    vfs = ListingVFS(
        listing=["/data/sub/", "/data/a.txt"],
        stats={
            "/data/a.txt": FileStat(name="a.txt", size=4, type=FileType.FILE),
        },
    )
    assert vfs.readdir("/data/", classify=False) == [
        VFSEntry(path="/data/sub/", size=0, is_dir=True),
        VFSEntry(path="/data/a.txt", size=0, is_dir=False),
    ]
    assert vfs.stat_calls == []


def test_readdir_stats_unmarked_directories():
    # RAM-style backends mark nothing with a slash; dir-ness comes from
    # the stat.
    vfs = ListingVFS(
        listing=["/data/sub"],
        stats={
            "/data/sub": FileStat(name="sub", type=FileType.DIRECTORY),
        },
    )
    assert vfs.readdir("/data/") == [
        VFSEntry(
            path="/data/sub",
            size=DIR_SIZE,
            is_dir=True,
            mode=DIR_MODE,
            mtime_ns=0,
        ),
    ]


def test_readdir_marks_the_names_the_resolver_calls_links():
    # The mark is the name plane's, and a marked row is the link's own,
    # as a guest's lstat reads it: the node table answers, no backend.
    vfs = ListingVFS(
        listing=["/data/lnk", "/data/a.txt"],
        stats={
            "/data/lnk": FileStat(name="lnk", size=8, type=FileType.SYMLINK),
            "/data/a.txt": FileStat(
                name="a.txt",
                size=5,
                type=FileType.FILE,
                content=ContentType.TEXT,
            ),
        },
        links=["lnk"],
    )
    assert vfs.readdir("/data/") == [
        VFSEntry(
            path="/data/lnk",
            size=8,
            is_dir=False,
            is_link=True,
            mode=LINK_MODE,
            mtime_ns=0,
        ),
        VFSEntry(
            path="/data/a.txt",
            size=5,
            is_dir=False,
            mode=FILE_MODE,
            mtime_ns=0,
        ),
    ]
    assert vfs.unfollowed == ["/data/lnk"]


def test_stat_projects_one_struct_for_every_surface():
    # The projection is the file adapter's, so preview1, monty and Emscripten
    # read the same five facts instead of translating a FileStat three
    # ways. mode carries the type bits, which is what a wire with no
    # mode field of its own reads the kind out of.
    vfs = ListingVFS(
        listing=[],
        stats={
            "/data/a.txt": FileStat(
                name="a.txt",
                size=4,
                type=FileType.FILE,
                content=ContentType.TEXT,
                mode=0o700,
                modified="2026-07-15T00:00:00Z",
            ),
        },
    )
    st = vfs.stat("/data/a.txt")
    assert st == VFSStat(
        size=4,
        is_dir=False,
        mode=(FILE_MODE & ~0o7777) | 0o700,
        mtime_ns=st.mtime_ns,
    )
    assert st.mtime_ns > 0


def test_stat_reports_an_unknown_stamp_as_none():
    vfs = ListingVFS(
        listing=[],
        stats={
            "/data/a.txt": FileStat(name="a.txt", size=1, type=FileType.FILE)
        },
    )
    assert vfs.stat("/data/a.txt").mtime_ns is None


def test_stat_projects_character_type_bits_and_logical_device_numbers():
    vfs = ListingVFS(
        listing=[],
        stats={
            "/dev/zero": FileStat(
                name="zero",
                type=FileType.CHAR_DEVICE,
                extra={DEVICE_NUMBERS_KEY: [1, 5]},
            ),
        },
    )
    assert vfs.stat("/dev/zero") == VFSStat(
        size=0, is_dir=False, mode=CHAR_MODE, rdev=0x105
    )


def test_stat_nofollow_asks_the_dispatcher_for_the_link_row():
    # lstat is one dispatcher question now, not a surface reaching past it:
    # the flag rides the dispatch, which answers a link's own row from
    # the node table and gates it exactly as it gates readlink.
    vfs = ListingVFS(
        listing=[],
        stats={
            "/data/lnk": FileStat(name="lnk", size=8, type=FileType.SYMLINK),
        },
    )
    st = vfs.stat("/data/lnk", nofollow=True)
    assert (st.is_link, st.mode, st.size) == (True, LINK_MODE, 8)


def test_readdir_carries_the_metadata_only_where_it_stated():
    # A row that stat'd reports its mode and stamp, so a guest seeding
    # a whole tree from one listing needs no second stat per file. A
    # slash-marked row never asked, and says so with None rather than a
    # default the guest cannot tell from an answer.
    vfs = ListingVFS(
        listing=["/data/sub/", "/data/a.txt"],
        stats={
            "/data/a.txt": FileStat(
                name="a.txt",
                size=4,
                type=FileType.FILE,
                content=ContentType.TEXT,
                mode=0o600,
                modified="2026-07-15T00:00:00Z",
            ),
        },
    )
    marked, stated = vfs.readdir("/data/")
    assert (marked.mode, marked.mtime_ns) == (None, None)
    assert stated.mode == (FILE_MODE & ~0o7777) | 0o600
    assert stated.mtime_ns is not None and stated.mtime_ns > 0


def test_readdir_marks_a_link_whatever_shape_the_entry_arrived_in():
    # Backends answer with bare names, trailing-slash names and full
    # paths; the final segment is the part they agree on.
    vfs = ListingVFS(
        listing=["lnk", "/data/dirlink/"],
        stats={},
        links=["lnk", "dirlink"],
    )
    assert vfs.readdir("/data/") == [
        VFSEntry(path="lnk", size=0, is_dir=False, is_link=True),
        VFSEntry(path="/data/dirlink/", size=0, is_dir=True, is_link=True),
    ]


def test_readdir_marks_nothing_without_a_link_source():
    vfs = ListingVFS(listing=["/data/lnk"], stats={})
    assert vfs.readdir("/data/") == [
        VFSEntry(path="/data/lnk", size=0, is_dir=False),
    ]


class NoAppendVFS(RuntimeFiles):
    """Core over a mount that registers write but not append (S3)."""

    def __init__(self, files):
        super().__init__(
            dispatch=None, loop=None, resolver=PrefixResolver(lambda: ["/s3/"])
        )
        self.files = dict(files)
        self.writes = []
        self.reads = []

    def call(self, op, path, **kwargs):
        if op == "append":
            raise OperationNotSupportedError("append")
        if op == "read":
            self.reads.append(kwargs)
            if path not in self.files:
                raise FileNotFoundError(path)
            return self.files[path]
        self.files[path] = kwargs["data"]
        self.writes.append((path, kwargs["data"]))
        return None


@pytest.mark.parametrize(
    "files, written",
    [({"/s3/a": b"base-"}, b"base-tail"), ({}, b"tail")],
)
def test_append_without_a_whole_file_reads_its_own_base(files, written):
    vfs = NoAppendVFS(files)
    vfs.append("/s3/a", b"tail")
    assert vfs.writes == [("/s3/a", written)]


def test_the_append_fallback_reads_past_the_file_cache():
    vfs = NoAppendVFS({"/s3/a": b"base-"})
    vfs.append("/s3/a", b"tail")
    assert vfs.reads == [{"filetype": None, "direct": True}]


def test_an_append_keeps_a_write_made_since_the_last_one():
    # The fallback reads the base fresh each time: an append lands
    # after whatever the file holds now, as O_APPEND does, so a copy
    # kept from the last append would overwrite another action's write.
    vfs = NoAppendVFS({"/s3/a": b"head"})
    vfs.append("/s3/a", b"-1")
    vfs.files["/s3/a"] = b"other"
    vfs.append("/s3/a", b"-2")
    assert vfs.writes == [("/s3/a", b"head-1"), ("/s3/a", b"other-2")]


def test_flush_sends_each_step_in_order():
    vfs = RecordingVFS(prefixes=["/data/"])
    vfs.flush(
        "/data/f",
        [
            FlushStep("truncate", length=2),
            FlushStep("pwrite", data=b"z", offset=4),
            FlushStep("append", data=b"!"),
            FlushStep("write", data=b"w"),
        ],
    )
    assert vfs.calls == [
        ("truncate", "/data/f", {"length": 2}),
        ("pwrite", "/data/f", {"data": b"z", "offset": 4}),
        ("append", "/data/f", {"data": b"!"}),
        ("write", "/data/f", {"data": b"w"}),
    ]


def test_flush_falls_back_to_a_whole_write_and_remembers_the_mount():
    vfs = RecordingVFS(prefixes=["/data/"], no_append=["/data"])
    vfs.flush("/data/log.txt", [FlushStep("append", data=b"XYZ")])
    vfs.flush("/data/log.txt", [FlushStep("append", data=b"123")])
    ops = [op for op, _, _ in vfs.calls]
    # One failed probe for the mount, not one per call: the second flush
    # reads the base fresh and writes, with no append tried.
    assert ops == ["append", "read", "write", "read", "write"]


def test_symlink_sends_the_target_verbatim():
    vfs = RecordingVFS(prefixes=["/data/"])
    vfs.symlink("/data/l", "../up/t.txt")
    assert vfs.calls == [("symlink", "/data/l", {"target": "../up/t.txt"})]


def test_readlink_returns_the_stored_target():
    class LinkVFS(RecordingVFS):
        def call(self, op, path, **kwargs):
            super().call(op, path, **kwargs)
            return "../up/t.txt"

    assert LinkVFS(prefixes=["/data/"]).readlink("/data/l") == "../up/t.txt"


def test_setattr_passes_every_field_so_the_dispatcher_reads_the_whole_set():
    vfs = RecordingVFS(prefixes=["/data/"])
    vfs.setattr("/data/f.txt", mode=0o600, mtime="1970-01-01T00:03:20+00:00")
    assert vfs.calls == [
        (
            "setattr",
            "/data/f.txt",
            {
                "mode": 0o600,
                "uid": None,
                "gid": None,
                "atime": None,
                "mtime": "1970-01-01T00:03:20+00:00",
                "nofollow": False,
            },
        )
    ]


def test_setattr_forwards_nofollow_for_the_dash_h_family():
    vfs = RecordingVFS(prefixes=["/data/"])
    vfs.setattr("/data/l", uid=4242, nofollow=True)
    assert vfs.calls[0][2]["nofollow"] is True


@pytest.mark.asyncio
async def test_call_hops_from_a_worker_thread_to_the_workspace_loop():
    dispatch = RecordingDispatch()
    vfs = RuntimeFiles(dispatch, asyncio.get_running_loop())
    data = await asyncio.to_thread(vfs.read, "/data/f.txt")
    assert data == b"payload"
    assert dispatch.seen == [("read", "/data/f.txt")]


@pytest.mark.asyncio
async def test_an_unregistered_op_surfaces_numbered_enotsup():
    dispatch = RecordingDispatch(raises=OperationNotSupportedError("mkdir"))
    vfs = RuntimeFiles(dispatch, asyncio.get_running_loop())
    with pytest.raises(OperationNotSupportedError) as caught:
        await asyncio.to_thread(vfs.mkdir, "/data/sub")
    assert caught.value.errno == errno.ENOTSUP


@pytest.mark.asyncio
async def test_readdir_is_one_hop_that_stats_at_most_the_cap_at_once():
    # On a mount that keeps no listing index every classifying stat is a
    # backend request, so a large directory must not fire them together,
    # nor hold a task per entry while it waits for a slot.
    names = [f"/ram/{i}.json" for i in range(100)]
    in_flight = peak = tasks = 0

    async def dispatch(op, path, **kwargs):
        nonlocal in_flight, peak, tasks
        if op == "readdir":
            return names, None
        in_flight += 1
        peak = max(peak, in_flight)
        tasks = max(tasks, len(asyncio.all_tasks()))
        await asyncio.sleep(0.001)
        in_flight -= 1
        return FileStat(name=path.virtual, size=1, type=FileType.FILE), None

    vfs = RuntimeFiles(dispatch, asyncio.get_running_loop())
    entries = await asyncio.to_thread(vfs.readdir, "/ram/")
    assert [entry.path for entry in entries] == names
    assert peak == LISTING_ENTRY_CONCURRENCY
    assert tasks <= 2 * LISTING_ENTRY_CONCURRENCY + 4
