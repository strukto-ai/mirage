import errno

import pytest

from mirage.commands.builtin.generic.tee import (
    TeeFlags,
    parse_flags,
    tee_generic,
)
from mirage.io.stream import materialize
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _spec(path: str) -> PathSpec:
    return PathSpec.from_str_path(path)


class _SdkError(Exception):
    """What a remote backend actually raises on a failed write.

    ``core/s3/write.py`` forwards botocore's ``ClientError`` and
    ``core/gridfs/write.py`` pymongo's ``PyMongoError`` straight out of
    ``put_object`` / ``upload_from_stream``; neither is an ``OSError``.
    The TypeScript sink rejects with a plain ``Error`` for the same
    reason, so both suites drive the loop with a non-filesystem failure.
    """


def _sink(fail: frozenset[str] = frozenset()):
    written: dict[str, bytes] = {}

    async def _write(p, d):
        if p.mount_path in fail:
            raise _SdkError("disk full")
        written[p.mount_path] = d

    return written, _write


async def _empty(_p):
    if False:
        yield b""


@pytest.mark.parametrize(
    "mode,stop",
    [("warn-nopipe", False), ("exit", True), (True, False)],
)
def test_parse_flags_reads_the_exit_warn_axis(mode, stop):
    # Only the exit/warn axis is observable: the -nopipe half tells a pipe
    # sink from a file sink, and every operand tee writes is a file. A
    # bare --output-error means warn (GNU 9.7).
    assert parse_flags({"output_error": mode}) == TeeFlags(stop_on_error=stop)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error",
    [OSError("disk full"), _SdkError("An error occurred (AccessDenied)")],
)
async def test_a_write_error_is_diagnosed_and_stdout_still_copied(error):
    async def _write(_p, _d):
        raise error

    source, io = await tee_generic(
        [_spec("/a.txt"), _spec("/b.txt")],
        (),
        read_stream=_empty,
        write_bytes=_write,
        stdin=b"hello",
        flags={},
    )
    assert await materialize(source) == b"hello"
    assert io.exit_code == 1
    assert await materialize(io.stderr) == (
        f"tee: /a.txt: {error}\ntee: /b.txt: {error}\n".encode()
    )


@pytest.mark.asyncio
async def test_every_operand_is_written_and_reported():
    # GNU 9.7: `printf x | tee a b c` puts x in all three. Both generics
    # used to write paths[0] and silently drop the rest, while the spec
    # declared a variadic rest operand.
    written, write = _sink()
    source, io = await tee_generic(
        [_spec("/a"), _spec("/b"), _spec("/c")],
        (),
        read_stream=_empty,
        write_bytes=write,
        stdin=b"hi",
        flags={},
    )
    assert written == {"/a": b"hi", "/b": b"hi", "/c": b"hi"}
    assert await materialize(source) == b"hi"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_one_bad_operand_does_not_stop_the_others():
    # GNU pins: `tee p bad q` writes p and q, diagnoses bad, exits 1.
    written, write = _sink(frozenset({"/bad"}))
    source, io = await tee_generic(
        [_spec("/p"), _spec("/bad"), _spec("/q")],
        (),
        read_stream=_empty,
        write_bytes=write,
        stdin=b"x",
        flags={},
    )
    assert written == {"/p": b"x", "/q": b"x"}
    assert io.exit_code == 1
    assert await materialize(io.stderr) == b"tee: /bad: disk full\n"
    assert await materialize(source) == b"x"


@pytest.mark.asyncio
async def test_output_error_exit_stops_at_the_first_failure():
    written, write = _sink(frozenset({"/bad"}))
    _source, io = await tee_generic(
        [_spec("/p"), _spec("/bad"), _spec("/q")],
        (),
        read_stream=_empty,
        write_bytes=write,
        stdin=b"x",
        flags={"output_error": "exit"},
    )
    assert written == {"/p": b"x"}
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_an_output_that_fails_to_empty_is_the_one_reported():
    written, write = _sink(frozenset({"/denied"}))

    async def _stat(p: PathSpec) -> FileStat:
        kind = FileType.DIRECTORY if p.virtual == "/dir" else FileType.FILE
        return FileStat(name=p.virtual[1:], type=kind)

    source, io = await tee_generic(
        [_spec("/good"), _spec("/denied"), _spec("/dir")],
        (),
        read_stream=_empty,
        write_bytes=write,
        stdin=b"x",
        flags={"output_error": "exit"},
        stat=_stat,
    )
    assert source is None
    assert written == {"/good": b""}
    assert io.exit_code == 1
    assert await materialize(io.stderr) == b"tee: /denied: disk full\n"


