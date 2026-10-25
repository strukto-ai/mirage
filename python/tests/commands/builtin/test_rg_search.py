# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========


import pytest

from mirage.commands.builtin.generic.rg import parse_flags
from mirage.commands.builtin.rg_search import (
    RgBinary,
    RgFlags,
    Tally,
    smart_case_folds,
    transcoded,
)
from mirage.commands.builtin.rg_stream import open_rg, stream_haystack
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView


def _flags(**flags) -> RgFlags:
    return parse_flags(FlagView(flags, spec=SPECS["rg"]))


async def _source(data: bytes):
    yield data


async def _search(
    data: bytes, pattern: str, label: str | None = None, **flags
) -> tuple[str, bool]:
    f = _flags(**flags)
    tally = Tally()
    chunks = [
        c
        async for c in stream_haystack(
            _source(data),
            open_rg(pattern, False, f),
            f,
            "f",
            label,
            tally,
            True,
            False,
        )
    ]
    return b"".join(chunks).decode(), tally.selected


@pytest.mark.parametrize(
    "pattern, fixed, folds",
    [
        ("hello", False, True),
        ("Hello", False, False),
        (r"\w+", False, False),
        (r"\Whello", False, True),
        ("[A-Z]", False, False),
        ("a{2}", False, True),
        (r"\x41", False, False),
        ("H.llo", True, False),
    ],
)
def test_smart_case_folds_only_an_all_lowercase_pattern(pattern, fixed, folds):
    assert smart_case_folds(pattern, fixed) is folds


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags, want",
    [
        ({}, "a1\na2\n"),
        ({"after_context": "1"}, "a1\na2\nb\n"),
        ({"count": True}, "2\n"),
        ({"passthru": True}, "a1\na2\nb\n"),
        ({"invert_match": True}, "b\nc\n"),
    ],
)
async def test_stop_on_nonmatch_ends_the_file_where_ripgrep_does(flags, want):
    # ripgrep 14.1.1 over `a1 a2 b a3 c` with --stop-on-nonmatch.
    out, _ = await _search(
        b"a1\na2\nb\na3\nc\n", "a", stop_on_nonmatch=True, **flags
    )
    assert out == want


@pytest.mark.asyncio
async def test_whole_word_uses_half_boundaries():
    # ripgrep 14.1.1: -w is \b{start-half}...\b{end-half}, so `-foo`
    # matches after a space, which \b-foo\b never does.
    out, _ = await _search(b"a -foo b\nx-foo\n", "-foo", word_regexp=True)
    assert out == "a -foo b\n"


@pytest.mark.asyncio
async def test_the_later_of_w_and_x_bounds_the_pattern():
    data = b"hello there\nhello\n"
    out, _ = await _search(data, "hello", line_regexp=True, word_regexp=True)
    assert out == "hello there\nhello\n"
    out, _ = await _search(data, "hello", word_regexp=True, line_regexp=True)
    assert out == "hello\n"


@pytest.mark.asyncio
async def test_vimgrep_prints_a_record_per_match_with_its_column():
    out, _ = await _search(b"ab ab\n", "ab", "/m", vimgrep=True)
    assert out == "/m:1:1:ab ab\n/m:1:4:ab ab\n"
    out, _ = await _search(
        b"ab ab\n", "ab", "/m", vimgrep=True, no_column=True
    )
    assert out == "/m:1:ab ab\n/m:1:ab ab\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags, want",
    [
        ({"max_columns": "3"}, "[Omitted long matching line]\n"),
        (
            {"max_columns": "3", "column": True},
            "1:1:[Omitted long line with 2 matches]\n",
        ),
        (
            {"max_columns": "3", "max_columns_preview": True},
            "ab  [... omitted end of long line]\n",
        ),
    ],
)
async def test_max_columns_words_what_it_left_out(flags, want):
    out, _ = await _search(b"ab ab\n", "ab", **flags)
    assert out == want


@pytest.mark.asyncio
async def test_only_matching_offsets_count_bytes():
    out, _ = await _search(
        "café abc abc\n".encode(), "abc", only_matching=True, byte_offset=True
    )
    assert out == "6:abc\n10:abc\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags, expected",
    [
        ({"line_number": True, "byte_offset": True}, "1:0:a\x005:8:a\x00"),
        ({"count": True}, "2\0"),
        ({"files_with_matches": True}, "f\0"),
        ({"after_context": "1"}, "a\0b\0--\0a\0"),
        ({"only_matching": True}, "a\0a\0"),
        ({"max_count": "1"}, "a\0"),
    ],
)
async def test_null_data_records(flags, expected):
    actual, selected = await _search(
        b"a\0b\0c\0d\0a", "a", null_data=True, **flags
    )
    assert actual == expected
    assert selected


@pytest.mark.asyncio
@pytest.mark.parametrize("flags", [{}, {"line_regexp": True}])
async def test_null_data_anchors_match_embedded_newlines(flags):
    actual, selected = await _search(b"a\nb\0", "^a$", null_data=True, **flags)
    assert actual == "a\nb\0"
    assert selected


