import pytest

from mirage.commands.builtin.generic.tee import TeeFlags, parse_flags, tee
from mirage.commands.spec import SPECS, parse_command
from mirage.io.stream import materialize
from mirage.types import PathSpec


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


def test_parse_flags_append_short_and_long():
    assert parse_flags({"append": True}) == TeeFlags(append=True)


def test_parse_flags_i_and_p_are_noops():
    assert parse_flags({
        "ignore_interrupts": True,
        "p": True
    }) == TeeFlags(append=False)


def test_parse_flags_reads_the_exit_warn_axis():
    # Value validation lives in the spec's choices=. Only the exit/warn
    # axis is observable here: the -nopipe half distinguishes a pipe sink
    # from a file sink, and every operand tee writes is a file.
    for mode in ("warn", "warn-nopipe"):
        assert parse_flags({"output_error":
                            mode}) == TeeFlags(stop_on_error=False)
    for mode in ("exit", "exit-nopipe"):
        assert parse_flags({"output_error":
                            mode}) == TeeFlags(stop_on_error=True)


def test_a_bare_output_error_means_warn():
    # GNU 9.7.
    assert parse_flags({"output_error": True}) == TeeFlags(stop_on_error=False)


def test_bad_output_error_mode_is_reported_by_the_parser():
    parsed = parse_command(SPECS["tee"], ["--output-error=bogus", "/f.txt"],
                           cwd="/")
    assert parsed.invalid_value_options == [
        ("--output-error", "bogus", ("warn", "warn-nopipe", "exit",
                                     "exit-nopipe")),
    ]


@pytest.mark.asyncio
async def test_write_error_passes_stdout_and_exits_one():

    async def _write(_p, _d):
        raise OSError("disk full")

    async def _read(_p):
        if False:
            yield b""

    source, io = await tee([_spec("/out.txt")], (),
                           read_stream=_read,
                           write_bytes=_write,
                           stdin=b"hello",
                           flags={})
    # GNU tee still copies stdin to stdout on a write error.
    assert await materialize(source) == b"hello"
    assert io.exit_code == 1
    assert await materialize(io.stderr) == b"tee: /out.txt: disk full\n"
    assert not io.writes


@pytest.mark.asyncio
async def test_an_sdk_write_failure_is_diagnosed_not_raised():
    # Narrowing the catch to OSError let one unreachable operand abort the
    # whole command on every remote backend, because none of their SDK
    # error classes is an OSError.

    async def _write(_p, _d):
        raise _SdkError("An error occurred (AccessDenied)")

    async def _read(_p):
        if False:
            yield b""

    source, io = await tee([_spec("/a.txt"), _spec("/b.txt")], (),
                           read_stream=_read,
                           write_bytes=_write,
                           stdin=b"hello",
                           flags={})
    assert await materialize(source) == b"hello"
    assert io.exit_code == 1
    assert await materialize(
        io.stderr) == (b"tee: /a.txt: An error occurred (AccessDenied)\n"
                       b"tee: /b.txt: An error occurred (AccessDenied)\n")


@pytest.mark.asyncio
async def test_unusable_destination_reports_the_gnu_strerror():
    # A recognized filesystem refusal carries only the path as its message,
    # so the strerror has to come from the shared table (GNU:
    # "tee: X: No such file or directory"). A transport error keeps its own
    # message instead, which the test above pins.

    async def _write(p, _d):
        raise FileNotFoundError(p.virtual)

    async def _read(_p):
        if False:
            yield b""

    source, io = await tee([_spec("/nodir/out.txt")], (),
                           read_stream=_read,
                           write_bytes=_write,
                           stdin=b"hello",
                           flags={})
    assert await materialize(source) == b"hello"
    assert io.exit_code == 1
    assert await materialize(
        io.stderr) == (b"tee: /nodir/out.txt: No such file or directory\n")


