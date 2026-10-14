import base64

import pytest

from mirage.commands.builtin.generic.base64_cmd import base64_cmd
from mirage.io.types import materialize


def _unused(path):
    raise AssertionError("no file operand")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "decode,data,expected", [(False, b"abc", b"YWJj"), (True, b"YWJj", b"abc")]
)
async def test_emits_before_reading_the_tail_and_closes(
    decode, data, expected
):
    closed = False

    async def source():
        nonlocal closed
        try:
            yield data
            raise AssertionError("base64 fetched the tail")
        finally:
            closed = True

    output, _ = await base64_cmd(
        [], read_stream=_unused, stdin=source(), decode=decode
    )
    try:
        assert await anext(output) == expected
    finally:
        await output.aclose()
    assert closed


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [1, 2, 7, 16385])
@pytest.mark.parametrize("wrap", [0, 1, 4, 76])
async def test_encoding_carries_bytes_and_wrap_columns_across_chunks(
    size, wrap
):
    data = bytes(range(256)) * 65 + b"x"

    async def source():
        for at in range(0, len(data), size):
            yield data[at : at + size]

    output, _ = await base64_cmd(
        [], read_stream=_unused, stdin=source(), wrap=wrap
    )
    parts = [part async for part in output]
    encoded = base64.b64encode(data)
    expected = (
        encoded
        if wrap == 0
        else b"\n".join(
            encoded[at : at + wrap] for at in range(0, len(encoded), wrap)
        )
        + b"\n"
    )
    assert b"".join(parts) == expected
    assert max(map(len, parts)) <= 2 * 4 * (16384 // 3 + 1)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data,ignore,expected,code",
    [
        (b"YQ==Yg==", False, b"ab", 0),
        (b"YQ=\n=", False, b"a", 0),
        (b"YQ", False, b"a", 0),
        (b"YWI", False, b"ab", 0),
        (b"YQ=", False, b"a", 1),
        (b"YWJj!ZA==", False, b"abc", 1),
        (b"YW Jj", False, b"a", 1),
        (b"YQ===", False, b"a", 1),
        (b"Y", False, b"", 1),
        (b"YR", False, b"a", 1),
        (b"YWF=Yg==", False, b"aa", 1),
        (b"Y!W Jj\xff", True, b"abc", 0),
    ],
)
@pytest.mark.parametrize("size", [1, 3, 100])
async def test_decoding_padding_and_failures_are_chunk_independent(
    data, ignore, expected, code, size
):
    async def source():
        for at in range(0, len(data), size):
            yield data[at : at + size]

    output, io = await base64_cmd(
        [],
        read_stream=_unused,
        stdin=source(),
        decode=True,
        ignore_garbage=ignore,
    )
    assert await materialize(output) == expected
    assert io.exit_code == code
    assert io.stderr == (b"base64: invalid input\n" if code else None)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data,expected",
    [
        (b"", b""),
        (b"a", b"YQ==\n"),
        (b"ab", b"YWI=\n"),
        (b"abc", b"YWJj\n"),
        (b"abcd", b"YWJjZA==\n"),
    ],
)
async def test_encoding_flushes_the_final_partial_group(data, expected):
    output, _ = await base64_cmd([], read_stream=_unused, stdin=data)
    assert await materialize(output) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [1, 2, 7, 16385])
async def test_decoding_all_byte_values_in_bounded_chunks(size):
    data = bytes(range(256)) * 65
    encoded = base64.b64encode(data)

    async def source():
        for at in range(0, len(encoded), size):
            yield encoded[at : at + size]

    output, io = await base64_cmd(
        [], read_stream=_unused, stdin=source(), decode=True
    )
    parts = [part async for part in output]
    assert b"".join(parts) == data
    assert max(map(len, parts)) <= 16384
    assert io.exit_code == 0
