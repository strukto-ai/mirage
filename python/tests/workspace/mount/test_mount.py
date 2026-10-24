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
from collections.abc import AsyncIterator
from types import MappingProxyType

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.cache.context import read_versioned
from mirage.commands.builtin.generic_bind import generic
from mirage.commands.config import Context, command
from mirage.commands.spec import CommandSpec
from mirage.commands.spec.types import Argument
from mirage.errors.types import OperationNotSupportedError
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.observe.context import (
    RecordingScope,
    command_records,
    record_stream,
)
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.files import Files
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.mount import MountEntry
from tests.fixtures.mount_commands import run_on_mount


def _run(coro):
    return asyncio.run(coro)


# ── prefix validation ──────────────────────────


def test_mount_accepts_root_prefix():
    m = MountEntry("/", RAMVFS())
    assert m.prefix == "/"


def test_mount_rejects_no_leading_slash():
    with pytest.raises(ValueError, match="must start with /"):
        MountEntry("data/", RAMVFS())


def test_mount_rejects_no_trailing_slash():
    with pytest.raises(ValueError, match="must end with /"):
        MountEntry("/data", RAMVFS())


def test_mount_rejects_double_slash():
    with pytest.raises(ValueError, match="must not contain //"):
        MountEntry("/data//sub/", RAMVFS())


def test_mount_valid_prefix():
    m = MountEntry("/data/", RAMVFS())
    assert m.prefix == "/data/"


class MisnamedRenderer(RAMVFS):
    renderers = MappingProxyType({".doc": "render_doc"})


def test_mount_rejects_a_renderer_that_names_no_method():
    with pytest.raises(TypeError, match="'render_doc', which is not a method"):
        MountEntry("/data/", MisnamedRenderer())


class _Stale:
    async def write_stream(self, path, data):
        return None


class _Mixed(_Stale, RAMVFS):
    pass


# A method folded into read, write or append would never be called, so a
# VFS that still has one, its own or a mixin's, is refused as it is mounted.
@pytest.mark.parametrize(
    "name", ["read_stream", "write_stream", "append_stream"]
)
def test_mount_rejects_a_folded_method(name):
    old = type("Old", (RAMVFS,), {name: lambda self, path: None})
    with pytest.raises(TypeError, match=f"Old.{name}: define "):
        MountEntry("/data/", old())


def test_mount_rejects_a_folded_method_from_a_mixin():
    with pytest.raises(TypeError, match="_Mixed.write_stream: define write"):
        MountEntry("/data/", _Mixed())


# ── read-only enforcement ──────────────────────


