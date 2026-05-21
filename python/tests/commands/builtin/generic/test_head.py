import pytest

from mirage.commands.builtin.generic.head import head


async def _drain(gen):
    return b"".join([c async for c in gen])


@pytest.mark.asyncio
async def test_head_first_c_bytes_fast_path():
    out = await _drain(head(b"hello world", c=5))
    assert out == b"hello"


@pytest.mark.asyncio
async def test_head_first_c_bytes_across_chunks():

    async def src():
        yield b"hel"
        yield b"lo wor"
        yield b"ld"

    out = await _drain(head(src(), c=8))
    assert out == b"hello wo"


@pytest.mark.asyncio
async def test_head_first_c_bytes_shorter_than_total():
    out = await _drain(head(b"hi", c=100))
    assert out == b"hi"


@pytest.mark.asyncio
async def test_head_first_c_zero_emits_nothing():
    out = await _drain(head(b"hello", c=0))
    assert out == b""


@pytest.mark.asyncio
async def test_head_first_n_lines_from_bytes():
    out = await _drain(head(b"a\nb\nc\nd\n", n=2))
    assert out == b"a\nb\n"


@pytest.mark.asyncio
async def test_head_first_n_lines_from_stream():

    async def src():
        yield b"a\nb"
        yield b"\nc\nd\n"

    out = await _drain(head(src(), n=2))
    assert out == b"a\nb\n"


@pytest.mark.asyncio
async def test_head_default_n_is_10():
    body = b"".join(f"line{i}\n".encode() for i in range(1, 15))
    out = await _drain(head(body))
    lines = out.decode().splitlines()
    assert len(lines) == 10
    assert lines[0] == "line1"
    assert lines[9] == "line10"


@pytest.mark.asyncio
async def test_head_n_zero_emits_nothing():
    out = await _drain(head(b"a\nb\n", n=0))
    assert out == b""


@pytest.mark.asyncio
async def test_head_negative_n_excludes_last_n_lines():
    out = await _drain(head(b"a\nb\nc\nd\n", n=-1))
    assert out == b"a\nb\nc\n"


@pytest.mark.asyncio
async def test_head_negative_n_equal_to_total_emits_nothing():
    out = await _drain(head(b"a\nb\n", n=-2))
    assert out == b""


@pytest.mark.asyncio
async def test_head_stops_consuming_stream_after_n_lines():
    consumed = []

    async def src():
        for line in [b"a\n", b"b\n", b"c\n", b"d\n", b"e\n"]:
            consumed.append(line)
            yield line

    chunks = [c async for c in head(src(), n=2)]
    assert b"".join(chunks) == b"a\nb\n"
    assert consumed == [b"a\n", b"b\n"]


@pytest.mark.asyncio
async def test_head_no_trailing_newline_in_last_line():
    out = await _drain(head(b"a\nb\nno-end", n=3))
    assert out == b"a\nb\nno-end"


@pytest.mark.asyncio
async def test_head_n_larger_than_available():
    out = await _drain(head(b"a\nb\n", n=10))
    assert out == b"a\nb\n"


@pytest.mark.asyncio
async def test_head_n_one():
    out = await _drain(head(b"line1\nline2\nline3\n", n=1))
    assert out == b"line1\n"


@pytest.mark.asyncio
async def test_head_empty_input():
    out = await _drain(head(b""))
    assert out == b""


@pytest.mark.asyncio
async def test_head_empty_input_with_c():
    out = await _drain(head(b"", c=10))
    assert out == b""


@pytest.mark.asyncio
async def test_head_single_line_no_newline_default_n():
    """head on a single line without trailing newline returns it as-is."""
    out = await _drain(head(b"hello"))
    assert out == b"hello"


@pytest.mark.asyncio
async def test_head_c_negative_is_all_but_last_abs():
    """GNU head: -c -N emits all but the last N bytes."""
    out = await _drain(head(b"hello", c=-3))
    assert out == b"he"
