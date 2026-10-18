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

import asyncio
import json

import jq as libjq
import pytest

from mirage.core.jq.stream import (
    InputReader,
    read_texts,
    value_text,
)
from mirage.core.jq.types import NO_VALUE, InputSource, JqOptions, JqParseError


async def _chunks(data: bytes, size: int):
    for at in range(0, len(data), size):
        yield data[at : at + size]


def _sources(*inputs: bytes, size: int = 1 << 20) -> list[InputSource]:
    return [
        InputSource(f"f{i}.json", _chunks(data, size))
        for i, data in enumerate(inputs)
    ]


def _parsed(text):
    # The value jq's parser reads the text as, which is what libjq runs on.
    assert isinstance(text, str)
    if "\\ud" not in text.lower():
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return libjq.compile(".").input_text(text).first()
    return libjq.compile(".").input_text(text).first()


async def _read(
    sources: list[InputSource],
    opts: JqOptions = JqOptions(),
    texts: bool = False,
) -> list[tuple]:
    reader = InputReader(sources, opts)
    out: list[tuple] = []
    try:
        while True:
            text = await reader.next_input()
            if text is NO_VALUE:
                return out
            if isinstance(text, JqParseError):
                out.append(("error", text.message, reader.position()))
                if not opts.seq:
                    return out
                continue
            out.append((text if texts else _parsed(text), reader.position()))
    finally:
        await reader.close()


async def _values(*inputs: bytes, opts: JqOptions = JqOptions()) -> list:
    return [row[0] for row in await _read(_sources(*inputs), opts)]


async def _texts(
    *inputs: bytes, opts: JqOptions = JqOptions(), size: int = 1 << 20
) -> list:
    return [
        row[0] for row in await _read(_sources(*inputs, size=size), opts, True)
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [1, 3, 1 << 20])
async def test_the_inputs_are_one_stream_for_one_parser(size):
    # A value runs on from one input into the next (pinned: `12`).
    assert [
        row[0] for row in await _read(_sources(b"1", b"2", size=size))
    ] == [12]
    assert [
        row[0] for row in await _read(_sources(b"[1,", b"2]", size=size))
    ] == [[1, 2]]


@pytest.mark.asyncio
async def test_a_value_is_placed_where_the_reader_holds_it_whole():
    # `1` completes at the space the second input starts with, by when
    # the reader has opened that input and read its first line.
    assert await _read(_sources(b"1", b" 2\n")) == [
        (1, "f1.json:1"),
        (2, "f1.json:1"),
    ]
    assert await _read(_sources(b"1\n", b"2\n3")) == [
        (1, "f0.json:1"),
        (2, "f1.json:1"),
        (3, "f1.json:1"),
    ]
    assert await _read(_sources(b"1\n2\n", b"[3,\n4]\n5")) == [
        (1, "f0.json:1"),
        (2, "f0.json:2"),
        ([3, 4], "f1.json:2"),
        (5, "f1.json:2"),
    ]


def _lines_before(rows: list[tuple], count: int) -> tuple[int, int]:
    lines = [int(position.rsplit(":", 1)[1]) for _, position in rows[:count]]
    return lines.count(0), lines.count(1)


@pytest.mark.asyncio
async def test_a_long_line_counts_once_the_reader_holds_its_last_piece():
    # jq 1.8.2 reads a long line 4091 bytes at a time: of 4095 values on
    # one 8190-byte line, only the last four arrive with its newline.
    rows = await _read(_sources(b"1 " * 4095 + b"\n2\n"))
    assert _lines_before(rows, 4095) == (4091, 4)


@pytest.mark.asyncio
async def test_a_piece_reads_on_to_the_end_of_a_character():
    # The first piece ends inside an é, reads one more byte to finish it,
    # and so every later piece starts a byte on (pinned: 2044 and 56).
    text = ('"a' + "é" * 2045 + '"  ' + "1 " * 2100 + "\n").encode()
    rows = await _read(_sources(text))
    assert _lines_before(rows[1:], 2100) == (2044, 56)


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [1, 5, 1 << 20])
async def test_json_lines_read_one_line_at_a_time(size):
    data = b'{"a":1}\n{"a":2}\n\n{"a":3}\n'
    assert await _read(_sources(data, size=size)) == [
        ({"a": 1}, "f0.json:1"),
        ({"a": 2}, "f0.json:2"),
        ({"a": 3}, "f0.json:4"),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [1, 5, 1 << 20])
