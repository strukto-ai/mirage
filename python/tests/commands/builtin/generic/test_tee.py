import pytest

from mirage.commands.builtin.generic.tee import TeeFlags, parse_flags, tee
from mirage.commands.spec import SPECS, parse_command
from mirage.io.stream import materialize
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec.from_str_path(path)


def test_parse_flags_append_short_and_long():
    assert parse_flags({"append": True}) == TeeFlags(append=True)
    assert parse_flags({"append": True}) == TeeFlags(append=True)


def test_parse_flags_i_and_p_are_noops():
    assert parse_flags({
        "ignore_interrupts": True,
        "p": True
    }) == TeeFlags(append=False)


def test_parse_flags_valid_output_error_modes():
    # Value validation moved to the spec's choices=: the parser reports a
    # bad mode and the executor refuses before tee runs, so parse_flags
    # only reads append.
    for mode in ("warn", "warn-nopipe", "exit", "exit-nopipe"):
        assert parse_flags({"output_error": mode}) == TeeFlags(append=False)
    assert parse_flags({"output_error": True}) == TeeFlags(append=False)


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
