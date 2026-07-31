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

import json
from collections.abc import AsyncIterator
from typing import Any

import orjson

from mirage.core.jq.eval import jq_eval
from mirage.io.async_line_iterator import AsyncLineIterator


def parse_jsonl(raw: bytes) -> list[Any]:
    text = raw.decode("utf-8", errors="replace")
    return [orjson.loads(line) for line in text.splitlines() if line.strip()]


def parse_json_docs(raw: bytes) -> list[Any]:
    """Parse a whitespace-separated stream of JSON values.

    jq reads a stream of values from any input, not one document: `.json`
    holding several values, newline-delimited JSONL, and pretty-printed
    values run together are all valid and all evaluate per document. The
    single-value case takes the fast orjson path; only a stream falls
    back to incremental decoding.

    Args:
        raw (bytes): the whole input.

    Returns:
        list[Any]: every decoded document, in order.
    """
    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        raise ValueError("jq: empty input")
    try:
        return [orjson.loads(text)]
    except orjson.JSONDecodeError as single_doc_error:
        first_error = single_doc_error
    decoder = json.JSONDecoder()
    docs: list[Any] = []
    idx = 0
    end = len(text)
    while idx < end:
        try:
            doc, offset = decoder.raw_decode(text, idx)
        except ValueError:
            # Not a value stream either, so the input is simply invalid.
            # Re-raise the whole-document error: it is the one that names
            # the real problem, and callers match on orjson's type.
            raise first_error from None
        docs.append(doc)
        idx = offset
        while idx < end and text[idx].isspace():
            idx += 1
    return docs


def parse_json_auto(raw: bytes) -> object:
    docs = parse_json_docs(raw)
    return docs[0] if len(docs) == 1 else docs


def parse_json_path(raw: bytes, path: str) -> object:
    if path.endswith(".jsonl") or path.endswith(".ndjson"):
        return parse_jsonl(raw)
    return orjson.loads(raw)


def is_jsonl_path(path: str) -> bool:
    return path.endswith(".jsonl") or path.endswith(".ndjson")


def is_streamable_jsonl_expr(expression: str) -> bool:
    expr = expression.strip()
    if expr.startswith(".[]"):
        return True
    return False


async def eval_jsonl_stream(
    source: AsyncIterator[bytes],
    expression: str,
    raw: bool = False,
) -> AsyncIterator[bytes]:
    expr = expression.strip()
    if expr == ".[]":
        per_item = "."
    elif expr.startswith(".[] | "):
        per_item = expr[6:]
    elif expr.startswith(".[]."):
        per_item = expr[3:]
    else:
        per_item = expr

    async for line_bytes in AsyncLineIterator(source):
        text = line_bytes.decode("utf-8", errors="replace").strip()
        if not text:
            continue
        obj = orjson.loads(text)
        for value in jq_eval(obj, per_item):
            if raw and isinstance(value, str):
                yield value.encode("utf-8") + b"\n"
            else:
                yield orjson.dumps(value) + b"\n"