async def test_a_pretty_printed_document_reads_whole(size):
    data = b'{\n  "a": [\n    1,\n    2\n  ]\n}\n{\n  "b": 3\n}\n'
    assert await _read(_sources(data, size=size)) == [
        ({"a": [1, 2]}, "f0.json:6"),
        ({"b": 3}, "f0.json:9"),
    ]


async def _unending(data: bytes):
    yield data
    await asyncio.Event().wait()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data,value",
    [
        (b'{\n  "a": [\n    1\n  ]\n}\n', {"a": [1]}),
        (b"[\n  1,\n  2\n]\n{\n", [1, 2]),
        (b'{\n"a": 1}\n', {"a": 1}),
    ],
)
async def test_a_document_is_handed_over_before_the_input_ends(data, value):
    # Nothing past a document's closing line is read before it is handed
    # over, so an input that has not ended yet still yields it.
    reader = InputReader(
        [InputSource("f0.json", _unending(data))], JqOptions()
    )
    try:
        assert _parsed(await asyncio.wait_for(reader.next_input(), 5)) == value
    finally:
        await reader.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [1, 7, 1 << 20])
async def test_a_document_not_pretty_printed_goes_to_jqs_parser(size):
    data = b'{\n"a": 1}\n{\n  "b": 2 }\n[\n  nan\n]\n'
    rows = await _read(_sources(data, size=size))
    assert rows[:2] == [({"a": 1}, "f0.json:2"), ({"b": 2}, "f0.json:4")]
    assert rows[2][0][0] is None and rows[2][1] == "f0.json:7"


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [1, 5, 1 << 20])
async def test_a_value_is_handed_over_as_the_text_it_was_read_from(size):
    # jq keeps a number's literal and an object's key order, so libjq is
    # handed the bytes, not a value built from them.
    data = (
        b'{"b":1.000,"1":2}\n{\n  "n": 100000000000000000001,\n'
        b'  "e": 1e2\n}\n[1.10, -0] "\\u00e9" nan\n'
    )
    assert await _texts(data, size=size) == [
        '{"b":1.000,"1":2}',
        '{\n  "n": 100000000000000000001,\n  "e": 1e2\n}',
        "[1.10, -0]",
        '"\\u00e9"',
        "nan",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [1, 1 << 20])
async def test_a_value_that_runs_on_across_inputs_is_one_text(size):
    assert await _texts(b"1.", b"000", size=size) == ["1.000"]
    assert await _texts(b"[1.0,", b' {"b":1,', b'"1":2}]', size=size) == [
        '[1.0, {"b":1,"1":2}]'
    ]


@pytest.mark.asyncio
async def test_a_text_leaves_the_bom_out_and_replaces_bad_utf8_as_jq_does():
    assert await _texts(b"\xef\xbb\xbf1.000\n") == ["1.000"]
    assert await _texts(b'["\xff", 1.000]') == [
        '["\N{REPLACEMENT CHARACTER}", 1.000]'
    ]


@pytest.mark.asyncio
async def test_raw_lines_seq_stream_and_slurp_hand_over_text():
    assert await _texts(b'a"b\n', opts=JqOptions(raw_input=True)) == [
        '"a\\"b"'
    ]
    seq = JqOptions(seq=True)
    assert await _texts(b'\x1e1.000\n\x1e{"b":1,"1":2}\n', opts=seq) == [
        "1.000",
        '{"b":1,"1":2}',
    ]
    stream = JqOptions(stream=True)
    assert await _texts(b'{"b":1.000,"1":[2.50]}', opts=stream) == [
        '[["b"],1.000]',
        '[["1",0],2.50]',
        '[["1",0]]',
        '[["1"]]',
    ]
    slurp = JqOptions(slurp=True)
    assert await _texts(b'1.000 {"b":1,"1":2}\n', b"[1e2]", opts=slurp) == [
        '[1.000,{"b":1,"1":2},[1e2]]'
    ]
    assert await _texts(opts=slurp) == ["[]"]


@pytest.mark.asyncio
async def test_jqs_own_numbers_and_the_json_around_them():
    values = await _values(b'[1]\nnan\n{"a":.5}\n')
    assert values[0] == [1] and values[1] is None
    assert values[2] == {"a": 0.5}


@pytest.mark.asyncio
async def test_a_parse_error_ends_the_stream_after_the_values_before_it():
    assert await _read(_sources(b"1\n2\n", b"[")) == [
        (1, "f0.json:1"),
        (2, "f0.json:2"),
        (
            "error",
            "Unfinished JSON term at EOF at line 3, column 1",
            "f1.json:0",
        ),
    ]
    assert await _read(_sources(b'{"a":1}\n1 [')) == [
        ({"a": 1}, "f0.json:1"),
        (1, "f0.json:1"),
        (
            "error",
            "Unfinished JSON term at EOF at line 2, column 3",
            "f0.json:1",
        ),
    ]


