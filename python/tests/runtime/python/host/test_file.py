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
import gc
import io
import os
import sys
import threading
import weakref

import pytest

from mirage import MountMode, Workspace
from mirage.bridge.sync import handed, run_async_from_sync
from mirage.context import reset_current_session, set_current_session
from mirage.policy import Deny, Policy
from mirage.runtime.handles.constants import READ_CHUNK
from mirage.runtime.python.host.fs import HostFs, os_routing
from mirage.runtime.python.host.open import make_open
from mirage.types import PathSpec
from mirage.vfs.ram import RAMVFS
from tests.fixtures.vfs_io import render

from .conftest import make_ops_with_dir


def _write(ops, path, data):
    asyncio.run(ops.write(path, data))


def _read(ops, path):
    return asyncio.run(ops.read(path))


class TestOpenFile:
    def test_read_text(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", b"hello")
        f = make_open(ops)("/data/dir/f.txt", "r")
        assert f.read() == "hello"
        f.close()

    def test_read_binary(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.bin", b"\x00\x01\x02")
        f = make_open(ops)("/data/dir/f.bin", "rb")
        assert f.read() == b"\x00\x01\x02"
        f.close()

    def test_write_text(self):
        ops, _ = make_ops_with_dir()
        f = make_open(ops)("/data/dir/out.txt", "w")
        f.write("written")
        f.close()
        assert _read(ops, "/data/dir/out.txt") == b"written"

    def test_write_binary(self):
        ops, _ = make_ops_with_dir()
        f = make_open(ops)("/data/dir/out.bin", "wb")
        f.write(b"\xff\xfe")
        f.close()
        assert _read(ops, "/data/dir/out.bin") == b"\xff\xfe"

    def test_context_manager(self):
        ops, _ = make_ops_with_dir()
        with make_open(ops)("/data/dir/ctx.txt", "w") as f:
            f.write("ctx")
        assert _read(ops, "/data/dir/ctx.txt") == b"ctx"

    def test_append(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/app.txt", b"hello")
        with make_open(ops)("/data/dir/app.txt", "a") as f:
            f.write(" world")
        assert _read(ops, "/data/dir/app.txt") == b"hello world"

    @pytest.mark.parametrize(
        "mode, buffering", [("ab", 0), ("ab", -1), ("a+", -1)]
    )
    def test_append_stream_starts_at_end_before_truncate(
        self, mode, buffering
    ):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/app.txt", b"hello")
        with make_open(ops)(
            "/data/dir/app.txt", mode, buffering=buffering
        ) as f:
            assert f.tell() == 5
            assert f.truncate() == 5
        assert _read(ops, "/data/dir/app.txt") == b"hello"

    def test_readline(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/lines.txt", b"line1\nline2\nline3")
        f = make_open(ops)("/data/dir/lines.txt", "r")
        assert f.readline() == "line1\n"
        assert f.readline() == "line2\n"
        f.close()

    def test_iter(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/iter.txt", b"a\nb\nc")
        f = make_open(ops)("/data/dir/iter.txt", "r")
        lines = list(f)
        assert lines == ["a\n", "b\n", "c"]
        f.close()

    def test_seek_tell(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/seek.txt", b"abcdef")
        f = make_open(ops)("/data/dir/seek.txt", "rb")
        f.seek(3)
        assert f.tell() == 3
        assert f.read() == b"def"
        f.close()

    def test_properties(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/p.txt", b"data")
        f = make_open(ops)("/data/dir/p.txt", "r")
        assert f.name == "/data/dir/p.txt"
        assert f.mode == "r"
        assert f.readable() is True
        assert f.writable() is False
        assert f.closed is False
        f.close()
        assert f.closed is True

    def test_write_rejects_read_only_mode(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", b"original")
        f = make_open(ops)("/data/dir/f.txt", "r")
        with pytest.raises(io.UnsupportedOperation, match="not writable"):
            f.write("replacement")
        f.close()
        assert _read(ops, "/data/dir/f.txt") == b"original"

    def test_read_rejects_write_only_mode(self):
        ops, _ = make_ops_with_dir()
        f = make_open(ops)("/data/dir/f.txt", "w")
        with pytest.raises(io.UnsupportedOperation, match="not readable"):
            f.read()
        f.close()

    def test_operations_reject_closed_file(self):
        ops, _ = make_ops_with_dir()
        f = make_open(ops)("/data/dir/f.txt", "w")
        f.close()
        with pytest.raises(ValueError, match="closed file"):
            f.write("late")

    @pytest.mark.parametrize("mode", ["", "rw", "rr", "wx", "r++", "rbt"])
    def test_invalid_mode_is_rejected(self, mode):
        ops, _ = make_ops_with_dir()
        with pytest.raises(ValueError):
            make_open(ops)("/data/dir/f.txt", mode)

    def test_write_mode_truncates_when_opened(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", b"original")
        f = make_open(ops)("/data/dir/f.txt", "w")
        assert _read(ops, "/data/dir/f.txt") == b""
        f.close()

    def test_update_mode_persists_writes(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", b"original")
        with make_open(ops)("/data/dir/f.txt", "r+") as f:
            f.write("changed")
        assert _read(ops, "/data/dir/f.txt") == b"changedl"

    def test_w_plus_truncates_at_open_and_reads_back_its_writes(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", b"original")
        with make_open(ops)("/data/dir/f.txt", "w+") as f:
            assert _read(ops, "/data/dir/f.txt") == b""
            f.write("fresh")
            f.seek(0)
            assert f.read() == "fresh"
        assert _read(ops, "/data/dir/f.txt") == b"fresh"

    def test_a_plus_writes_at_the_end_after_a_seek(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", b"one\n")
        with make_open(ops)("/data/dir/f.txt", "a+") as f:
            f.seek(0)
            assert f.read() == "one\n"
            f.seek(0)
            f.write("two\n")
            f.seek(0)
            assert f.read() == "one\ntwo\n"
        assert _read(ops, "/data/dir/f.txt") == b"one\ntwo\n"

    def test_flush_persists_before_close(self):
        ops, _ = make_ops_with_dir()
        f = make_open(ops)("/data/dir/f.txt", "w")
        f.write("visible")
        f.flush()
        assert _read(ops, "/data/dir/f.txt") == b"visible"
        f.close()

    def test_exclusive_mode_creates_once(self):
        mode = "x"
        ops, _ = make_ops_with_dir()
        with make_open(ops)("/data/dir/f.txt", mode) as f:
            f.write("new")
        assert _read(ops, "/data/dir/f.txt") == b"new"
        with pytest.raises(FileExistsError):
            make_open(ops)("/data/dir/f.txt", mode)
        assert _read(ops, "/data/dir/f.txt") == b"new"

    def test_exclusive_mode_refuses_a_dangling_link(self):
        # O_CREAT|O_EXCL follows no link, so the link's own name is
        # there even though its target is not; creating through it would
        # put a file at the target the open never named.
        ops, _ = make_ops_with_dir()
        asyncio.run(ops.symlink("/data/dir/lnk", "/data/dir/gone"))
        with pytest.raises(FileExistsError):
            make_open(ops)("/data/dir/lnk", "x")
        with pytest.raises(FileNotFoundError):
            _read(ops, "/data/dir/gone")

    def test_a_write_mode_refuses_a_directory(self):
        ops, _ = make_ops_with_dir()
        with pytest.raises(IsADirectoryError):
            make_open(ops)("/data/dir", "w")
        assert asyncio.run(ops.is_dir("/data/dir"))

    def test_a_read_of_a_missing_file_fails_at_open(self):
        # CPython raises at open, not at the first read.
        ops, _ = make_ops_with_dir()
        with pytest.raises(FileNotFoundError):
            make_open(ops)("/data/dir/nope.txt", "r")

    def test_a_create_under_a_missing_directory_carries_its_errno(self):
        # The backend raises a bare FileNotFoundError; the entry point numbers
        # it as open(2) would, so `except OSError as e: e.errno` holds.
        ops, _ = make_ops_with_dir()
        with pytest.raises(FileNotFoundError) as caught:
            make_open(ops)("/data/dir/nope/f.txt", "w")
        assert caught.value.errno == errno.ENOENT

    def test_append_mode_creates_missing_file_on_open(self):
        ops, _ = make_ops_with_dir()
        f = make_open(ops)("/data/dir/f.txt", "a")
        assert _read(ops, "/data/dir/f.txt") == b""
        f.close()

    def test_text_encoding_and_error_policy_are_honored(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", b"caf\xe9")
        with make_open(ops)(
            "/data/dir/f.txt", encoding="ascii", errors="replace"
        ) as f:
            assert f.read() == "caf�"

    def test_the_locale_encoding_sentinel_is_not_a_codec_name(self):
        # What `pathlib.read_text()` passes on any interpreter that is
        # not in UTF-8 mode: io.open reads it as "the platform default",
        # and looking it up as a codec raises LookupError.
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", "caf\u00e9".encode())
        with make_open(ops)("/data/dir/f.txt", encoding="locale") as f:
            assert f.read() == "caf\u00e9"

    def test_the_locale_sentinel_writes_the_same_bytes_as_the_default(self):
        ops, _ = make_ops_with_dir()
        with make_open(ops)("/data/dir/f.txt", "w", encoding="locale") as f:
            f.write("caf\u00e9")
        assert _read(ops, "/data/dir/f.txt") == "caf\u00e9".encode()

    @pytest.mark.parametrize("argument", ["encoding", "errors", "newline"])
    def test_binary_mode_rejects_text_arguments(self, argument):
        ops, _ = make_ops_with_dir()
        with pytest.raises(ValueError, match="binary mode"):
            make_open(ops)("/data/dir/f.txt", "rb", **{argument: "utf-8"})

    def test_an_unbuffered_stream_refuses_what_its_mode_and_state_refuse(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.bin", b"body")
        f = make_open(ops)("/data/dir/f.bin", "rb", buffering=0)
        with pytest.raises(io.UnsupportedOperation):
            f.write(b"X")
        f.close()
        with pytest.raises(ValueError):
            f.read()
        assert _read(ops, "/data/dir/f.bin") == b"body"


async def _read_tally(accessor, path: PathSpec, **kwargs) -> bytes:
    return b"RENDERED"


class TestChunks:
    def test_a_read_only_open_moves_only_the_chunk_it_reads(self):
        # Reading a few bytes of a large file used to fetch all of it.
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/big.txt", b"x" * (3 * READ_CHUNK))
        before = len(ops.records)
        with make_open(ops)("/data/dir/big.txt", "r") as f:
            assert f.read(5) == "xxxxx"
        moved = [r.bytes for r in ops.records[before:] if r.op == "read"]
        assert moved == [READ_CHUNK]

    def test_lines_across_chunks_read_as_the_file_holds_them(self):
        ops, _ = make_ops_with_dir()
        body = b"".join(b"line %d\n" % i for i in range(300_000))
        _write(ops, "/data/dir/lines.txt", body)
        with make_open(ops)("/data/dir/lines.txt", "r") as f:
            assert list(f) == body.decode().splitlines(keepends=True)
        with make_open(ops)("/data/dir/lines.txt", "rb") as f:
            f.seek(-7, 2)
            assert f.read() == b"299999\n"[-7:]

    def test_a_writable_open_starts_from_the_stored_bytes(self):
        # Its flush stores what it holds, so starting from the rendering
        # stored the rendering over the file.
        ws = Workspace(
            {"/data/": render(RAMVFS(), ".tally", _read_tally)},
            mode=MountMode.WRITE,
        )
        _write(ws.vfs, "/data/books.tally", b"STORED")
        with make_open(ws.vfs)("/data/books.tally", "r") as f:
            assert f.read() == "RENDERED"
        with make_open(ws.vfs)("/data/books.tally", "a") as f:
            f.write("+")
        assert asyncio.run(ws.vfs.read("/data/books.tally", raw=True)) == (
            b"STORED+"
        )


class _RetainedReadPolicy(Policy):
    def __init__(self):
        self.stage = None
        self.reads = []

    async def pre_vfs(self, ctx):
        if ctx.call.name == "read":
            self.reads.append(("pre", None))
            if self.stage == "pre":
                return Deny("read sealed")
        return None

    async def post_vfs(self, ctx):
        if ctx.call.name == "read":
            self.reads.append(("post", ctx.result))
            if self.stage == "post":
                return Deny("result sealed")
        return None


@pytest.mark.parametrize("restriction", ["hide", "pre", "post"])
@pytest.mark.parametrize("detached", [False, True])
def test_unbuffered_reads_recheck_retained_bytes_and_preserve_position(
    restriction, detached, monkeypatch
):
    policy = _RetainedReadPolicy()
    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, policies=[policy]
    )
    loop = asyncio.new_event_loop()
    loop.run_until_complete(ws.vfs.write("/data/f", b"secret"))
    session = ws.create_session("reader")
    token = set_current_session(session)
    router = HostFs(ws.vfs, loop)
    stream = make_open(ws.vfs, loop, router)("/data/f", "rb", buffering=0)
    try:
        assert stream.read(1) == b"s"
        assert policy.reads == [("pre", None), ("post", b"secret")]
        if detached:
            router.unlink("/data/f")
            # The first detached fetch reads held bytes through policy too.
            assert stream.read(1) == b"e"
        before = stream.tell()
        policy.reads.clear()
        if restriction == "hide":
            loop.run_until_complete(
                ws.set_session_profile(
                    "reader", {"paths": {"hide": ["/data/f"]}}
                )
            )
        else:
            policy.stage = restriction

        def no_fetch(*args, **kwargs):
            raise AssertionError("retained read reached the backend")

        monkeypatch.setattr(RAMVFS, "read", no_fetch)
        with pytest.raises(OSError) as failure:
            stream.read(2)
        assert failure.value.errno == (
            errno.ENOENT if restriction == "hide" else errno.EACCES
        )
        assert stream.tell() == before
        if restriction == "post":
            assert policy.reads[-1] == ("post", b"secret"[before : before + 2])
        policy.stage = None
        loop.run_until_complete(ws.set_session_profile("reader", {}))
        assert stream.read(2) == b"secret"[before : before + 2]
    finally:
        stream.close()
        reset_current_session(token)
        loop.run_until_complete(ws.close())
        loop.close()


async def _one_turn() -> int:
    return 1


class _Finalizes:
    """Makes calls on a live stream from its finalizer, in a cycle of its
    own, and keeps what each answered, or the class of what it raised."""

    def __init__(self, stream, calls, seen) -> None:
        self.stream = stream
        self.calls = calls
        self.seen = seen
        self.cycle = self

    def __del__(self) -> None:
        for name, *args in self.calls:
            try:
                self.seen.append(getattr(self.stream, name)(*args))
            except Exception as exc:
                self.seen.append(type(exc).__name__)


def _collected(build=None) -> None:
    enabled = gc.isenabled()
    gc.disable()
    try:
        if build is not None:
            build()
        gc.collect()
    finally:
        if enabled:
            gc.enable()


def _drop_in_cycle(stream) -> None:
    cycle = [stream]
    cycle.append(cycle)


def _host(ws, loop):
    """The routed ``os`` calls and ``open`` a program reaches."""
    router = HostFs(ws.vfs, loop)
    return os_routing(router), make_open(ws.vfs, loop, router)


def _landed(ws, loop, path):
    return loop.run_until_complete(ws.vfs.read(path))


@pytest.mark.parametrize(
    "mode,buffering,seed,payload,landed",
    [
        ("wb", 0, b"", b"landed", b"landed"),
        ("ab", -1, b"kept-", b"landed", b"kept-landed"),
        ("w", -1, b"", "landed", b"landed"),
    ],
)
def test_a_stream_the_collector_closes_lands_at_its_loops_next_call(
    monkeypatch, mode, buffering, seed, payload, landed
):
    # The collection runs where run_forever has not yet marked the loop
    # running, after run_until_complete registered its stop: a close
    # driving the loop there would take that stop and the drive would
    # never return. The program runs on a thread only so a regression
    # fails here instead of hanging the suite.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    loop = asyncio.new_event_loop()
    loop.run_until_complete(ws.vfs.write("/data/f", seed))
    _, opener = _host(ws, loop)
    hooks = sys.get_asyncgen_hooks
    armed, driven = threading.Event(), threading.Event()
    dropped: list[weakref.ref] = []
    collected = []
    read = []

    def collecting_hooks():
        if armed.is_set():
            armed.clear()
            gc.collect()
            collected.append(dropped[0]() is None)
        return hooks()

    def program() -> None:
        stream = opener("/data/f", mode, buffering=buffering)
        stream.write(payload)
        dropped.append(weakref.ref(stream))
        _drop_in_cycle(stream)
        del stream
        collected.append(dropped[0]() is None)
        armed.set()
        assert run_async_from_sync(_one_turn(), loop) == 1
        read.append(run_async_from_sync(ws.vfs.read("/data/f"), loop))
        driven.set()

    enabled = gc.isenabled()
    gc.disable()
    monkeypatch.setattr(sys, "get_asyncgen_hooks", collecting_hooks)
    try:
        threading.Thread(target=program, daemon=True).start()
        assert driven.wait(10)
    finally:
        monkeypatch.undo()
        if enabled:
            gc.enable()
    assert collected == [False, True]
    assert read == [landed]
    loop.run_until_complete(ws.close())
    loop.close()


def test_a_collected_stream_lands_at_the_next_call_on_a_running_owner():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    enabled = gc.isenabled()
    gc.disable()
    try:
        with ws:
            stream = open("/data/f", "wb")
            stream.write(b"landed")
            _drop_in_cycle(stream)
            del stream
            gc.collect()
            with open("/data/f", "rb") as reader:
                assert reader.read() == b"landed"
    finally:
        if enabled:
            gc.enable()


def test_a_collected_stream_with_no_shared_loop_closes_in_place():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    stream = make_open(ws.vfs)("/data/f", "wb", buffering=0)
    stream.write(b"landed")
    _drop_in_cycle(stream)
    del stream
    _collected()
    assert asyncio.run(ws.vfs.read("/data/f")) == b"landed"


def _shared_fd(ws, loop):
    """An fd holding ``before-``, a live stream over it, and two collected
    buffered streams over it whose ``one-`` and ``two-`` wait to land."""
    routed, opener = _host(ws, loop)
    fd = routed["open"]("/data/log", os.O_WRONLY | os.O_CREAT)
    routed["write"](fd, b"before-")
    live = opener(fd, "wb", buffering=0, closefd=False)
    siblings = [opener(fd, "wb", closefd=False) for _ in range(2)]
    siblings[0].write(b"one-")
    siblings[1].write(b"two-")
    for _ in range(2):
        _drop_in_cycle(siblings.pop(0))
        _collected()
    return routed, fd, live


def test_collected_streams_over_an_fd_land_in_order_before_its_next_write():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    loop = asyncio.new_event_loop()
    routed, fd, _ = _shared_fd(ws, loop)
    routed["write"](fd, b"after")
    routed["close"](fd)
    assert _landed(ws, loop, "/data/log") == b"before-one-two-after"
    loop.run_until_complete(ws.close())
    loop.close()


def test_a_bare_truncate_keeps_what_collected_streams_over_its_fd_wrote():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    loop = asyncio.new_event_loop()
    routed, fd, live = _shared_fd(ws, loop)
    assert live.truncate() == len(b"before-one-two-")
    live.close()
    routed["close"](fd)
    assert _landed(ws, loop, "/data/log") == b"before-one-two-"
    loop.run_until_complete(ws.close())
    loop.close()


def test_a_finalizer_cannot_reach_the_loop_through_a_live_stream():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    loop = asyncio.new_event_loop()
    _, opener = _host(ws, loop)
    log = opener("/data/log", "wb", buffering=0)
    log.write(b"before-")
    seen = []
    _collected(lambda: _Finalizes(log, [("write", b"during-")], seen))
    assert seen == ["RuntimeError"]
    log.write(b"after")
    log.close()
    assert _landed(ws, loop, "/data/log") == b"before-after"
    loop.run_until_complete(ws.close())
    loop.close()


def test_a_finalizer_writes_into_a_live_streams_buffer():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    loop = asyncio.new_event_loop()
    _, opener = _host(ws, loop)
    log = opener("/data/log", "wb")
    log.write(b"before-")
    seen = []
    _collected(lambda: _Finalizes(log, [("write", b"during-")], seen))
    assert seen == [7]
    log.write(b"after")
    log.close()
    assert _landed(ws, loop, "/data/log") == b"before-during-after"
    loop.run_until_complete(ws.close())
    loop.close()


@pytest.mark.parametrize("call", [("close",), ("flush",)])
def test_a_finalizer_cannot_close_or_flush_a_live_stream(call):
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    loop = asyncio.new_event_loop()
    _, opener = _host(ws, loop)
    log = opener("/data/log", "wb", buffering=0)
    log.write(b"before-")
    seen = []
    _collected(lambda: _Finalizes(log, [call], seen))
    assert seen == ["RuntimeError"]
    log.write(b"after")
    log.close()
    assert _landed(ws, loop, "/data/log") == b"before-after"
    loop.run_until_complete(ws.close())
    loop.close()


def test_a_collected_stream_over_an_fd_it_leaves_open_lands_its_bytes():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    loop = asyncio.new_event_loop()
    routed, opener = _host(ws, loop)
    fd = routed["open"]("/data/log", os.O_WRONLY | os.O_CREAT)
    routed["write"](fd, b"before-")
    stream = opener(fd, "wb", closefd=False)
    stream.write(b"landed")
    _drop_in_cycle(stream)
    del stream
    _collected()
    loop.run_until_complete(handed())
    assert _landed(ws, loop, "/data/log") == b"before-landed"
    routed["close"](fd)
    loop.run_until_complete(ws.close())
    loop.close()


async def _failing_write(*args):
    raise OSError(errno.ENOSPC, "no space")


def test_a_collected_stream_lets_its_handle_go_when_a_last_write_fails(
    monkeypatch,
):
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    loop = asyncio.new_event_loop()
    _, opener = _host(ws, loop)
    stream = opener("/data/f", "wb")
    stream.write(b"lost")
    handle = stream.raw._handle
    core, fh = handle.files._core, handle.fh
    monkeypatch.setattr(core, "write", _failing_write)
    _drop_in_cycle(stream)
    del stream
    _collected()
    loop.run_until_complete(handed())
    assert fh not in core.handles
    loop.run_until_complete(ws.close())
    loop.close()