@pytest.mark.asyncio
async def test_read_only_blocks_write_cmd():
    ws = Workspace({"/ro/": (RAMVFS(), MountMode.READ)}, mode=MountMode.WRITE)
    io = await ws.shell("mkdir /ro/newdir")
    assert io.exit_code != 0
    assert await io.materialize_stderr() == (
        b"mkdir: cannot create directory '/ro/newdir': Read-only file system\n"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", [MountMode.READ, MountMode.WRITE])
@pytest.mark.parametrize("declared", [False, True])
@pytest.mark.parametrize("flag", ["help", "version"])
async def test_only_wrapper_responses_bypass_the_write_guard(
    mode, declared, flag
):
    vfs = RAMVFS()
    mount = MountEntry("/ram/", vfs, mode)
    calls: list[str] = []
    options = (Argument(f"--{flag}", action="store_true"),) if declared else ()

    @command(
        "mutate",
        vfs="ram",
        spec=CommandSpec(arguments=(*options,)),
        write=True,
    )
    async def mutate(accessor: RAMAccessor, paths, texts, opts):
        calls.append("handler")
        accessor.store.files["/changed"] = b"changed"
        return b"custom version\n", IOResult()

    mount.register_commands([mutate])
    stdout, io = await mount.run_command("mutate", [], [], {flag: True})
    output = await materialize(stdout)
    # A declared --help is still answered by the decorator's wrapper, but
    # the guard reads only the spec, so a read-only mount refuses it.
    if declared and mode == MountMode.READ:
        assert io.exit_code == 1
        assert io.stderr == b"mutate: read-only mount at /ram/\n"
        assert not calls
        assert "/changed" not in vfs.accessor.store.files
    elif declared and flag == "version":
        assert io.exit_code == 0
        assert output == b"custom version\n"
        assert calls == ["handler"]
        assert vfs.accessor.store.files["/changed"] == b"changed"
    else:
        assert io.exit_code == 0
        assert output
        assert not calls
        assert "/changed" not in vfs.accessor.store.files


@command(
    "cat",
    vfs="ram",
    spec=CommandSpec(arguments=(Argument("path", type="path"),)),
)
async def handed_cat(accessor: RAMAccessor, paths, texts, opts):
    return b"handed\n", IOResult()


@command(
    "peek",
    vfs="ram",
    spec=CommandSpec(arguments=(Argument("path", type="path"),)),
)
async def handed_peek(accessor: RAMAccessor, paths, texts, ctx):
    return await ctx.vfs.read(paths[0]), IOResult()


class HandedRAM(RAMVFS):
    def commands(self):
        return [handed_cat, handed_peek]


@pytest.mark.asyncio
async def test_a_handed_command_runs_where_the_session_restricts():
    # Mirage cannot see what a handler reads through its own accessor, so
    # it does not try: a hide covers what the handler reads through
    # ctx.vfs.
    profiles = {
        "here": {"paths": {"hide": ["/data/secret"]}},
        "elsewhere": {"paths": {"hide": ["/other/x"]}},
    }
    ws = Workspace(
        {"/data/": HandedRAM(), "/other/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles=profiles,
    )
    try:
        await ws.shell("echo hi > /data/n.txt; echo s > /data/secret")
        for sid in profiles:
            ws.create_session(sid, profile=sid)
        for sid, line, out, err, code in (
            (None, "cat /data/n.txt", b"handed\n", b"", 0),
            ("here", "cat /data/n.txt", b"handed\n", b"", 0),
            ("here", "peek /data/n.txt", b"hi\n", b"", 0),
            ("elsewhere", "peek /data/secret", b"s\n", b"", 0),
            (
                "here",
                "peek /data/secret",
                b"",
                b"peek: /data/secret: No such file or directory\n",
                1,
            ),
        ):
            io = await ws.shell(line, session_id=sid)
            got = (
                await io.materialize_stdout(),
                await io.materialize_stderr(),
                io.exit_code,
            )
            assert got == (out, err, code), (sid, line)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_the_read_only_refusal_is_newline_terminated():
    # stderr accumulates across a line, so an unterminated refusal ran
    # into the next one: `{ sync /ro/a; sync /ro/b; }` printed the single
    # line `sync: read-only mount at /ro/sync: read-only mount at /ro/`.
    mount = MountEntry("/ro/", RAMVFS(), MountMode.READ)

    @command("sync", vfs="ram", spec=CommandSpec(), write=True)
    async def sync(accessor: RAMAccessor, paths, texts, opts):
        return None, IOResult()

    mount.register_commands([sync])
    _, io = await mount.run_command("sync", [], [], {})
    assert io.stderr == b"sync: read-only mount at /ro/\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", [MountMode.READ, MountMode.WRITE])
@pytest.mark.parametrize("builtin", [False, True])
async def test_only_a_write_command_the_dispatcher_cannot_see_is_refused_up_front(
    mode, builtin
):
    # The dispatcher refuses a builtin's writes, not a user command's.
    vfs = RAMVFS()
    mount = MountEntry("/ram/", vfs, mode)
    calls: list[int] = []

    @command("filter", vfs="ram", spec=CommandSpec(), write=True)
    async def filter_cmd(accessor: RAMAccessor, paths, texts, opts):
        calls.append(len(paths))
        return b"ran\n", IOResult()

    if builtin:
        mount._register_builtins([filter_cmd])
    else:
        mount.register_commands([filter_cmd])
    paths = [PathSpec.from_str_path("/ram/a")]
    stdout, io = await mount.run_command("filter", paths, [], {})
    if mode == MountMode.READ and not builtin:
        assert io.exit_code == 1
        assert io.stderr == b"filter: read-only mount at /ram/\n"
        assert not calls
    else:
        assert io.exit_code == 0
        assert await materialize(stdout) == b"ran\n"
        assert calls == [1]


async def _stat_tally(p: str | PathSpec) -> FileStat:
    name = p if isinstance(p, str) else p.virtual
    if name.endswith("dir.tally"):
        return FileStat(name=name, type=FileType.DIRECTORY)
    return FileStat(name=name, type=FileType.FILE, size=4)


@pytest.mark.asyncio
async def test_a_directory_does_not_route_to_a_filetype_handler():
    # A filetype handler is chosen from the operand's NAME, and a
    # directory can carry any extension, so without a type check `cat`
    # on a directory named `dir.tally` runs the renderer, which reads
    # bytes that are not there and reports ENOENT: registering a
    # renderer made the command worse than the built-in it replaced.
    mount = MountEntry("/", RAMVFS(), MountMode.WRITE)
    fired: list[str] = []
    builtins: list[str] = []

    @command("cat", vfs="ram", spec=CommandSpec())
    async def plain(accessor: RAMAccessor, paths, texts, opts):
        builtins.append(paths[0].virtual)
        return None, IOResult()

    @command("cat", vfs="ram", spec=CommandSpec(), filetype=".tally")
    async def typed(accessor: RAMAccessor, paths, texts, opts):
        fired.append(paths[0].virtual)
        return b"rendered\n", IOResult()

    mount.register_commands([plain, typed])

    async def dispatch(name: str, path: PathSpec, /, **_kw):
        assert name == "stat"
        return await _stat_tally(path), IOResult()

    context = Context(vfs=Files(dispatch, ledger=False))
    await mount.run_command(
        "cat", [PathSpec.from_str_path("/dir.tally")], [], {}, context
    )
    assert fired == []
    assert builtins == ["/dir.tally"]

    await mount.run_command(
        "cat", [PathSpec.from_str_path("/file.tally")], [], {}, context
    )
    assert fired == ["/file.tally"]


@pytest.mark.asyncio
async def test_write_mode_allows_write_cmd():
    ws = Workspace({"/rw/": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    io = await ws.shell("mkdir /rw/newdir")
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_a_command_with_no_workspace_files_is_refused():
    # A generic reaches files only through its line's own; run bare, none.
    ram = RAMVFS()
    reg = MountRegistry()
    reg.mount("/rw/", ram, MountMode.WRITE)
    mount = reg.mount_for("/rw/f")
    scope = PathSpec.from_str_path("/rw/f")
    stdout, io = await mount.run_command(
        "tee", [scope], [], {}, Context(stdin=b"x")
    )
    assert stdout is None
    assert (io.exit_code, io.stderr) == (1, b"tee: no workspace files\n")
    assert "/f" not in ram._store.files


def test_read_only_allows_read_cmd():
    ws = Workspace({"/ro/": (RAMVFS(), MountMode.READ)})
    scope = PathSpec(
        vfs_path="ro", virtual="/ro/", directory="/ro/", resolved=False
    )
    _, io = _run(run_on_mount(ws, "ls", [scope]))
    assert io.exit_code == 0


# ── run_command ────────────────────────────────


def test_execute_cmd_cat(ram_vfs):
    ws = Workspace({"/data/": (ram_vfs, MountMode.WRITE)})
    scope = PathSpec.from_str_path("/data/hello.txt")
    stdout, io = _run(run_on_mount(ws, "cat", [scope]))
    assert io.exit_code == 0
    assert stdout


def test_execute_cmd_not_found(registry):
    mount = registry.mount_for("/data/hello.txt")
    stdout, io = _run(mount.run_command("nonexistent_cmd", [], [], {}))
    assert io.exit_code == 127
    assert b"command not found" in io.stderr


def test_execute_cmd_ls(ram_vfs):
    ws = Workspace({"/data/": (ram_vfs, MountMode.WRITE)})
    scope = PathSpec(
        vfs_path="data", virtual="/data/", directory="/data/", resolved=False
    )
    _, io = _run(run_on_mount(ws, "ls", [scope]))
    assert io.exit_code == 0


def test_execute_cmd_with_flag_kwargs(ram_vfs):
    ws = Workspace({"/data/": (ram_vfs, MountMode.WRITE)})
    scope = PathSpec.from_str_path("/data/hello.txt")
    _, io = _run(run_on_mount(ws, "cat", [scope], flags={"n": True}))
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_execute_cmd_with_texts(ram_vfs):
    ws = Workspace({"/data/": (ram_vfs, MountMode.WRITE)})
    scope = PathSpec.from_str_path("/data/hello.txt")
    stdout, io = await run_on_mount(ws, "grep", [scope], ["hello"])
    assert b"hello" in stdout
    assert io.exit_code == 0


# ── call ─────────────────────────────────


def test_execute_op_stat(registry):
    mount = registry.mount_for("/data/hello.txt")
    result = _run(mount.call("stat", "/hello.txt"))
    assert result is not None
    assert result.size > 0


def test_execute_op_readdir(registry):
    mount = registry.mount_for("/data/")
    result = _run(mount.call("readdir", "/"))
    assert isinstance(result, list)
    assert len(result) > 0


def test_execute_op_no_such_op(registry):
    mount = registry.mount_for("/data/hello.txt")
    with pytest.raises(OperationNotSupportedError, match="no op") as exc_info:
        _run(mount.call("nonexistent_op", "/file.txt"))
    assert exc_info.value.filename == "/file.txt"
    assert exc_info.value.errno == errno.ENOTSUP


# ── command resolution ─────────────────────────


def test_resolve_command_exists(registry):
    mount = registry.mount_for("/data/hello.txt")
    cmd = mount.resolve_command("cat")
    assert cmd is not None
    assert cmd.name == "cat"


def test_resolve_command_missing(registry):
    mount = registry.mount_for("/data/hello.txt")
    cmd = mount.resolve_command("nonexistent")
    assert cmd is None


@command("cat", vfs=None, spec=CommandSpec(), filetype=".csv")
async def csv_cat(accessor, paths, texts, opts):
    return b"", IOResult()


def test_a_filetype_command_added_later_keeps_the_generic(registry):
    mount = registry.mount_for("/data/hello.txt")
    mount.register_commands([csv_cat])
    assert mount.resolve_command("cat", ".csv").fn is csv_cat
    assert mount.resolve_command("cat", ".txt") is generic("cat")


@command(
    "summarize",
    vfs=None,
    spec=CommandSpec(
        arguments=(Argument("paths", type="path", nargs="*", metavar=""),)
    ),
    filetype=".csv",
)
async def csv_summary(accessor, paths, texts, opts):
    return b"ok", IOResult()


@pytest.mark.asyncio
async def test_a_command_for_one_filetype_runs_only_on_that_filetype():
    ws = Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo hit > /ram/x.csv; echo hit > /ram/x.txt")
    ws.mount("/ram/").register_commands([csv_summary])
    csv = await ws.shell("summarize /ram/x.csv")
    txt = await ws.shell("summarize /ram/x.txt")
    assert (csv.exit_code, await csv.stdout_str()) == (0, "ok")
    assert (txt.exit_code, await txt.materialize_stderr()) == (
        127,
        b"summarize: command not found",
    )


@pytest.mark.asyncio
async def test_a_builtin_write_command_is_held_at_its_write():
    vfs = RAMVFS()
    vfs._store.files["/a"] = b"original"
    ws = Workspace({"/ram/": (vfs, MountMode.READ)}, mode=MountMode.WRITE)
    # The write is refused where it happens and gzip says so in its own
    # words (the fatal write_error form), leaving the store untouched.
    io = await ws.shell("gzip /ram/a")
    assert (io.exit_code, await io.materialize_stderr()) == (
        1,
        b"\ngzip: /ram/a.gz: Read-only file system\n",
    )
    assert vfs._store.files == {"/a": b"original"}


@pytest.mark.asyncio
async def test_closing_command_output_finalizes_its_source():
    mount = MountEntry("/", RAMVFS(), MountMode.WRITE)
    io = IOResult(exit_code=1)

    @command("streaming", vfs="ram", spec=CommandSpec())
    async def streaming(accessor: RAMAccessor, paths, texts, opts):
        async def source():
            try:
                yield b"first\n"
                yield b"second\n"
            finally:
                io.exit_code = 0
                io.stderr = b"finished\n"

        return source(), io

    mount.register_commands([streaming])
    output, result = await mount.run_command("streaming", [], [], {})
    assert await anext(output) == b"first\n"
    await output.aclose()
    assert result.exit_code == 0
    assert result.stderr == b"finished\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("started", [False, True])
async def test_native_output_close_joins_producer_and_releases_mount(started):
    closed = asyncio.Event()

    @command("writer", vfs="ram", spec=CommandSpec())
    async def writer(accessor, paths, texts, opts):
        return _HeldSource(b"prefix", closed.set), IOResult()

    mount = MountEntry("/", RAMVFS(), MountMode.WRITE)
    mount.register_commands([writer])
    output, _ = await mount.run_command("writer", [], [], {})
    if started:
        assert await anext(output) == b"prefix"
    await asyncio.wait_for(output.aclose(), 1)
    assert closed.is_set()
    await asyncio.wait_for(mount.activity.wait(), 1)


class _HeldSource:
    """Yields its bytes once, then waits until it is closed, once."""

    def __init__(self, data, on_close):
        self._data = data
        self._on_close = on_close

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._data:
            data, self._data = self._data, b""
            return data
        await asyncio.Event().wait()

    async def aclose(self):
        if self._on_close is not None:
            self._on_close()
            self._on_close = None


class _OpenStream:
    """A stream that holds something open before it is pulled."""

    def __init__(self) -> None:
        self.closed = 0

    def __aiter__(self) -> "_OpenStream":
        return self

    async def __anext__(self) -> bytes:
        return b"x\n"

    async def aclose(self) -> None:
        self.closed += 1


class _EagerFollow(RAMVFS):
    def __init__(self) -> None:
        super().__init__()
        self.opened = _OpenStream()

    async def follow(self, path: PathSpec, n: int, interval: float):
        return self.opened


@pytest.mark.asyncio
async def test_a_stream_closed_before_its_first_pull_closes_its_source():
    vfs = _EagerFollow()
    mount = MountEntry("/", vfs, MountMode.WRITE)
    stream = await mount.call("follow", "/a.txt", 1, 1.0)
    await stream.aclose()
    assert vfs.opened.closed >= 1


@pytest.mark.asyncio
async def test_a_pulled_stream_closes_its_source_once_through_the_wrappers():
    vfs = _EagerFollow()
    mount = MountEntry("/", vfs, MountMode.WRITE)
    stream = await mount.call("follow", "/a.txt", 1, 1.0)
    assert await anext(stream) == b"x\n"
    await stream.aclose()
    assert vfs.opened.closed >= 1


# ── user writes past the dispatcher ──────────────────────────


async def _stamp(accessor, paths, texts, ctx):
    accessor.store.files["/a.txt"] = b"v2\n"
    return None, IOResult()


@pytest.mark.asyncio
@pytest.mark.parametrize("write", [True, False])
async def test_a_user_write_drops_only_its_own_mounts_caches(write):
    one, two = RAMVFS(), RAMVFS()
    for vfs, key in ((one, "/a.txt"), (two, "/b.txt")):
        vfs.caches_reads = True
        vfs.accessor.store.files[key] = b"v1\n"
    ws = Workspace({"/one/": one, "/two/": two}, mode=MountMode.WRITE)
    try:
        stamp = command("stamp", vfs=None, spec=CommandSpec(), write=write)
        ws.mount("/one/").register_commands([stamp(_stamp)])
        await ws.shell("cat /one/a.txt /two/b.txt")
        two.accessor.store.files["/b.txt"] = b"v2\n"
        assert (await ws.shell("cd /one && stamp")).exit_code == 0
        own = (await ws.shell("cat /one/a.txt")).stdout
        other = (await ws.shell("cat /two/b.txt")).stdout
        assert (own, other) == (b"v2\n" if write else b"v1\n", b"v1\n")
    finally:
        await ws.close()


async def _versioned(data: bytes, path: PathSpec) -> AsyncIterator[bytes]:
    rec = record_stream("read", path.virtual, "ram")
    if rec is not None:
        rec.fingerprint = "v1"
    yield data


class _VersionedStream(RAMVFS):
    """Answers a whole read with a stream that records its version."""

    async def read(
        self, path: PathSpec, offset: int = 0, size: int | None = None
    ) -> ByteSource:
        if offset or size is not None:
            return await super().read(path, offset, size)
        return _versioned(await super().read(path), path)


# A read-modify-write sends the version of the bytes it read, so a whole
# read collected from a stream carries the version the stream recorded.
@pytest.mark.asyncio
async def test_a_collected_stream_hands_its_version_to_the_bytes():
    vfs = _VersionedStream()
    vfs._store.files["/f"] = b"old"
    ws = Workspace({"/m": vfs}, mode=MountMode.WRITE)
    try:
        mount = ws.mount("/m")
        data, version = await read_versioned(
            PathSpec.from_str_path("/m/f"), lambda: mount.call("read", "/m/f")
        )
        assert (data, version) == (b"old", "v1")
    finally:
        await ws.close()


# A rewrite's write proves the copy it extends by the read before it, so a
# read collected from a stream leaves its record in the block around it.
@pytest.mark.asyncio
async def test_a_collected_read_stays_in_the_records_around_it():
    vfs = _VersionedStream()
    vfs._store.files["/f"] = b"old"
    ws = Workspace({"/m": vfs}, mode=MountMode.WRITE)
    scope = RecordingScope()
    try:
        with command_records() as mine:
            await ws.mount("/m").call("read", "/m/f")
        assert ("read", "v1") in [(r.op, r.fingerprint) for r in mine]
    finally:
        scope.close()
        await ws.close()


class _Racing(RAMVFS):
    """Numbers each whole read's version and holds the first one open
    until ``gate`` is set."""

    def __init__(self) -> None:
        super().__init__()
        self.calls = 0
        self.started = asyncio.Event()
        self.gate = asyncio.Event()

    async def read(
        self, path: PathSpec, offset: int = 0, size: int | None = None
    ) -> ByteSource:
        if offset or size is not None:
            return await super().read(path, offset, size)
        self.calls += 1
        if self.calls == 1:
            self.started.set()
        return self._numbered(path, self.calls)

    async def _numbered(self, path: PathSpec, n: int) -> AsyncIterator[bytes]:
        rec = record_stream("read", path.virtual, "ram")
        if rec is not None:
            rec.fingerprint = f"v{n}"
        if n == 1:
            await self.gate.wait()
        yield f"bytes{n}".encode()


# Two reads of one file in one command share its records; the one that
# finishes last still labels its bytes with its own version.
@pytest.mark.asyncio
async def test_parallel_collected_reads_keep_their_own_versions():
    vfs = _Racing()
    vfs._store.files["/f"] = b"x"
    ws = Workspace({"/m": vfs}, mode=MountMode.WRITE)
    mount = ws.mount("/m")
    path = PathSpec.from_str_path("/m/f")
    scope = RecordingScope()
    try:
        with command_records():
            first = asyncio.create_task(
                read_versioned(path, lambda: mount.call("read", "/m/f"))
            )
            await vfs.started.wait()
            second = await read_versioned(
                path, lambda: mount.call("read", "/m/f")
            )
            vfs.gate.set()
            older = await first
        assert (older, second) == ((b"bytes1", "v1"), (b"bytes2", "v2"))
    finally:
        scope.close()
        await ws.close()