@pytest.mark.asyncio
async def test_a_bom_is_stripped_from_the_start_of_the_stream_only():
    assert await _values(b"\xef\xbb\xbf1\n") == [1]
    assert await _read(_sources(b"\xef\xbb\xbf1\n", b"\xef\xbb\xbf2\n")) == [
        (1, "f0.json:1"),
        ("error", "Invalid numeric literal at line 3, column 0", "f1.json:1"),
    ]
    assert await _read(_sources(b"\xef\xbb1\n")) == [
        ("error", "Malformed BOM", "f0.json:1")
    ]
    # The BOM check goes on from one input into the next, as jq's one
    # parser keeps it.
    assert await _read(_sources(b"\xef", b"1\n")) == [
        ("error", "Malformed BOM", "f1.json:1")
    ]


@pytest.mark.asyncio
async def test_slurp_is_one_value_for_every_input():
    opts = JqOptions(slurp=True)
    assert await _values(b'{"a":1}', b' {"b":2}', opts=opts) == [
        [{"a": 1}, {"b": 2}]
    ]
    assert await _read(_sources(b"1\n", b"["), opts) == [
        (
            "error",
            "Unfinished JSON term at EOF at line 2, column 1",
            "f1.json:0",
        )
    ]


@pytest.mark.asyncio
async def test_raw_lines_run_on_from_one_input_into_the_next():
    raw = JqOptions(raw_input=True)
    assert await _values(b"x\ny", b"z\n", opts=raw) == ["x", "yz"]
    assert await _values(b"a\nb", opts=raw) == ["a", "b"]
    assert await _values(b"", opts=raw) == []
    assert await _values(b"\n", opts=raw) == [""]
    assert await _values("a\N{LINE SEPARATOR}b\n".encode(), opts=raw) == [
        "a\N{LINE SEPARATOR}b"
    ]
    assert await _values(b"a\xffb\n\xf0\x80\x80\x80\n", opts=raw) == [
        "a\N{REPLACEMENT CHARACTER}b",
        "\N{REPLACEMENT CHARACTER}",
    ]


@pytest.mark.asyncio
async def test_raw_slurp_is_every_input_as_one_string():
    opts = JqOptions(raw_input=True, slurp=True)
    assert await _values(b"x\n", b"y", opts=opts) == ["x\ny"]


@pytest.mark.asyncio
async def test_seq_reports_a_parse_error_and_reads_on():
    opts = JqOptions(seq=True)
    assert await _read(_sources(b"\x1e1\n\x1e[1 2]\n\x1e3\n"), opts) == [
        (1, "f0.json:1"),
        (
            "error",
            "Expected separator between values at line 2, column 6 "
            "(need RS to resync)",
            "f0.json:2",
        ),
        (3, "f0.json:3"),
    ]
    assert await _read(_sources(b'{"a":1}\n'), opts) == [
        (
            "error",
            "Unfinished abandoned text at EOF at line 2, column 0",
            "f0.json:1",
        )
    ]


@pytest.mark.asyncio
async def test_stream_hands_events_over_as_the_input_goes_by():
    opts = JqOptions(stream=True)
    assert await _read(_sources(b"[1,\n[2]]\n"), opts) == [
        ([[0], 1], "f0.json:1"),
        ([[1, 0], 2], "f0.json:2"),
        ([[1, 0]], "f0.json:2"),
        ([[1]], "f0.json:2"),
    ]
    assert await _read(_sources(b'{"a":[1,'), opts) == [
        ([["a", 0], 1], "f0.json:0"),
        (
            "error",
            "Unfinished JSON term at EOF at line 1, column 8",
            "f0.json:0",
        ),
    ]


@pytest.mark.asyncio
async def test_stream_and_slurp_collect_the_events():
    opts = JqOptions(stream=True, slurp=True)
    assert await _values(b"[1] [2]", opts=opts) == [
        [[[0], 1], [[0]], [[0], 2], [[0]]]
    ]


@pytest.mark.asyncio
async def test_no_input_at_all_reads_as_nothing():
    reader = InputReader([], JqOptions())
    try:
        assert await reader.next_input() is NO_VALUE
        assert reader.position() == "<unknown>"
    finally:
        await reader.close()


@pytest.mark.asyncio
async def test_an_empty_input_holds_no_documents():
    assert await _values(b"") == []
    assert await _values(b"  \n\n ") == []


async def _failing(exc: OSError, data: bytes = b"", size: int = 1 << 20):
    async for chunk in _chunks(data, size):
        yield chunk
    raise exc


