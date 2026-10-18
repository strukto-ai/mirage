from collections.abc import AsyncIterator
from contextlib import aclosing

import pytest

from mirage.commands.builtin.generic.comm import comm
from mirage.io.stream import materialize
from mirage.types import PathSpec


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "delimiter,encoded", [("\udcff", b"\xff"), ("λ", b"\xce\xbb")]
)
@pytest.mark.parametrize(
    "left,right,suppressed,expected",
    [
        (b"", b"", False, b""),
        (b"a\n", b"", True, b"a\n"),
        (b"", b"b\n", False, b"\xffb\n"),
        (b"a\n", b"a\n", False, b"\xff\xffa\n"),
    ],
)
async def test_raw_output_separator(
    left, right, suppressed, expected, delimiter, encoded
):
    async def read(path):
        yield left if path.virtual == "/left" else right

    output, io = await comm(
        [PathSpec.from_str_path("/left"), PathSpec.from_str_path("/right")],
        read_stream=read,
        output_delimiter=delimiter,
        suppress2=suppressed,
        suppress3=suppressed,
    )
    assert await materialize(output) == expected.replace(b"\xff", encoded)
    assert io.exit_code == 0
    assert not await materialize(io.stderr)


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [1, 3, 65536])
async def test_shared_stdin_owns_one_record_cursor_and_refuses_before_total(
    size,
):
    closed = []

    async def source() -> AsyncIterator[bytes]:
        try:
            data = b"a\nb\nc\nd\n"
            for start in range(0, len(data), size):
                yield data[start : start + size]
        finally:
            closed.append(True)

    def read(_path):
        raise AssertionError("shared stdin must not open a file")

    output, io = await comm(
        [PathSpec.from_str_path("-"), PathSpec.from_str_path("-")],
        read_stream=read,
        stdin=source(),
        total=True,
    )
    assert await materialize(output) == b"a\n\tb\nc\n\td\n"
    assert io.stderr == b"comm: -: Bad file descriptor\n"
    assert io.exit_code == 1
    assert closed == [True]


@pytest.mark.asyncio
async def test_output_reaches_consumer_before_reading_a_future_record():
    pulled = []
    closed = []

    async def source(path) -> AsyncIterator[bytes]:
        try:
            if path.virtual == "/left":
                yield b"first\n"
                pulled.append(True)
                raise AssertionError(
                    "consumer stopped before the future record"
                )
        finally:
            closed.append(path.virtual)

    output, _ = await comm(
        [PathSpec.from_str_path("/left"), PathSpec.from_str_path("/right")],
        read_stream=source,
    )
    async with aclosing(output) as stream:
        assert await anext(stream) == b"first\n"
    assert pulled == []
    assert sorted(closed) == ["/left", "/right"]


@pytest.mark.asyncio
async def test_strict_failure_keeps_earlier_output_and_skips_total():
    async def read(path):
        yield b"b\na\n" if path.virtual == "/left" else b"z\n"

    output, io = await comm(
        [PathSpec.from_str_path("/left"), PathSpec.from_str_path("/right")],
        read_stream=read,
        check_order=True,
        total=True,
    )
    assert await materialize(output) == b"b\n"
    assert io.stderr == b"comm: file 1 is not in sorted order\n"
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_disorder_summary_follows_a_consumed_total_record():
    async def read(path):
        yield b"b\na\n" if path.virtual == "/left" else b"z\n"

    output, io = await comm(
        [PathSpec.from_str_path("/left"), PathSpec.from_str_path("/right")],
        read_stream=read,
        total=True,
    )
    async with aclosing(output) as stream:
        while b"total" not in await anext(stream):
            pass
    assert io.stderr == b"comm: file 1 is not in sorted order\n"
