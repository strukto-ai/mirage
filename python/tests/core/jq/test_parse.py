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
from pathlib import Path

import pytest

from mirage.core.jq.parse import (
    JqParser,
    decode_utf8,
    read_texts,
    string_text,
    value_text,
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


@pytest.mark.asyncio
async def test_large_unfinished_input_can_be_cancelled_and_discarded():
    parser = JqParser()
    parser.feed(b'"' + b"\\n" * (4 * 1024 * 1024), True)
    pending = asyncio.create_task(parser.next())
    try:
        await asyncio.sleep(0.02)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
    finally:
        await parser.close()


@pytest.mark.asyncio
async def test_read_texts_reads_a_slurpfile_as_jq_does():
    assert await read_texts(b'{"a":1.0}\n{"a":2}\n') == (
        ['{"a":1.0}', '{"a":2}'],
        None,
    )
    assert await read_texts(b"1 [") == (
        ["1"],
        JqParseError("Unfinished JSON term at EOF at line 1, column 3"),
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
