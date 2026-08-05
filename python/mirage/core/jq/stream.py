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

from mirage.core.jq.eval import args_object, jq_eval, references_args
from mirage.core.jq.format import format_one
from mirage.core.jq.types import RS, JqOptions
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
        list[Any]: every decoded document, in order. Empty input holds
            no documents at all, which is why jq prints nothing and
            exits 0 for an empty file.
    """
    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        return []
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
    if not docs:
        raise ValueError("jq: empty input")
    return docs[0] if len(docs) == 1 else docs


def parse_seq_docs(raw: bytes) -> list[Any]:
    """Parse an RFC 7464 JSON text sequence (`--seq`).

    Every value is introduced by RS, so anything before the first one is
    text the sequence never claimed. jq reports that as an ignored parse
    error and prints nothing for it; mirage drops it just as silently,
    which is the one divergence here.

    Args:
        raw (bytes): the whole input.
    """
    text = raw.decode("utf-8", errors="replace")
    return [orjson.loads(part) for part in text.split(RS)[1:] if part.strip()]


def split_raw_lines(raw: bytes) -> list[str]:
    """Split one input into the strings `jq -R` reads it as.

    jq breaks on newlines only (never on the other separators
    ``str.splitlines`` honors) and a trailing newline ends the last line
    rather than starting an empty one.

    Args:
        raw (bytes): one input's bytes.
    """
    text = raw.decode("utf-8", errors="replace")
    if not text:
        return []
    lines = text.split("\n")
    if lines[-1] == "":
        lines.pop()
    return lines


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
    opts: JqOptions,
) -> AsyncIterator[bytes]:
    """Evaluate a per-element program over a JSONL file, line by line.

    Args:
        source (AsyncIterator[bytes]): the file's byte chunks.
        expression (str): jq program text, already known to be one of
            the `.[]`-prefixed shapes this path can rewrite.
        opts (JqOptions): resolved options; only output ones reach here,
            since the caller keeps this path off for anything that
            changes input assembly.
    """
    expr = expression.strip()
    if expr == ".[]":
        per_item = "."
    elif expr.startswith(".[] | "):
        per_item = expr[6:]
    elif expr.startswith(".[]."):
        per_item = expr[3:]
    else:
        per_item = expr

    args_value = args_object(opts) if references_args(per_item) else None
    async for line_bytes in AsyncLineIterator(source):
        text = line_bytes.decode("utf-8", errors="replace").strip()
        if not text:
            continue
        obj = orjson.loads(text)
        for value in jq_eval(obj, per_item, opts.named_args, None, args_value):
            yield format_one(value, opts)