@pytest.mark.asyncio
async def test_a_refused_probe_leaves_the_open_to_the_write():
    written, write = _sink()

    async def _stat(p: PathSpec) -> FileStat:
        if p.virtual == "/locked":
            raise PermissionError(errno.EACCES, "Permission denied")
        return FileStat(name=p.virtual[1:], type=FileType.FILE)

    source, io = await tee_generic(
        [_spec("/good"), _spec("/locked")],
        (),
        read_stream=_empty,
        write_bytes=write,
        stdin=b"x",
        flags={"output_error": "exit"},
        stat=_stat,
    )
    assert await materialize(source) == b"x"
    assert written == {"/good": b"x", "/locked": b"x"}
    assert io.exit_code == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "outputs,append,refused,written,stderr",
    [
        (
            ["/good", "/locked"],
            False,
            {"/locked"},
            {"/good": b""},
            b"tee: /locked: disk full\n",
        ),
        (
            ["/locked", "/gone/x"],
            True,
            set(),
            {"/locked": b""},
            b"tee: /gone/x: No such file or directory\n",
        ),
        (["/bad", "/locked"], False, {"/bad"}, {}, b"tee: /bad: disk full\n"),
    ],
)
async def test_an_unprobed_output_is_opened_in_order_before_any_data(
    outputs, append, refused, written, stderr
):
    sunk, write = _sink(frozenset(refused))

    async def _stat(p: PathSpec) -> FileStat:
        if p.virtual == "/locked":
            raise PermissionError(errno.EACCES, "Permission denied")
        if p.virtual.startswith("/gone"):
            raise FileNotFoundError(errno.ENOENT, "No such file or directory")
        return FileStat(name=p.virtual[1:], type=FileType.FILE)

    source, io = await tee_generic(
        [_spec(o) for o in outputs],
        (),
        read_stream=_empty,
        write_bytes=write,
        stdin=b"x",
        flags={"output_error": "exit", "append": append},
        stat=_stat,
    )
    assert source is None
    assert sunk == written
    assert io.exit_code == 1
    assert await materialize(io.stderr) == stderr


@pytest.mark.asyncio
async def test_a_native_append_skips_the_read_modify_write():
    appended: dict[str, bytes] = {}
    written, write = _sink()

    async def _append(p, d):
        appended[p.mount_path] = d

    _source, io = await tee_generic(
        [_spec("/n")],
        (),
        read_stream=_empty,
        write_bytes=write,
        append_bytes=_append,
        stdin=b"add",
        flags={"append": True},
    )
    assert appended == {"/n": b"add"}
    assert written == {}


@pytest.mark.asyncio
async def test_without_a_native_append_it_reads_and_rewrites():
    written, write = _sink()

    async def _old(_p):
        yield b"old"

    _source, io = await tee_generic(
        [_spec("/n")],
        (),
        read_stream=_old,
        write_bytes=write,
        stdin=b"add",
        flags={"append": True},
    )
    assert written == {"/n": b"oldadd"}


@pytest.mark.asyncio
async def test_a_read_only_mount_runs_tee_and_refuses_its_file_operand():
    # With no operand tee only copies stdin to stdout, so a read-only cwd
    # runs it like any reader. With one, the copy still reaches stdout and
    # the file is refused at its write, as GNU tee reports it.
    vfs = RAMVFS()
    ws = Workspace({"/ro/": (vfs, MountMode.READ)})
    bare = await ws.shell("cd /ro && tee", stdin=b"x\n")
    assert (bare.exit_code, await bare.materialize_stdout(), bare.stderr) == (
        0,
        b"x\n",
        None,
    )
    named = await ws.shell("tee /ro/out.txt", stdin=b"x\n")
    assert (
        named.exit_code,
        await named.materialize_stdout(),
        named.stderr,
    ) == (1, b"x\n", b"tee: /ro/out.txt: Read-only file system\n")
    assert vfs._store.files == {}