@pytest.mark.asyncio
async def test_writes_stdin_and_reports_cache():
    written = {}

    async def _write(p, d):
        written[p.mount_path] = d

    async def _read(_p):
        if False:
            yield b""

    source, io = await tee([_spec("/out.txt")], (),
                           read_stream=_read,
                           write_bytes=_write,
                           stdin=b"hello",
                           flags={})
    assert await materialize(source) == b"hello"
    assert io.exit_code == 0
    assert written["/out.txt"] == b"hello"
    assert io.writes == {"/out.txt": b"hello"}
    assert io.cache == ["/out.txt"]


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


@pytest.mark.asyncio
async def test_every_operand_is_written():
    # GNU 9.7: `printf x | tee a b c` puts x in all three. Both generics
    # used to write paths[0] and silently drop the rest, while the spec
    # declared a variadic rest operand.
    written, write = _sink()
    source, io = await tee(
        [_spec("/a"), _spec("/b"), _spec("/c")], (),
        read_stream=_empty,
        write_bytes=write,
        stdin=b"hi",
        flags={})
    assert written == {"/a": b"hi", "/b": b"hi", "/c": b"hi"}
    assert await materialize(source) == b"hi"
    assert io.exit_code == 0
    assert io.cache == ["/a", "/b", "/c"]


@pytest.mark.asyncio
async def test_one_bad_operand_does_not_stop_the_others():
    # GNU pins: `tee p bad q` writes p and q, diagnoses bad, exits 1.
    written, write = _sink(frozenset({"/bad"}))
    source, io = await tee(
        [_spec("/p"), _spec("/bad"), _spec("/q")], (),
        read_stream=_empty,
        write_bytes=write,
        stdin=b"x",
        flags={})
    assert written == {"/p": b"x", "/q": b"x"}
    assert io.exit_code == 1
    assert await materialize(io.stderr) == b"tee: /bad: disk full\n"
    assert await materialize(source) == b"x"


@pytest.mark.asyncio
async def test_output_error_exit_stops_at_the_first_failure():
    written, write = _sink(frozenset({"/bad"}))
    _source, io = await tee(
        [_spec("/p"), _spec("/bad"), _spec("/q")], (),
        read_stream=_empty,
        write_bytes=write,
        stdin=b"x",
        flags={"output_error": "exit"})
    assert written == {"/p": b"x"}
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_each_failing_operand_is_diagnosed():
    _written, write = _sink(frozenset({"/b1", "/b2"}))
    _source, io = await tee([_spec("/b1"), _spec("/b2")], (),
                            read_stream=_empty,
                            write_bytes=write,
                            stdin=b"x",
                            flags={})
    assert await materialize(io.stderr
                             ) == b"tee: /b1: disk full\ntee: /b2: disk full\n"
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_append_to_a_missing_file_creates_it():
    written, write = _sink()

    async def _missing(p):
        raise FileNotFoundError(p.virtual)
        yield b""

    _source, io = await tee([_spec("/new")], (),
                            read_stream=_missing,
                            write_bytes=write,
                            stdin=b"hi",
                            flags={"append": True})
    assert written == {"/new": b"hi"}
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_a_native_append_skips_the_read_modify_write():
    appended: dict[str, bytes] = {}
    written, write = _sink()

    async def _append(p, d):
        appended[p.mount_path] = d

    _source, io = await tee([_spec("/n")], (),
                            read_stream=_empty,
                            write_bytes=write,
                            append_bytes=_append,
                            stdin=b"add",
                            flags={"append": True})
    assert appended == {"/n": b"add"}
    assert written == {}
    # Listed as written but not as cacheable: the resulting content is not
    # in hand, so the stale cache entry must be dropped, not replaced.
    assert list(io.writes) == ["/n"]
    assert io.cache == []


@pytest.mark.asyncio
async def test_without_a_native_append_it_reads_and_rewrites():
    written, write = _sink()

    async def _old(_p):
        yield b"old"

    _source, io = await tee([_spec("/n")], (),
                            read_stream=_old,
                            write_bytes=write,
                            stdin=b"add",
                            flags={"append": True})
    assert written == {"/n": b"oldadd"}
    assert io.cache == ["/n"]
