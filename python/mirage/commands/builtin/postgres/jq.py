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

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.jq import (format_jq_output, jq_eval, parse_json_auto,
                            parse_json_path)
from mirage.core.postgres.glob import resolve_glob
from mirage.core.postgres.read import read as postgres_read
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("jq", resource="postgres", spec=SPECS["jq"])
async def jq(
    accessor: PostgresAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    r: bool = False,
    c: bool = False,
    s: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise ValueError("jq: usage: jq EXPRESSION [path]")
    expression = texts[0]
    if paths:
        paths = await resolve_glob(accessor, paths)
        outputs: list[bytes] = []
        for p in paths:
            raw = await postgres_read(accessor, p, index)
            data = parse_json_path(raw, p.original)
            if s:
                data = [data] if not isinstance(data, list) else data
            result = jq_eval(data, expression.strip())
            spread = "[]" in expression
            outputs.append(format_jq_output(result, r, c, spread))
        return b"".join(outputs), IOResult()
    if stdin is not None:
        if isinstance(stdin, bytes):
            raw_bytes = stdin
        else:
            raw_bytes = b""
            async for chunk in stdin:
                raw_bytes += chunk
        if s:
            data = parse_json_auto(raw_bytes)
            if not isinstance(data, list):
                data = [data]
        else:
            data = parse_json_auto(raw_bytes)
        result = jq_eval(data, expression.strip())
        spread = "[]" in expression
        return format_jq_output(result, r, c, spread), IOResult()
    raise ValueError("jq: missing input")
