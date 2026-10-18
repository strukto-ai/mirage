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
import random
from pathlib import Path

import jq as libjq
import pytest

from mirage.core.jq.parse import (
    JqParser,
    decode_utf8,
    string_text,
    utf8_missing,
)
from mirage.core.jq.types import NO_VALUE, JqParseError

CASES = json.loads(
    (
        Path(__file__).resolve().parents[4] / "integ/fixtures/jq/scanner.json"
    ).read_text()
)


@pytest.mark.asyncio
@pytest.mark.parametrize("case", CASES)
@pytest.mark.parametrize("size", [1, 7, 4091])
async def test_scanner_preserves_text_and_diagnostics_across_chunks(
    case, size
):
    parser = JqParser(seq=case["seq"], streaming=case["streaming"])
    data = bytes.fromhex(case["input"])
    events = []
    stopped = False
    try:
        pieces = [
            data[at : at + size] for at in range(0, len(data), size)
        ] or [b""]
        for at, piece in enumerate(pieces):
            parser.feed(piece, at < len(pieces) - 1)
            while True:
                value = await parser.next()
                if value is NO_VALUE:
                    break
                if isinstance(value, JqParseError):
                    events.append(["error", value.message])
                    if not case["seq"]:
                        stopped = True
                        break
                else:
                    events.append(["text", value])
            if stopped:
                break
        assert events == case["events"]
    finally:
        await parser.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data,text",
    [
        (b"plain", "plain"),
        (b"\xf0\x80\x80\x80", "\N{REPLACEMENT CHARACTER}"),
        (b"\xed\xa0\x80", "\N{REPLACEMENT CHARACTER}"),
        (b"\xf4\x90\x80\x80", "\N{REPLACEMENT CHARACTER}"),
        (b"\xe2\x82", "\N{REPLACEMENT CHARACTER}"),
        (b"\xc0\x80", "\N{REPLACEMENT CHARACTER}\N{REPLACEMENT CHARACTER}"),
        (b"\xe2\x82x", "\N{REPLACEMENT CHARACTER}x"),
        (b"\xe2a", "\N{REPLACEMENT CHARACTER}"),
        (b"a\xffb", "a\N{REPLACEMENT CHARACTER}b"),
    ],
)
async def test_decode_utf8_replaces_each_bad_sequence_once(data, text):
    assert (await decode_utf8(data)) == text


def test_string_text_is_json_jq_reads_back():
    assert string_text('a"\\\n\x7fé') == '"a\\"\\\\\\n\x7fé"'


@pytest.mark.parametrize(
    "piece,missing",
    [
        (b"a", 0),
        (b"ab", 0),
        (b"a\xe2", 2),
        (b"a\xe2\x82", 1),
        (b"a\xe2\x82\xac", 0),
        (b"a\xf0\x9f", 2),
        (b"a\x80", 0),
        (b"a\xff", 0),
    ],
)
def test_utf8_missing(piece, missing):
    assert utf8_missing(piece) == missing


@pytest.mark.asyncio
async def test_large_unfinished_input_can_be_cancelled_and_discarded():
    parser = JqParser()
    parser.feed(b'"' + b"x" * (8 * 1024 * 1024), True)
    pending = asyncio.create_task(parser.next())
    try:
        await asyncio.sleep(0.02)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
    finally:
        await parser.close()


ALPHABET = [
    "{",
    "}",
    "[",
    "]",
    ":",
    ",",
    '"',
    "\\",
    " ",
    "\n",
    "\t",
    "1",
    "0",
    "-",
    "+",
    ".",
    "e",
    "E",
    "t",
    "r",
    "u",
    "n",
    "a",
    "f",
    "l",
    "s",
    "x",
    "\x01",
    "\x00",
    "é",
    '"a"',
    "true",
    "null",
    "false",
    "12",
    '"\\u00e9"',
    '"\\ud83d\\ude00"',
    '"\\ud800"',
    '"\\udc00"',
    "\\u",
    "nan",
    "NaN",
    "inf",
    "1e5",
    ".5",
    '"\\n"',
    '{"k":1}',
    "[1,2]",
    "'",
    "\N{ZERO WIDTH NO-BREAK SPACE}",
]
SEEDS = [
    '{"a":1,"b":[1,2,{"c":null}]}',
    "[1,2,3]",
    '"str"',
    "123",
    "true",
    '{"a":{"b":{"c":[true,false]}}}',
    '[{"x":"y"},{"z":[]}]',
    "1 2 3",
    '{"a":1}\n{"b":2}\n',
    "[]",
    "{}",
    "[[[]]]",
    "-0.5e10",
    '"a\\"b"',
]


def _mutant(rng: random.Random) -> str:
    if rng.random() < 0.5:
        return "".join(rng.choice(ALPHABET) for _ in range(rng.randint(0, 12)))
    text = list(rng.choice(SEEDS))
    for _ in range(rng.randint(0, 3)):
        at = rng.randint(0, len(text))
        roll = rng.random()
        if roll < 0.33 and text:
            del text[min(at, len(text) - 1)]
        elif roll < 0.66:
            text.insert(at, rng.choice(ALPHABET))
        elif text:
            text[min(at, len(text) - 1)] = rng.choice(ALPHABET)
    return "".join(text)


def _reference(text):
    dumps = []
    try:
        for dump in libjq.compile("tojson").input_text(text):
            dumps.append(dump)
    except ValueError as exc:
        return dumps, str(exc).removeprefix("parse error: ")
    return dumps, None


async def _scanned(data, size):
    parser = JqParser()
    texts = []
    try:
        for at in range(0, max(1, len(data)), size):
            parser.feed(data[at : at + size], at + size < len(data))
            while True:
                value = await parser.next()
                if value is NO_VALUE:
                    break
                if isinstance(value, JqParseError):
                    return texts, value.message
                texts.append(value)
        return texts, None
    finally:
        await parser.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [None, 1], ids=["whole", "bytewise"])
async def test_parser_agrees_with_libjq_on_generated_input(size):
    rng = random.Random(1325)
    for case in range(3000):
        text = _mutant(rng)
        dumps, message = _reference(text)
        data = text.encode()
        texts, got_message = await _scanned(data, size or max(1, len(data)))
        assert got_message == message, (case, text, size)
        assert [_reference(value) for value in texts] == [
            ([dump], None) for dump in dumps
        ], (case, text, size)
