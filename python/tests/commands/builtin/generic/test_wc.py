import pytest

from mirage.commands.builtin.generic.wc import (
    WCCounts,
    format_multi,
    format_wc_lines,
    number_width,
    parse_flags,
    wc,
)
from mirage.commands.errors import UsageError
from mirage.io.types import CountedRun
from mirage.types import PathSpec


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data,field,value",
    [
        (b"   hello   world   ", "words", 2),
        (b"hello world", "max_line_length", 11),
        (bytes(range(256)), "bytes_", 256),
    ],
)
async def test_wc_counts(data, field, value):
    # POSIX words ignore surrounding blanks, an unterminated last line is
    # measured, and arbitrary bytes count without a decode error.
    assert getattr(await wc(data), field) == value


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "chunks,expected",
    [
        (
            [b"hello ", b"world\n", b"foo bar\n"],
            WCCounts(
                lines=2, words=4, bytes_=20, chars=20, max_line_length=11
            ),
        ),
        (
            [b"hel", b"lo", b" world\n"],
            WCCounts(
                lines=1, words=2, bytes_=12, chars=12, max_line_length=11
            ),
        ),
        (
            [b"caf\xc3", b"\xa9"],
            WCCounts(lines=0, words=1, bytes_=5, chars=4, max_line_length=4),
        ),
        (
            [bytes([byte]) for byte in b"hello world\nfoo bar\n"],
            WCCounts(
                lines=2, words=4, bytes_=20, chars=20, max_line_length=11
            ),
        ),
    ],
)
async def test_wc_counts_the_same_across_chunk_boundaries(
    chunks: list[bytes], expected: WCCounts
):

    async def src():
        for chunk in chunks:
            yield chunk

    assert await wc(src()) == expected


@pytest.mark.asyncio
async def test_wc_binary_input_does_not_crash():
    """`errors='replace'` must let arbitrary bytes pass — count bytes
    accurately even when UTF-8 decoding produces replacement chars."""
    data = bytes(range(256))
    counts = await wc(data)
    assert counts.bytes_ == 256
    assert counts.lines == 1  # one \n at byte 0x0a


def _fmt(counts, **kw):
    label = kw.pop("label", None)
    return format_wc_lines([(counts, label)], **kw)[0]


def test_format_wc_lines_quotes_only_a_name_holding_a_newline():
    # coreutils 9.7 wc.c: `strchr (file, '\n') ? quotef (file) : file`.
    counts = WCCounts(lines=2)
    assert _fmt(counts, lines=True, label="/a/n\nq") == "2 '/a/n'$'\\n''q'"
    assert _fmt(counts, lines=True, label="/a/b c") == "2 /a/b c"


def test_format_wc_lines_combines_selected_counts_in_canonical_order():
    counts = WCCounts(lines=2, words=4, bytes_=20, chars=18)
    assert (
        _fmt(counts, lines=True, words=True, bytes_=True, chars=True)
        == "      2       4      18      20"
    )


def _sync_read(_path):
    return b"x\n"


async def _async_byte_read(_path):
    yield b"hello "
    yield b"world\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("read", [_sync_read, _async_byte_read])
async def test_format_multi_accepts_a_sync_or_async_iterator_read(read):
    paths = [PathSpec.from_str_path("/a.txt")]
    assert await format_multi(paths, read=read, lines=True) == (
        b"1 /a.txt\n",
        b"",
        [CountedRun((1,), "/a.txt")],
    )


@pytest.mark.asyncio
async def test_format_multi_empty_paths_returns_empty():

    async def fake_read(_path):
        return b""

    out, err, _ = await format_multi([], read=fake_read, lines=True)
    assert out == b""
    assert err == b""


@pytest.mark.asyncio
async def test_format_multi_all_missing_zero_total():
    paths = [
        PathSpec.from_str_path("/m1.txt"),
        PathSpec.from_str_path("/m2.txt"),
    ]

    async def fake_read(path):
        raise FileNotFoundError(path.virtual)

    out, err, runs = await format_multi(paths, read=fake_read, lines=True)
    assert runs == []
    assert out == b"0 total\n"
    assert err == (
        b"wc: /m1.txt: No such file or directory\n"
        b"wc: /m2.txt: No such file or directory\n"
    )


# GNU's ARGMATCH refusal names the refused word through gnulib's quote(),
# so a byte outside 0x20-0x7e comes back escaped. Rows measured against
# GNU coreutils 9.4 under `LC_ALL=C` with a raw `bytes` argv
# (`wc --total=<w>`). Mirrored in wc.test.ts.
@pytest.mark.parametrize(
    "value,escaped",
    [
        ("xé", r"x\303\251"),
        ("x\r", r"x\r"),
    ],
)
def test_total_refusal_quotes_the_word(value, escaped):
    with pytest.raises(UsageError) as exc:
        parse_flags({"total": value})
    assert str(exc.value).startswith(
        f"wc: invalid argument '{escaped}' for '--total'\n"
    )


def test_an_empty_total_is_ambiguous_not_the_default():
    """`wc --total=` is `ambiguous argument ''`, exit 1 (measured).

    python used to read the empty word as the `auto` default and exit 0
    through an `or "auto"` fallback, which was also the one py/ts split
    at this slot -- TypeScript refused it.
    """
    with pytest.raises(UsageError) as exc:
        parse_flags({"total": ""})
    assert str(exc.value).startswith(
        "wc: ambiguous argument '' for '--total'\n"
    )
    assert exc.value.exit_code == 1


# `wc --total=al` is `always` and `--total=au` is `auto` (measured,
# coreutils 9.4), while the bare `a` they share spans two values.
def test_total_accepts_an_unambiguous_prefix():
    assert parse_flags({"total": "al"}).total == "always"
    assert parse_flags({"total": "au"}).total == "auto"


@pytest.mark.parametrize(
    "sizes,operands,counts,width",
    [
        ([None, 24], 2, 1, 7),
        ([123456789], 2, 1, 9),
    ],
)
def test_number_width_follows_the_operands(sizes, operands, counts, width):
    # coreutils 9.7: one operand with one count is unpadded; otherwise the
    # regular files' total size, at least 7 beside a stream or directory.
    assert number_width(sizes, operands, counts) == width
