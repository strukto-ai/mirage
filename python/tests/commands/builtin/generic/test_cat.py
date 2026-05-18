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
    out = await _drain(cat(b"hello", number_lines=True))
    assert out == b"     1\thello"
