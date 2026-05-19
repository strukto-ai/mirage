import pytest

from mirage.commands.builtin.generic.tail import tail


async def _drain(gen):
    return b"".join([c async for c in gen])


@pytest.mark.asyncio
async def test_tail_default_n_10():
    body = b"\n".join(f"line{i}".encode() for i in range(1, 21)) + b"\n"
    out = await _drain(tail(body))
    expected = b"\n".join(f"line{i}".encode() for i in range(11, 21)) + b"\n"
    assert out == expected


@pytest.mark.asyncio
async def test_tail_n_explicit():
    out = await _drain(tail(b"a\nb\nc\nd\ne\n", n=3))
    assert out == b"c\nd\ne\n"


@pytest.mark.asyncio
async def test_tail_n_1():
    body = b"line1\nline2\nline3\n"
    out = await _drain(tail(body, n=1))
    assert out == b"line3\n"


@pytest.mark.asyncio
async def test_tail_n_larger_than_total():
    out = await _drain(tail(b"a\nb\nc", n=100))
    assert out == b"a\nb\nc"


@pytest.mark.asyncio
async def test_tail_n_zero_emits_nothing():
    out = await _drain(tail(b"a\nb\nc\n", n=0))
    assert out == b""


@pytest.mark.asyncio
async def test_tail_negative_n_treated_as_abs():
    """GNU/POSIX `tail -n -3` is the same as `tail -n 3` (last 3 lines)."""
    out = await _drain(tail(b"a\nb\nc\nd\ne\n", n=-3))
    assert out == b"c\nd\ne\n"


@pytest.mark.asyncio
async def test_tail_n_no_trailing_newline_in_last_line():
    out = await _drain(tail(b"a\nb\nc", n=2))
    assert out == b"b\nc"


@pytest.mark.asyncio
async def test_tail_single_line_no_newline_default():
    out = await _drain(tail(b"hello"))
    assert out == b"hello"


@pytest.mark.asyncio
async def test_tail_empty_input():
    out = await _drain(tail(b""))
    assert out == b""


@pytest.mark.asyncio
async def test_tail_only_newlines():
    """Tail of \\n\\n\\n with n=2 keeps the last two blank lines."""
    out = await _drain(tail(b"\n\n\n", n=2))
    assert out == b"\n\n"


@pytest.mark.asyncio
async def test_tail_n_from_stream():

    async def src():
        yield b"a\nb"
        yield b"\nc\nd\n"

    out = await _drain(tail(src(), n=2))
    assert out == b"c\nd\n"


@pytest.mark.asyncio
async def test_tail_n_chunked_one_byte_at_a_time():

    async def src():
        for byte in b"a\nbb\nccc\n":
            yield bytes([byte])

    out = await _drain(tail(src(), n=2))
    assert out == b"bb\nccc\n"


@pytest.mark.asyncio
async def test_tail_c_bytes_fast_path():
    out = await _drain(tail(b"hello world", c=5))
    assert out == b"world"


@pytest.mark.asyncio
async def test_tail_c_bytes_across_chunks():

    async def src():
        yield b"hel"
        yield b"lo wor"
        yield b"ld"

    out = await _drain(tail(src(), c=5))
    assert out == b"world"


@pytest.mark.asyncio
async def test_tail_c_chunked_one_byte_at_a_time():
    """Worst-case chunking for -c: rolling window must hold last N bytes."""

    async def src():
        for byte in b"hello world":
            yield bytes([byte])

    out = await _drain(tail(src(), c=5))
    assert out == b"world"


@pytest.mark.asyncio
async def test_tail_c_larger_than_total():
    out = await _drain(tail(b"abc", c=100))
    assert out == b"abc"


@pytest.mark.asyncio
async def test_tail_c_zero_emits_nothing():
    out = await _drain(tail(b"abc", c=0))
    assert out == b""


@pytest.mark.asyncio
async def test_tail_c_negative_emits_nothing():
    out = await _drain(tail(b"hello", c=-3))
    assert out == b""


@pytest.mark.asyncio
async def test_tail_c_empty_input():
    out = await _drain(tail(b"", c=10))
    assert out == b""


@pytest.mark.asyncio
async def test_tail_c_binary_preserves_full_byte_range():
    """-c must not corrupt binary bytes."""
    data = bytes(range(256))
    out = await _drain(tail(data, c=10))
    assert out == data[-10:]


@pytest.mark.asyncio
async def test_tail_from_line_streaming():
    """`tail -n +3` emits lines 3 onwards."""
    out = await _drain(tail(b"a\nb\nc\nd\ne\n", from_line=3))
    assert out == b"c\nd\ne\n"


@pytest.mark.asyncio
async def test_tail_from_line_1_is_passthrough():
    out = await _drain(tail(b"a\nb\nc\n", from_line=1))
    assert out == b"a\nb\nc\n"


@pytest.mark.asyncio
async def test_tail_from_line_0_treated_as_1():
    """GNU `tail -n +0` is documented as `+1` (start from line 1)."""
    out = await _drain(tail(b"a\nb\nc\n", from_line=0))
    assert out == b"a\nb\nc\n"


@pytest.mark.asyncio
async def test_tail_from_line_past_end_emits_nothing():
    out = await _drain(tail(b"a\nb\n", from_line=10))
    assert out == b""


@pytest.mark.asyncio
async def test_tail_from_line_across_chunks():
    """`from_line` skip must work across arbitrary chunk boundaries."""

    async def src():
        yield b"a\nb"
        yield b"\nc\nd"
        yield b"\ne\n"

    out = await _drain(tail(src(), from_line=3))
    assert out == b"c\nd\ne\n"


@pytest.mark.asyncio
async def test_tail_from_line_chunked_one_byte_at_a_time():

    async def src():
        for byte in b"a\nb\nc\nd\n":
            yield bytes([byte])

    out = await _drain(tail(src(), from_line=3))
    assert out == b"c\nd\n"


@pytest.mark.asyncio
async def test_tail_from_line_preserves_binary_payload():
    data = b"\x00\x01\n\x02\x03\n\x04\x05\n"
    out = await _drain(tail(data, from_line=2))
    assert out == b"\x02\x03\n\x04\x05\n"


@pytest.mark.asyncio
async def test_tail_from_line_1_preserves_stream_chunks():
    """`from_line=1` is passthrough: chunk boundaries must survive intact."""

    async def src():
        yield b"hel"
        yield b"lo\nwo"
        yield b"rld\n"

    chunks = [c async for c in tail(src(), from_line=1)]
    assert chunks == [b"hel", b"lo\nwo", b"rld\n"]


@pytest.mark.asyncio
async def test_tail_from_line_emits_chunks_incrementally_after_skip():
    """Once the skip threshold is crossed, subsequent chunks pass through
    untouched (no rebuffering)."""

    async def src():
        yield b"a\nb\nc"
        yield b"\nd\n"
        yield b"e\n"

    chunks = [c async for c in tail(src(), from_line=3)]
    assert chunks == [b"c", b"\nd\n", b"e\n"]