async def _reported(
    sources: list[InputSource], opts: JqOptions = JqOptions()
) -> tuple[list, list[str], str, int]:
    reports: list[str] = []
    reader = InputReader(sources, opts, reports.append)
    values = []
    try:
        while (text := await reader.next_input()) is not NO_VALUE:
            values.append(_parsed(text))
        return values, reports, reader.position(), reader.failures()
    finally:
        await reader.close()


MISSING = (
    "jq: error: Could not open file missing.json: No such file or directory\n"
)


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [1, 1 << 20])
async def test_an_input_that_cannot_be_opened_is_reported_and_read_past(size):
    # jq's reader names the input fopen refused and goes on to the next,
    # and a value runs on across it (pinned: `[1,`, missing, `2]`).
    sources = [
        InputSource("a.json", _chunks(b"[1,", size)),
        InputSource("missing.json", _failing(FileNotFoundError("missing"))),
        InputSource("b.json", _chunks(b"2]\n", size)),
    ]
    assert await _reported(sources) == ([[1, 2]], [MISSING], "b.json:1", 1)


@pytest.mark.asyncio
async def test_the_reader_stands_on_a_failed_input_it_ends_on():
    # `jq -n input missing.json` fails at missing.json:0 (pinned).
    missing = InputSource(
        "missing.json", _failing(FileNotFoundError("missing"))
    )
    assert await _reported([missing]) == ([], [MISSING], "missing.json:0", 1)


@pytest.mark.asyncio
async def test_a_directory_fails_at_its_read_in_bare_words():
    # jq opens a directory and fails at its first read, which it reports
    # as the strerror alone (pinned: `jq: error: Is a directory`).
    sources = [
        InputSource("d", _failing(IsADirectoryError("d"))),
        *_sources(b"1\n"),
    ]
    assert await _reported(sources) == (
        [1],
        ["jq: error: Is a directory\n"],
        "f0.json:1",
        1,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [1, 1 << 20])
async def test_a_read_that_fails_midway_loses_the_line_it_was_reading(size):
    # fgets hands out every line before the failed read, and the line it
    # was reading goes with it: here the `]`, which the next input stands
    # in for.
    sources = [
        InputSource(
            "a.json", _failing(PermissionError("a"), b"1\n[\n  2\n]", size)
        ),
        *_sources(b",3]\n"),
    ]
    values, reports, _, failures = await _reported(sources)
    assert (values, reports, failures) == (
        [1, [2, 3]],
        ["jq: error: Permission denied\n"],
        1,
    )


@pytest.mark.asyncio
async def test_raw_lines_run_on_across_a_failed_input():
    # Pinned: `x`, missing.txt, `y\n` read under -R as "xy".
    sources = [
        InputSource("a.txt", _chunks(b"x", 8)),
        InputSource("missing.txt", _failing(FileNotFoundError("missing"))),
        InputSource("b.txt", _chunks(b"y\n", 8)),
    ]
    values, reports, _, _ = await _reported(sources, JqOptions(raw_input=True))
    assert values == ["xy"]
    assert reports == [MISSING.replace("missing.json", "missing.txt")]


@pytest.mark.asyncio
async def test_without_a_reporter_a_failed_input_raises():
    missing = InputSource(
        "missing.json", _failing(FileNotFoundError("missing"))
    )
    with pytest.raises(FileNotFoundError):
        await _read([missing])


@pytest.mark.asyncio
async def test_read_texts_reads_a_slurpfile_as_jq_does():
    source = InputSource("m.json", _chunks(b'{"a":1.0}\n{"a":2}\n', 4))
    assert await read_texts(source) == (['{"a":1.0}', '{"a":2}'], None)
    texts, failure = await read_texts(
        InputSource("bad.json", _chunks(b"1 [", 99))
    )
    assert texts == ["1"]
    assert failure == JqParseError(
        "Unfinished JSON term at EOF at line 1, column 3"
    )


@pytest.mark.asyncio
async def test_value_text_takes_one_value_as_jv_parse_does():
    assert (await value_text(b'{"b":1,"1":2.50}')) == '{"b":1,"1":2.50}'
    assert (await value_text(b"nan")) == "nan"
    assert (await value_text(b" 12 \n")) == "12"
    assert (await value_text(b"\xef\xbb\xbf1.0")) == "1.0"
    assert (await value_text(b"1 2")) is NO_VALUE
    assert (await value_text(b"")) is NO_VALUE
    assert (await value_text(b"nope")) is NO_VALUE
    assert (await value_text(b"[1,")) is NO_VALUE
