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
from mirage.commands.builtin.generic.wc import (WCCounts, format_count_rows,
                                                parse_flags, wc_generic)
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.commands.builtin.mongodb.cat import stream_any
from mirage.commands.builtin.mongodb.io import IO
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.mongodb._client import count_documents
from mirage.core.mongodb.scope import MongoDBDocumentsScope, detect_scope
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("wc", resource="mongodb", spec=SPECS["wc"])
async def wc(accessor: MongoDBAccessor, paths: list[PathSpec],
             texts: list[str],
             opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    try:
        parsed = parse_flags(opts.flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=(str(exc) + "\n").encode())
    resolved = await resolve_or_empty(IO, accessor, paths, opts.index)
    # Line counts on collections come from a server-side count_documents
    # instead of reading every document. -l only (default prints words and
    # bytes too, which needs the content).
    count_only = parsed.lines and not (parsed.words or parsed.bytes_ or
                                       parsed.chars or parsed.max_line_length)
    scopes = [detect_scope(p) for p in resolved]
    document_scopes = [
        scope for scope in scopes if isinstance(scope, MongoDBDocumentsScope)
    ]
    if resolved and count_only and len(document_scopes) == len(scopes):
        rows: list[tuple[WCCounts, str | None]] = []
        total = 0
        for p, scope in zip(resolved, document_scopes):
            count = await count_documents(accessor.client, scope.database,
                                          scope.name)
            rows.append((WCCounts(lines=count), p.raw_path))
            total += count
        return format_count_rows(rows, WCCounts(lines=total), len(resolved),
                                 parsed), IOResult()
    return await wc_generic(resolved, list(texts), opts,
                            bound_op(stream_any, accessor, opts.index))
