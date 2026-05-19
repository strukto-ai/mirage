import pytest

from mirage.commands.builtin.generic.cat import cat


async def _drain(gen):
    return b"".join([c async for c in gen])


@pytest.mark.asyncio
async def test_cat_passthrough_from_bytes():
    out = await _drain(cat(b"hello\nworld\n"))
    assert out == b"hello\nworld\n"


@pytest.mark.asyncio
async def test_cat_passthrough_from_stream_preserves_chunks():

    async def src():
        yield b"hel"
        yield b"lo\nwo"
        yield b"rld\n"

    chunks = [c async for c in cat(src())]
    assert chunks == [b"hel", b"lo\nwo", b"rld\n"]


@pytest.mark.asyncio
async def test_cat_number_lines():
    out = await _drain(cat(b"a\nb\nc\n", number_lines=True))
    assert out == b"     1\ta\n     2\tb\n     3\tc\n"


@pytest.mark.asyncio
async def test_cat_number_lines_across_chunk_boundaries():

    async def src():
        yield b"a\nb"
        yield b"\nc\n"

    out = await _drain(cat(src(), number_lines=True))
    assert out == b"     1\ta\n     2\tb\n     3\tc\n"


@pytest.mark.asyncio
async def test_cat_show_ends():
    out = await _drain(cat(b"a\nb\n", show_ends=True))
    assert out == b"a$\nb$\n"


@pytest.mark.asyncio
async def test_cat_squeeze_blank():
    out = await _drain(cat(b"a\n\n\n\nb\n", squeeze_blank=True))
    assert out == b"a\n\nb\n"


@pytest.mark.asyncio
async def test_cat_no_trailing_newline_preserved():
    """POSIX: `printf "x" | cat -n` emits no trailing newline."""
    out = await _drain(cat(b"hello", number_lines=True))
    assert out == b"     1\thello"


@pytest.mark.asyncio
async def test_cat_passthrough_no_trailing_newline():
    """No-flag cat must not add a trailing newline."""
    out = await _drain(cat(b"hello"))
    assert out == b"hello"


@pytest.mark.asyncio
async def test_cat_number_lines_multidigit_alignment():
    """POSIX format is `%6d\\t` — width 6, right-justified. Old MIRAGE used
    a 5-space prefix which broke alignment for line numbers >= 10."""
    body = b"".join(f"line{i}\n".encode() for i in range(1, 13))
    out = await _drain(cat(body, number_lines=True))
    lines = out.split(b"\n")
    assert lines[0] == b"     1\tline1"
    assert lines[8] == b"     9\tline9"
    assert lines[9] == b"    10\tline10"
    assert lines[11] == b"    12\tline12"


@pytest.mark.asyncio
async def test_cat_show_ends_no_trailing_newline():
    """cat -E on input without trailing newline must not emit final `$\\n`."""
    out = await _drain(cat(b"hello", show_ends=True))
    assert out == b"hello"


@pytest.mark.asyncio
async def test_cat_combined_n_E_s():
    """Combined flags: number all kept lines, show ends, squeeze blanks."""
    out = await _drain(
        cat(b"a\n\n\n\nb\n",
            number_lines=True,
            show_ends=True,
            squeeze_blank=True))
    # Kept lines: "a", "" (first blank, kept), "b". Numbered 1, 2, 3.
    assert out == b"     1\ta$\n     2\t$\n     3\tb$\n"


@pytest.mark.asyncio
async def test_cat_empty_input_emits_nothing_with_flags():
    out = await _drain(cat(b"", number_lines=True))
    assert out == b""


@pytest.mark.asyncio
async def test_cat_only_newlines():
    """Three blank lines numbered 1, 2, 3."""
    out = await _drain(cat(b"\n\n\n", number_lines=True))
    assert out == b"     1\t\n     2\t\n     3\t\n"


@pytest.mark.asyncio
async def test_cat_squeeze_blank_preserves_first_blank():
    out = await _drain(cat(b"\n\n\nx\n", squeeze_blank=True))
    assert out == b"\nx\n"


@pytest.mark.asyncio
async def test_cat_empty_input_passthrough():
    out = await _drain(cat(b""))
    assert out == b""


@pytest.mark.asyncio
async def test_cat_binary_passthrough_full_byte_range():
    """Full 0..255 byte range must pass through unchanged (no flags)."""
    data = bytes(range(256))
    out = await _drain(cat(data))
    assert out == data


@pytest.mark.asyncio
async def test_cat_binary_with_show_ends_marks_only_newlines():
    """show_ends should only mark 0x0A bytes, not other binary bytes."""
    data = b"\x00\x01\n\x02\x03\n"
    out = await _drain(cat(data, show_ends=True))
    assert out == b"\x00\x01$\n\x02\x03$\n"


@pytest.mark.asyncio
async def test_cat_number_lines_chunked_one_byte_at_a_time():
    """Worst-case chunking: every byte its own chunk. Result must match
    unbuffered input exactly."""

    async def src():
        for byte in b"a\nbb\nccc\n":
            yield bytes([byte])

    out = await _drain(cat(src(), number_lines=True))
    assert out == b"     1\ta\n     2\tbb\n     3\tccc\n"
