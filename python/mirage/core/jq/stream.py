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

from collections.abc import AsyncIterator
from typing import Any

import orjson

from mirage.core.jq.eval import jq_eval
from mirage.core.jq.format import JQ_EMPTY
from mirage.io.async_line_iterator import AsyncLineIterator


def parse_jsonl(raw: bytes) -> list[Any]:
    text = raw.decode("utf-8", errors="replace")
    return [orjson.loads(line) for line in text.splitlines() if line.strip()]


def parse_json_auto(raw: bytes) -> object:
    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        raise ValueError("jq: empty input")
    try:
        return orjson.loads(text)
    except orjson.JSONDecodeError:
        lines = [line for line in text.splitlines() if line.strip()]
        if len(lines) <= 1:
            raise
        return [orjson.loads(line) for line in lines]


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
        result = jq_eval(obj, per_item)
        if result is JQ_EMPTY:
            continue
        if raw and isinstance(result, str):
            yield result.encode("utf-8") + b"\n"
        else:
            yield orjson.dumps(result) + b"\n"
