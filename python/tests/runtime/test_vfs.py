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
import threading

import pytest

from mirage.context import (get_current_session, reset_current_session,
                            set_current_session)
from mirage.observe.context import RecordingScope, record, start_op
from mirage.runtime.errors import CrossMountError
from mirage.runtime.resolver import PrefixResolver
from mirage.runtime.types import VFSEntry, VFSStat
from mirage.runtime.vfs import RuntimeVFS
from mirage.types import DEVICE_NUMBERS_KEY, ContentType, FileStat, FileType
from mirage.utils.errors import OperationNotSupportedError
from mirage.utils.stat_view import CHAR_MODE, DIR_MODE, FILE_MODE, LINK_MODE
from mirage.workspace.session import Session


class ListingVFS(RuntimeVFS):
    """Core double for the readdir lifting: canned listing and stats."""

    def __init__(self, listing, stats, links=()):
        names = set(links)
        super().__init__(dispatch=None,
                         loop=None,
                         resolver=PrefixResolver(lambda: [],
                                                 lambda _dir: names))
        self._listing = list(listing)
        self._stats = dict(stats)
        self.stat_calls = []

    def _raw(self, op, path, **kwargs):
        if op == "readdir":
            return list(self._listing)
        if op == "stat":
            self.stat_calls.append(path)
            st = self._stats.get(path)
            if st is None:
                raise FileNotFoundError(path)
            return st
        raise NotImplementedError(op)


class RecordingVFS(RuntimeVFS):
    """Core with a recorded dispatch, so the routing under test is real."""

    def __init__(self, prefixes=(), no_append=()):
        super().__init__(dispatch=None,
                         loop=None,
                         resolver=PrefixResolver(lambda: list(prefixes)))
        self.calls = []
        self._declines = set(no_append)

    def _raw(self, op, path, **kwargs):
        self.calls.append((op, path, kwargs))
        if op == "append" and self.mount_of(path) in self._declines:
            raise OperationNotSupportedError("append")
        return None


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
    # it itself (WasmVFS._prefixes), because only it has a build tree
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


def test_readdir_lifts_names_into_entries():
    # The TS bridge resolves path/size/isDir once at the door, off the
    # stat index the readdir just populated; python answered bare names
    # and every consumer re-parsed the trailing-slash convention, paying
    # one guest stat per entry for a fact the door already had.
    vfs = ListingVFS(
        listing=["/data/sub/", "/data/a.txt", "/data/ghost.txt"],
        stats={
            "/data/a.txt":
            FileStat(name="a.txt",
                     size=4,
                     type=FileType.FILE,
                     content=ContentType.TEXT),
        },
    )
    assert vfs.readdir("/data/") == [
        VFSEntry(path="/data/sub/", size=0, is_dir=True),
        VFSEntry(path="/data/a.txt",
                 size=4,
                 is_dir=False,
                 mode=FILE_MODE,
                 mtime_ns=0),
        VFSEntry(path="/data/ghost.txt", size=0, is_dir=False),
    ]
    # A slash-marked directory skips the stat; a vanished entry (or a
    # dangling link) rides as a size-0 file instead of failing the
    # whole listing.
    assert vfs.stat_calls == ["/data/a.txt", "/data/ghost.txt"]


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
        VFSEntry(path="/data/sub",
                 size=0,
                 is_dir=True,
                 mode=DIR_MODE,
                 mtime_ns=0),
    ]


def test_readdir_marks_the_names_the_resolver_calls_links():
    # The mark is the name plane's: stat follows a link, so a live link
    # to a file reads as that file and nothing in the row says otherwise.
    vfs = ListingVFS(
        listing=["/data/lnk", "/data/a.txt"],
        stats={
            "/data/lnk":
            FileStat(name="lnk",
                     size=5,
                     type=FileType.FILE,
                     content=ContentType.TEXT),
            "/data/a.txt":
            FileStat(name="a.txt",
                     size=5,
                     type=FileType.FILE,
                     content=ContentType.TEXT),
        },
        links=["lnk"],
    )
    assert vfs.readdir("/data/") == [
        VFSEntry(path="/data/lnk",
                 size=5,
                 is_dir=False,
                 is_link=True,
                 mode=FILE_MODE,
                 mtime_ns=0),
        VFSEntry(path="/data/a.txt",
                 size=5,
                 is_dir=False,
                 mode=FILE_MODE,
                 mtime_ns=0),
    ]


