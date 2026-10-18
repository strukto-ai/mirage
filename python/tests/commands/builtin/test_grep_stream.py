from collections.abc import AsyncIterator

import pytest

from mirage.commands.builtin.generic.grep import parse_flags
from mirage.commands.builtin.grep_binary import PROBE_BLOCK_BYTES, GrepFlags
from mirage.commands.builtin.grep_stream import (
    open_grep,
    stream_config,
    stream_input,
)
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import IOResult, materialize


def flags_of(raw: dict) -> GrepFlags:
    return parse_flags(FlagView(raw, spec=SPECS["grep"]), False)


def test_config_carries_each_pattern_as_its_bytes():
    config = stream_config(
        flags_of({"fixed_strings": True}), "é\nb\udcff", False
    )
    assert config["syntax"] == "fixed"
    assert config["patterns"] == ["\xc3\xa9", "b\xff"]
    assert config["separator"] is None


def test_config_separates_groups_only_with_context():
    with_context = stream_config(flags_of({"after_context": "0"}), "a", False)
    assert with_context["separator"] == "--\n"
    assert stream_config(flags_of({}), None, False)["patterns"] == []


def test_a_refused_pattern_is_a_usage_error():
    with pytest.raises(UsageError, match=r"grep: Unmatched \( or \\\("):
        open_grep(stream_config(flags_of({}), "\\(", False))


@pytest.mark.asyncio
@pytest.mark.parametrize("chunk", [1, 7, PROBE_BLOCK_BYTES * 2])
async def test_one_stream_serves_input_after_input(chunk):
    stream, warnings = open_grep(
        stream_config(flags_of({"count": True}), "needle", False)
    )
    assert warnings == b""
    for data, count, status in (
        (b"needle\nhay\n" * 2000, b"f:2000\n", 0),
        (b"hay\n", b"f:0\n", 1),
    ):

        async def source(data: bytes = data) -> AsyncIterator[bytes]:
            for offset in range(0, len(data), chunk):
                yield data[offset : offset + chunk]

        io = IOResult(exit_code=1)
        out = await materialize(stream_input(source(), stream, "f", True, io))
        assert (out, io.exit_code) == (count, status)


@pytest.mark.asyncio
async def test_max_count_zero_reads_nothing():
    config = stream_config(
        flags_of({"max_count": "0", "files_without_match": True}), "a", False
    )
    stream, _ = open_grep(config)
    read = []

    async def source() -> AsyncIterator[bytes]:
        read.append(True)
        yield b"a\n"

    io = IOResult(exit_code=1)
    out = await materialize(stream_input(source(), stream, "f", False, io))
    assert (out, read, io.exit_code) == (b"f\n", [], 1)


@pytest.mark.asyncio
async def test_the_notice_lands_before_a_failing_read():
    # A stray byte under UTF-8 hides the line but reading goes on.
    stream, _ = open_grep(stream_config(flags_of({}), "a", True))

    async def source() -> AsyncIterator[bytes]:
        yield b"a\xff\n"
        raise PermissionError("f")

    io = IOResult(exit_code=1)
    with pytest.raises(PermissionError):
        await materialize(stream_input(source(), stream, "f", False, io))
    assert io.stderr == b"grep: f: binary file matches\n"
    assert io.exit_code == 0
