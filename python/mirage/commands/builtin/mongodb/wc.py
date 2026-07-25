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

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.wc import (WCCounts, format_count_rows,
                                                format_stdin, parse_flags)
from mirage.commands.builtin.generic.wc import wc as generic_wc
from mirage.commands.builtin.mongodb._provision import file_read_provision
from mirage.commands.builtin.mongodb.io import resolve_glob
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.mongodb._client import count_documents
from mirage.core.mongodb.read import read as mongodb_read
from mirage.core.mongodb.scope import MongoDBDocumentsScope, detect_scope
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("wc",
         resource="mongodb",
         spec=SPECS["wc"],
         provision=file_read_provision)
async def wc(
    accessor: MongoDBAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    index: IndexCacheStore,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    try:
        parsed = parse_flags(flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=(str(exc) + "\n").encode())
    if paths:
        paths = await resolve_glob(accessor, paths, index)
        # Line counts on collections come from a server-side count_documents
        # instead of reading every document. -l only (default prints words
        # and bytes too, which needs the content).
        count_only = parsed.lines and not (parsed.words or parsed.bytes_
                                           or parsed.chars
                                           or parsed.max_line_length)
        scopes = [detect_scope(p) for p in paths]
        document_scopes = [
            scope for scope in scopes
            if isinstance(scope, MongoDBDocumentsScope)
        ]
        rows: list[tuple[WCCounts, str | None]] = []
        if count_only and len(document_scopes) == len(scopes):
            total = 0
            for p, scope in zip(paths, document_scopes):
                count = await count_documents(accessor.client, scope.database,
                                              scope.name)
                rows.append((WCCounts(lines=count), p.virtual))
                total += count
            return format_count_rows(rows, WCCounts(lines=total), len(paths),
                                     parsed), IOResult()
        totals = WCCounts()
        for p in paths:
            data = await mongodb_read(accessor, p, index)
            counts = await generic_wc(data)
            rows.append((counts, p.virtual))
            totals.merge(counts)
        return format_count_rows(rows, totals, len(paths), parsed), IOResult()
    stdin_data = await _read_stdin_async(stdin)
    if stdin_data is None:
        raise ValueError("wc: missing operand")
    counts = await generic_wc(stdin_data)
    return format_stdin(counts, parsed), IOResult()
