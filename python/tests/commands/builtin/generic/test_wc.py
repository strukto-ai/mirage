import pytest

from mirage.commands.builtin.generic.wc import (WCCounts, format_wc, wc,
                                                wc_lines)


@pytest.mark.asyncio
async def test_wc_default_counts_bytes():
    counts = await wc(b"hello world\nfoo bar\n")
    assert counts.lines == 2
    assert counts.words == 4
    assert counts.bytes_ == 20
    assert counts.chars == 20


@pytest.mark.asyncio
async def test_wc_empty_input():
    counts = await wc(b"")
    assert counts == WCCounts(lines=0,
                              words=0,
                              bytes_=0,
                              chars=0,
                              max_line_length=0)


@pytest.mark.asyncio
async def test_wc_lines_with_trailing_newline():
    counts = await wc(b"a\nb\nc\n")
    assert counts.lines == 3


@pytest.mark.asyncio
async def test_wc_lines_without_trailing_newline():
    """POSIX: lines = number of \\n bytes. `a\\nb\\nc` has 2 newlines."""
    counts = await wc(b"a\nb\nc")
    assert counts.lines == 2


@pytest.mark.asyncio
async def test_wc_words_single_line():
    counts = await wc(b"one two three")
    assert counts.words == 3


@pytest.mark.asyncio
async def test_wc_words_multiline():
    counts = await wc(b"one two\nthree four five\nsix\n")
    assert counts.words == 6


@pytest.mark.asyncio
async def test_wc_words_leading_trailing_whitespace():
    """POSIX: leading/trailing whitespace doesn't add words."""
    counts = await wc(b"   hello   world   ")
    assert counts.words == 2


@pytest.mark.asyncio
async def test_wc_words_only_whitespace():
    counts = await wc(b"   \t  \n  ")
    assert counts.words == 0


@pytest.mark.asyncio
async def test_wc_bytes_ascii():
    counts = await wc(b"hello")
    assert counts.bytes_ == 5
    assert counts.chars == 5


@pytest.mark.asyncio
async def test_wc_chars_vs_bytes_multibyte_utf8():
    """`café` is 4 chars / 5 bytes (é is 2 bytes in UTF-8)."""
    data = "café".encode()
    counts = await wc(data)
    assert counts.bytes_ == 5
    assert counts.chars == 4


@pytest.mark.asyncio
async def test_wc_chars_vs_bytes_pure_multibyte():
    data = "ééé".encode()
    counts = await wc(data)
    assert counts.bytes_ == 6
    assert counts.chars == 3


@pytest.mark.asyncio
async def test_wc_max_line_length_empty():
    counts = await wc(b"")
    assert counts.max_line_length == 0


@pytest.mark.asyncio
async def test_wc_max_line_length_single_line_with_newline():
    counts = await wc(b"hello\n")
    assert counts.max_line_length == 5


@pytest.mark.asyncio
async def test_wc_max_line_length_picks_longest():
    counts = await wc(b"short\na much longer line\nmed\n")
    assert counts.max_line_length == len(b"a much longer line")


@pytest.mark.asyncio
async def test_wc_max_line_length_no_trailing_newline():
    counts = await wc(b"hello world")
    assert counts.max_line_length == 11


@pytest.mark.asyncio
async def test_wc_streams_chunked():
    """Streaming through chunk boundaries gives same counts as buffered."""

    async def src():
        yield b"hello "
        yield b"world\n"
        yield b"foo bar\n"

    counts = await wc(src())
    assert counts.lines == 2
    assert counts.words == 4
    assert counts.bytes_ == 20


@pytest.mark.asyncio
async def test_wc_word_split_across_chunks():
    """A word straddling a chunk boundary still counts as one word."""

    async def src():
        yield b"hel"
        yield b"lo"
        yield b" world\n"

    counts = await wc(src())
    assert counts.words == 2
    assert counts.lines == 1


@pytest.mark.asyncio
async def test_wc_utf8_split_across_chunks_does_not_lose_chars():
    """A multibyte UTF-8 sequence split across chunks must still decode."""

    async def src():
        # é = b"\xc3\xa9" — split between the two bytes
        yield b"caf\xc3"
        yield b"\xa9"

    counts = await wc(src())
    assert counts.bytes_ == 5
    assert counts.chars == 4


@pytest.mark.asyncio
async def test_wc_byte_by_byte_chunking():
    """Worst-case chunking: every byte its own chunk."""

    async def src():
        for byte in b"hello world\nfoo bar\n":
            yield bytes([byte])

    counts = await wc(src())
    assert counts.lines == 2
    assert counts.words == 4
    assert counts.bytes_ == 20


@pytest.mark.asyncio
async def test_wc_binary_input_does_not_crash():
    """`errors='replace'` must let arbitrary bytes pass — count bytes
    accurately even when UTF-8 decoding produces replacement chars."""
    data = bytes(range(256))
    counts = await wc(data)
    assert counts.bytes_ == 256
    assert counts.lines == 1  # one \n at byte 0x0a


@pytest.mark.asyncio
async def test_wc_lines_fast_path_matches_full():
    """`wc_lines` fast path must agree with the full counter."""
    data = b"alpha\nbeta\ngamma\ndelta\n"
    fast = await wc_lines(data)
    full = await wc(data)
    assert fast == full.lines == 4


@pytest.mark.asyncio
async def test_wc_lines_fast_path_no_trailing_newline():
    assert await wc_lines(b"a\nb\nc") == 2


@pytest.mark.asyncio
async def test_wc_lines_fast_path_empty():
    assert await wc_lines(b"") == 0


def test_format_wc_default_no_label():
    counts = WCCounts(lines=2, words=4, bytes_=20)
    assert format_wc(counts) == "2\t4\t20"


def test_format_wc_default_with_label():
    counts = WCCounts(lines=2, words=4, bytes_=20)
    assert format_wc(counts, label="/f.txt") == "2\t4\t20\t/f.txt"


def test_format_wc_args_l():
    counts = WCCounts(lines=2, words=4, bytes_=20)
    assert format_wc(counts, args_l=True) == "2"
    assert format_wc(counts, args_l=True, label="/f.txt") == "2\t/f.txt"


def test_format_wc_w_c_m():
    counts = WCCounts(lines=2, words=4, bytes_=20, chars=18)
    assert format_wc(counts, w=True) == "4"
    assert format_wc(counts, c=True) == "20"
    assert format_wc(counts, m=True) == "18"


def test_format_wc_L_wins_when_both_set():
    """L has highest precedence (matching wrapper behavior)."""
    counts = WCCounts(lines=2, max_line_length=11)
    assert format_wc(counts, args_l=True, L=True) == "11"


def test_format_wc_precedence_l_over_w_c_m():
    """args_l > w > c > m precedence."""
    counts = WCCounts(lines=2, words=4, bytes_=20, chars=18)
    assert format_wc(counts, args_l=True, w=True) == "2"


def test_wc_counts_merge():
    a = WCCounts(lines=2, words=4, bytes_=20, chars=18, max_line_length=11)
    b = WCCounts(lines=1, words=2, bytes_=8, chars=8, max_line_length=20)
    a.merge(b)
    assert a.lines == 3
    assert a.words == 6
    assert a.bytes_ == 28
    assert a.chars == 26
    assert a.max_line_length == 20