def test_stat_projects_one_struct_for_every_surface():
    # The projection is the door's, so preview1, monty and Emscripten
    # read the same five facts instead of translating a FileStat three
    # ways. mode carries the type bits, which is what a wire with no
    # mode field of its own reads the kind out of.
    vfs = ListingVFS(
        listing=[],
        stats={
            "/data/a.txt":
            FileStat(name="a.txt",
                     size=4,
                     type=FileType.FILE,
                     content=ContentType.TEXT,
                     mode=0o700,
                     modified="2026-07-15T00:00:00Z"),
        },
    )
    st = vfs.stat("/data/a.txt")
    assert st == VFSStat(size=4,
                         is_dir=False,
                         mode=(FILE_MODE & ~0o7777) | 0o700,
                         mtime_ns=st.mtime_ns)
    assert st.mtime_ns > 0


def test_stat_reports_an_unknown_stamp_as_epoch_zero():
    vfs = ListingVFS(listing=[],
                     stats={
                         "/data/a.txt":
                         FileStat(name="a.txt", size=1, type=FileType.FILE)
                     })
    assert vfs.stat("/data/a.txt").mtime_ns == 0


def test_stat_projects_character_type_bits_and_logical_device_numbers():
    vfs = ListingVFS(
        listing=[],
        stats={
            "/dev/zero":
            FileStat(name="zero",
                     type=FileType.CHAR_DEVICE,
                     extra={DEVICE_NUMBERS_KEY: [1, 5]}),
        },
    )
    assert vfs.stat("/dev/zero") == VFSStat(size=0,
                                            is_dir=False,
                                            mode=CHAR_MODE,
                                            mtime_ns=0,
                                            rdev=0x105)


def test_stat_nofollow_asks_the_door_for_the_link_row():
    # lstat is one door question now, not a surface reaching past it:
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
            "/data/a.txt":
            FileStat(name="a.txt",
                     size=4,
                     type=FileType.FILE,
                     content=ContentType.TEXT,
                     mode=0o600,
                     modified="2026-07-15T00:00:00Z"),
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


def test_flush_ships_only_the_delta():
    vfs = RecordingVFS(prefixes=["/data/"])
    vfs.flush("/data/log.txt", 3, 3, b"abcXYZ")
    assert [(op, kwargs.get("data"))
            for op, _, kwargs in vfs.calls] == [("append", b"XYZ")]


def test_flush_falls_back_to_a_whole_write_and_remembers_the_mount():
    vfs = RecordingVFS(prefixes=["/data/"], no_append=["/data"])
    vfs.flush("/data/log.txt", 3, 3, b"abcXYZ")
    vfs.flush("/data/log.txt", 6, 6, b"abcXYZ123")
    ops = [op for op, _, _ in vfs.calls]
    # One failed probe for the mount, not one per call: the second flush
    # goes straight to write.
    assert ops == ["append", "write", "write"]


def test_symlink_sends_the_target_verbatim():
    vfs = RecordingVFS(prefixes=["/data/"])
    vfs.symlink("/data/l", "../up/t.txt")
    assert vfs.calls == [("symlink", "/data/l", {"target": "../up/t.txt"})]


def test_readlink_returns_the_stored_target():

    class LinkVFS(RecordingVFS):

        def _raw(self, op, path, **kwargs):
            super()._raw(op, path, **kwargs)
            return "../up/t.txt"

    assert LinkVFS(prefixes=["/data/"]).readlink("/data/l") == "../up/t.txt"


def test_setattr_passes_every_field_so_the_door_reads_the_whole_set():
    vfs = RecordingVFS(prefixes=["/data/"])
    vfs.setattr("/data/f.txt", mode=0o600, mtime="1970-01-01T00:03:20+00:00")
    assert vfs.calls == [("setattr", "/data/f.txt", {
        "mode": 0o600,
        "uid": None,
        "gid": None,
        "atime": None,
        "mtime": "1970-01-01T00:03:20+00:00",
        "nofollow": False,
    })]


