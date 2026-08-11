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

import orjson
import pytest

from mirage.core.jq.stream import (eval_jsonl_stream, parse_json_auto,
                                   parse_json_docs, split_raw_lines)
from mirage.core.jq.types import JqOptions

COMPACT = JqOptions(compact=True)


def test_parse_json_auto_empty_raises_clear_error():
    with pytest.raises(ValueError, match="empty input"):
        parse_json_auto(b"")


def test_parse_json_auto_whitespace_raises_clear_error():
    with pytest.raises(ValueError, match="empty input"):
        parse_json_auto(b"   \n\n  ")


def test_parse_json_auto_single_value():
    assert parse_json_auto(b'{"a":1}') == {"a": 1}
    assert parse_json_auto(b"42") == 42


def test_parse_json_auto_ndjson():
    assert parse_json_auto(b'{"a":1}\n{"b":2}') == [{"a": 1}, {"b": 2}]


def test_parse_json_auto_single_line_garbage_propagates_error():
    with pytest.raises(orjson.JSONDecodeError):
        parse_json_auto(b"this is not json")


def test_parse_json_docs_single_value_is_one_document():
    assert parse_json_docs(b'{"a":1}') == [{"a": 1}]


def test_parse_json_docs_ndjson_stream():
    assert parse_json_docs(b'{"a":1}\n{"a":2}\n') == [{"a": 1}, {"a": 2}]


def test_parse_json_docs_pretty_printed_stream():
    # jq reads a stream of values, so documents need not be one per line.
    raw = b'{\n  "a": 1\n}\n{\n  "a": 2\n}\n'
    assert parse_json_docs(raw) == [{"a": 1}, {"a": 2}]


def test_parse_json_docs_stream_of_arrays():
    assert parse_json_docs(b"[1,2]\n[3,4]\n") == [[1, 2], [3, 4]]


def test_parse_json_docs_garbage_reports_the_document_error():
    with pytest.raises(orjson.JSONDecodeError):
        parse_json_docs(b"this is not json")


async def _lines(*items: bytes):
    for item in items:
        yield item


async def _collect(stream) -> list[str]:
    out = []
    async for chunk in stream:
        out.append(chunk.decode().rstrip("\n"))
    return out


@pytest.mark.asyncio
async def test_eval_jsonl_stream_dot_chain_maps_per_line():
    source = _lines(b'{"msg":"hello"}\n', b'{"msg":"world"}\n')
    out = await _collect(eval_jsonl_stream(source, ".[].msg", COMPACT))
    assert out == ['"hello"', '"world"']


@pytest.mark.asyncio
async def test_eval_jsonl_stream_raw_unquotes_strings():
    source = _lines(b'{"msg":"hello"}\n', b'{"msg":"world"}\n')
    opts = JqOptions(raw_output=True, compact=True)
    out = await _collect(eval_jsonl_stream(source, ".[].msg", opts))
    assert out == ["hello", "world"]


@pytest.mark.asyncio
async def test_eval_jsonl_stream_prints_every_output_of_a_line():
    source = _lines(b'{"a":1,"b":2}\n', b'{"a":3,"b":4}\n')
    out = await _collect(eval_jsonl_stream(source, ".[] | .a, .b", COMPACT))
    assert out == ["1", "2", "3", "4"]


@pytest.mark.asyncio
async def test_eval_jsonl_stream_drops_lines_with_no_output():
    source = _lines(b'{"id":1}\n', b'{"id":2}\n', b'{"id":3}\n')
    out = await _collect(
        eval_jsonl_stream(source, ".[] | select(.id > 2)", COMPACT))
    assert out == ['{"id":3}']


def test_parse_json_docs_empty_input_has_no_documents():
    assert parse_json_docs(b"") == []
    assert parse_json_docs(b"  \n\n ") == []


def test_split_raw_lines_drops_only_the_trailing_newline():
    assert split_raw_lines(b"a\nb\n") == ["a", "b"]
    assert split_raw_lines(b"a\nb") == ["a", "b"]
    assert split_raw_lines(b"") == []
    assert split_raw_lines(b"\n") == [""]


def test_split_raw_lines_keeps_other_unicode_breaks_inline():
    # jq breaks on newlines only, never on the other separators a
    # Unicode line splitter honors (here U+2028).
    assert split_raw_lines("a\u2028b\n".encode()) == ["a\u2028b"]


@pytest.mark.asyncio
async def test_eval_jsonl_stream_pretty_prints_by_default():
    source = _lines(b'{"a":1}\n')
    out = []
    async for chunk in eval_jsonl_stream(source, ".[]", JqOptions()):
        out.append(chunk)
    assert b"".join(out) == b'{\n  "a": 1\n}\n'


@pytest.mark.asyncio
async def test_eval_jsonl_stream_binds_named_args():
    source = _lines(b'{"a":1}\n')
    opts = JqOptions(compact=True, named_args={"v": "hi"})
    out = await _collect(eval_jsonl_stream(source, ".[] | [., $v]", opts))
    assert out == ['[{"a":1},"hi"]']
