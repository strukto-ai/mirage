import pytest

from mirage.commands.builtin.generic.tee import TeeFlags, parse_flags, tee
from mirage.io.stream import materialize
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec.from_str_path(path)


def test_parse_flags_append_short_and_long():
    assert parse_flags({"a": True}) == TeeFlags(append=True)
    assert parse_flags({"append": True}) == TeeFlags(append=True)


def test_parse_flags_i_and_p_are_noops():
    assert parse_flags({"i": True, "p": True}) == TeeFlags(append=False)


def test_parse_flags_valid_output_error_modes():
    for mode in ("warn", "warn-nopipe", "exit", "exit-nopipe"):
        assert parse_flags({"output_error": mode}) == TeeFlags(append=False)
    assert parse_flags({"output_error": True}) == TeeFlags(append=False)


def test_parse_flags_bad_output_error_mode_message():
    with pytest.raises(ValueError) as exc:
        parse_flags({"output_error": "bogus"})
    assert str(exc.value) == (
        "tee: invalid argument 'bogus' for '--output-error'\n"
        "Valid arguments are:\n"
        "  - 'warn'\n  - 'warn-nopipe'\n  - 'exit'\n  - 'exit-nopipe'\n"
        "Try 'tee --help' for more information.")


@pytest.mark.asyncio
async def test_bad_output_error_mode_exits_one():

    async def _write(_p, _d):
        raise AssertionError("write should not run on a bad flag")

    async def _read(_p):
        if False:
            yield b""

    source, io = await tee([_spec("/out.txt")], (),
                           read_stream=_read,
                           write_bytes=_write,
                           stdin=b"hi",
                           flags={"output_error": "bogus"})
    assert source is None
    assert io.exit_code == 1
    assert b"the delimiter" not in await materialize(io.stderr)
    assert b"--output-error" in await materialize(io.stderr)


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