def test_setattr_forwards_nofollow_for_the_dash_h_family():
    vfs = RecordingVFS(prefixes=["/data/"])
    vfs.setattr("/data/l", uid=4242, nofollow=True)
    assert vfs.calls[0][2]["nofollow"] is True


@pytest.mark.asyncio
async def test_call_hops_from_a_worker_thread_to_the_workspace_loop():
    dispatch = RecordingDispatch()
    vfs = RuntimeVFS(dispatch, asyncio.get_running_loop())
    data = await asyncio.to_thread(vfs.read, "/data/f.txt")
    assert data == b"payload"
    assert dispatch.seen == [("read", "/data/f.txt")]


@pytest.mark.asyncio
async def test_an_unregistered_op_surfaces_as_not_implemented():
    dispatch = RecordingDispatch(raises=OperationNotSupportedError("mkdir"))
    vfs = RuntimeVFS(dispatch, asyncio.get_running_loop())
    with pytest.raises(NotImplementedError):
        await asyncio.to_thread(vfs.mkdir, "/data/sub")


class SessionSpyDispatch(RecordingDispatch):
    """Records the session bound inside the dispatched op."""

    def __init__(self):
        super().__init__()
        self.sessions = []

    async def __call__(self, op, path, **kwargs):
        self.sessions.append(get_current_session())
        return await super().__call__(op, path, **kwargs)


@pytest.mark.asyncio
async def test_the_hop_rebinds_the_launch_session_on_a_bare_thread():
    # Monty's tokio workers and wasmtime's run thread carry no Python
    # context, so a bare Thread models them: the op arrives with an
    # empty context and only the VFS's captured session can scope it.
    dispatch = SessionSpyDispatch()
    sess = Session(session_id="agent")
    token = set_current_session(sess)
    try:
        vfs = RuntimeVFS(dispatch, asyncio.get_running_loop())
    finally:
        reset_current_session(token)
    worker = threading.Thread(target=vfs.read, args=("/data/f.txt", ))
    worker.start()
    await asyncio.to_thread(worker.join)
    assert dispatch.sessions == [sess]


class LedgerDispatch(RecordingDispatch):
    """Emits an op event inside the dispatched op, like a backend core."""

    async def __call__(self, op, path, **kwargs):
        record(op, path.virtual, "ram", 7, start_op())
        return await super().__call__(op, path, **kwargs)


@pytest.mark.asyncio
async def test_the_hop_rebinds_the_launch_recorder_on_a_bare_thread():
    # The op ledger is contextvar state exactly like the session: the
    # threads guest calls arrive on never had it, and the loop task
    # run_coroutine_threadsafe schedules gets the loop's context, not
    # the typed line's. Without the rebind a guest's file I/O never
    # reaches ws.fs.records while the same op from a shell line does.
    dispatch = LedgerDispatch()
    scope = RecordingScope()
    try:
        vfs = RuntimeVFS(dispatch, asyncio.get_running_loop())
        worker = threading.Thread(target=vfs.read, args=("/data/f.txt", ))
        worker.start()
        await asyncio.to_thread(worker.join)
    finally:
        scope.close()
    assert [(r.op, r.path) for r in scope.records] == [("read", "/data/f.txt")]


@pytest.mark.asyncio
async def test_a_recorderless_launch_dispatches_unrecorded():
    dispatch = LedgerDispatch()
    vfs = RuntimeVFS(dispatch, asyncio.get_running_loop())
    scope = RecordingScope()
    try:
        worker = threading.Thread(target=vfs.read, args=("/data/f.txt", ))
        worker.start()
        await asyncio.to_thread(worker.join)
    finally:
        scope.close()
    assert scope.records == []


@pytest.mark.asyncio
async def test_a_sessionless_launch_dispatches_unscoped():
    dispatch = SessionSpyDispatch()
    vfs = RuntimeVFS(dispatch, asyncio.get_running_loop())
    worker = threading.Thread(target=vfs.read, args=("/data/f.txt", ))
    worker.start()
    await asyncio.to_thread(worker.join)
    assert dispatch.sessions == [None]
