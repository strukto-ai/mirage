import pytest

from mirage.commands.builtin.generic.wc import (WCCounts, format_multi,
                                                format_wc, wc, wc_lines)
from mirage.types import PathSpec


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
    assert format_wc(counts) == "      2       4      20"


def test_format_wc_default_with_label():
    counts = WCCounts(lines=2, words=4, bytes_=20)
    assert format_wc(counts, label="/f.txt") == " 2  4 20 /f.txt"


def test_format_wc_args_l():
    counts = WCCounts(lines=2, words=4, bytes_=20)
    assert format_wc(counts, args_l=True) == "2"
    assert format_wc(counts, args_l=True, label="/f.txt") == "2 /f.txt"


def test_format_wc_w_c_m():
    counts = WCCounts(lines=2, words=4, bytes_=20, chars=18)
    assert format_wc(counts, w=True) == "4"
    assert format_wc(counts, c=True) == "20"
    assert format_wc(counts, m=True) == "18"


def test_format_wc_combines_lines_and_max_line_length():
    counts = WCCounts(lines=2, max_line_length=11)
    assert format_wc(counts, args_l=True, L=True) == "      2      11"


def test_format_wc_combines_selected_counts_in_canonical_order():
    counts = WCCounts(lines=2, words=4, bytes_=20, chars=18)
    assert format_wc(counts, args_l=True, w=True, c=True,
                     m=True) == "      2       4      18      20"


def test_wc_counts_merge():
    a = WCCounts(lines=2, words=4, bytes_=20, chars=18, max_line_length=11)
    b = WCCounts(lines=1, words=2, bytes_=8, chars=8, max_line_length=20)
    a.merge(b)
    assert a.lines == 3
    assert a.words == 6
    assert a.bytes_ == 28
    assert a.chars == 26
    assert a.max_line_length == 20


@pytest.mark.asyncio
async def test_format_multi_single_path_emits_trailing_newline():
    paths = [PathSpec.from_str_path("/a.txt")]

    async def fake_read(_path):
        return b"hello\n"

    out, err = await format_multi(paths, read=fake_read, args_l=True)
    assert out == b"1 /a.txt\n"
    assert err == b""


@pytest.mark.asyncio
async def test_format_multi_multi_path_emits_total_and_trailing_newline():
    paths = [
        PathSpec.from_str_path("/a.txt"),
        PathSpec.from_str_path("/b.txt"),
    ]
    data = {"/a.txt": b"hello\n", "/b.txt": b"world\nworld\n"}

    async def fake_read(path):
        return data[path.virtual]

    out, err = await format_multi(paths, read=fake_read, args_l=True)
    assert err == b""
    assert out.endswith(b"\n")
    lines = out.decode().rstrip("\n").split("\n")
    assert lines == ["1 /a.txt", "2 /b.txt", "3 total"]


@pytest.mark.asyncio
async def test_format_multi_accepts_sync_read_returning_bytes():
    paths = [PathSpec.from_str_path("/a.txt")]

    def sync_read(_path):
        return b"x\n"

    out, err = await format_multi(paths, read=sync_read, args_l=True)
    assert out == b"1 /a.txt\n"
    assert err == b""


@pytest.mark.asyncio
async def test_format_multi_empty_paths_returns_empty():

    async def fake_read(_path):
        return b""

    out, err = await format_multi([], read=fake_read, args_l=True)
    assert out == b""
    assert err == b""


@pytest.mark.asyncio
async def test_format_multi_missing_operand_reports_and_totals():
    paths = [
        PathSpec.from_str_path("/a.txt"),
        PathSpec.from_str_path("/m.txt"),
    ]

    async def fake_read(path):
        if path.virtual == "/m.txt":
            raise FileNotFoundError(path.virtual)
        return b"hello\n"

    out, err = await format_multi(paths, read=fake_read, args_l=True)
    assert out == b"1 /a.txt\n1 total\n"
    assert err == b"wc: /m.txt: No such file or directory\n"


@pytest.mark.asyncio
async def test_format_multi_all_missing_zero_total():
    paths = [
        PathSpec.from_str_path("/m1.txt"),
        PathSpec.from_str_path("/m2.txt"),
    ]

    async def fake_read(path):
        raise FileNotFoundError(path.virtual)

    out, err = await format_multi(paths, read=fake_read, args_l=True)
    assert out == b"0 total\n"
    assert err == (b"wc: /m1.txt: No such file or directory\n"
                   b"wc: /m2.txt: No such file or directory\n")


async def _async_byte_read(_path):
    yield b"hello "
    yield b"world\n"


@pytest.mark.asyncio
async def test_format_multi_accepts_async_iterator_read():
    paths = [PathSpec.from_str_path("/a.txt")]

    out, err = await format_multi(paths, read=_async_byte_read, args_l=True)
    assert out == b"1 /a.txt\n"
    assert err == b""