# ripgrep 14.1.1 through PCRE2: `rg -oP`, `-r`, `-b` and `--column`
# report the match from its last `\K`.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "pattern,flags,out",
    [
        (r"a\Ka", {"only_matching": True, "pcre2": True}, "a\n"),
        (
            r"a\Kbc",
            {"only_matching": True, "byte_offset": True, "pcre2": True},
            "1:bc\n",
        ),
        (r"a\Kbc", {"column": True, "pcre2": True}, "1:2:abc\n"),
        (r"a\Kb", {"replace": "X", "pcre2": True}, "aXc\n"),
        (r"a\K(b)", {"replace": "[$1]", "pcre2": True}, "a[b]c\n"),
        ("(?<=id=)[0-9]+", {"only_matching": True, "pcre2": True}, "42\n"),
    ],
)
async def test_pcre2_reports_the_kept_part(pattern, flags, out):
    data = (
        b"id=42\n"
        if "id" in pattern
        else (b"aaa\n" if pattern == r"a\Ka" else b"abc\n")
    )
    assert (await _search(data, pattern, **flags))[0] == out


def test_the_engine_is_the_last_one_the_line_names():
    assert _flags().engine == "default"
    assert (
        parse_flags(FlagView({"pcre2": True}, spec=SPECS["rg"])).engine
        == "pcre2"
    )
    assert _flags(engine="auto").engine == "auto"
    with pytest.raises(UsageError) as caught:
        _flags(engine="foo")
    assert str(caught.value) == (
        "rg: error parsing flag --engine: unrecognized regex engine 'foo'"
    )


@pytest.mark.asyncio
async def test_auto_falls_back_to_pcre2_only_when_the_default_refuses():
    assert await _search(b"aa\nab\n", r"(a)\1", engine="auto") == (
        "aa\n",
        True,
    )
    with pytest.raises(UsageError) as caught:
        open_rg(r"(a)\1", False, _flags())
    assert "backreferences are not supported" in str(caught.value)


async def _read_all(binary: RgBinary, source) -> list[bytes]:
    return [block async for block in binary.read(source)]


@pytest.mark.asyncio
async def test_a_walked_files_first_buffer_ends_at_a_nul_as_it_arrives():
    # The first buffer is still growing toward its first newline, so the
    # NUL is in it and ripgrep reads no further.
    async def source():
        yield b"x" * 10000 + b"\0"
        raise AssertionError("read past the NUL")

    binary = RgBinary("quit")
    assert await _read_all(binary, source()) == []
    assert (binary.skipped, binary.offset) == (True, 10000)


@pytest.mark.asyncio
async def test_a_files_first_read_joins_the_served_chunks_once():
    # Twenty 8 KiB chunks with no newline grow one first buffer; the file
    # ends before the step past the newline, so it is all one read.
    async def source():
        for _ in range(20):
            yield b"y" * 8192
        yield b"\nz\n"

    binary = RgBinary("quit")
    assert await _read_all(binary, source()) == [b"y" * 163840 + b"\nz\n"]
    assert binary.offset is None


async def _parts(*parts: bytes):
    for part in parts:
        yield part


# encoding_rs_io as ripgrep 14.1.1 runs it: a mark is dropped wherever the
# chunks split it, a UTF-16 mark overrides -E and a UTF-8 one does not,
# and only a decoder drops a second mark of its own.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "encoding, parts, want",
    [
        ("auto", (b"\xef", b"\xbb\xbfcaf\xe9"), b"caf\xe9"),
        ("auto", (b"\xff\xfeh\x00", b"i\x00"), b"hi"),
        ("windows-1252", (b"\xef\xbb\xbfcaf\xe9",), "café".encode()),
        ("UTF-16LE", (b"\xfe\xff\x00h",), b"h"),
        ("UTF-8", (b"\xef\xbb\xbf\xef\xbb\xbfhi",), b"hi"),
        ("auto", (b"\xef\xbb\xbf\xef\xbb\xbfhi",), b"\xef\xbb\xbfhi"),
        ("UTF-8", (b"caf\xe9",), "caf\ufffd".encode()),
        ("auto", (), b""),
    ],
)
async def test_transcoded_reads_marks_as_ripgrep(encoding, parts, want):
    got = [c async for c in transcoded(_parts(*parts), encoding)]
    assert b"".join(got) == want


@pytest.mark.asyncio
async def test_transcoded_closes_its_source():
    closed = []

    async def source():
        try:
            yield b"abc"
            yield b"def"
        finally:
            closed.append(True)

    stream = transcoded(source(), "auto")
    assert await anext(stream) == b"abc"
    await stream.aclose()
    assert closed == [True]


@pytest.mark.asyncio
async def test_search_decodes_what_E_names():
    assert await _search(b"\xff\xfeh\x00i\x00\n\x00", "hi") == ("hi\n", True)
    assert await _search(b"caf\xe9\n", "café", encoding="latin1") == (
        "café\n",
        True,
    )
    assert await _search(b"\xef\xbb\xbfhi\n", "^hi", encoding="none") == (
        "",
        False,
    )


@pytest.mark.parametrize(
    "flags, want",
    [
        ({}, "auto"),
        ({"encoding": "latin1"}, "windows-1252"),
        ({"encoding": "none"}, "none"),
        ({"encoding": "latin1", "no_encoding": True}, "auto"),
    ],
)
def test_E_resolves_to_an_encoding(flags, want):
    assert _flags(**flags).encoding == want


def test_E_refuses_a_label_naming_no_encoding():
    with pytest.raises(UsageError, match="unknown encoding: utf16le$"):
        _flags(encoding="utf16le")
