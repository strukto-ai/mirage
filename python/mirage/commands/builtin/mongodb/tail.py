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
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.tail import parse_flags, tail_generic
from mirage.commands.builtin.generic_bind.adapter import (
    Builder,
    CommandIO,
    bound_op,
    guard_operation,
    resolve_or_empty,
)
from mirage.commands.builtin.utils.limit import note_after, row_cap_notice
from mirage.commands.config import CommandOpts
from mirage.core.mongodb.readdir import documents_exist
from mirage.core.mongodb.scope import detect_scope
from mirage.core.mongodb.stream import read_tail, watch_stream
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadResult


async def _tail_documents(
    accessor: MongoDBAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    *,
    n: int,
    notices: list[bytes],
) -> bytes:
    data, stopped = await read_tail(accessor, path, n, index)
    if stopped:
        notices.append(
            row_cap_notice(
                "tail",
                path.raw_path,
                accessor.config.max_doc_limit,
                "documents",
                "max_doc_limit",
            )
        )
    return data


async def _watch(
    accessor: MongoDBAccessor, path: PathSpec, index: IndexCacheStore
) -> ByteSource | None:
    if not await documents_exist(accessor, detect_scope(path), path.virtual):
        return None
    return watch_stream(accessor, path, index)


async def tail(
    ops: CommandIO,
    accessor: MongoDBAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    try:
        parsed = parse_flags(opts.flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=str(exc).encode())
    resolved = await resolve_or_empty(ops, accessor, paths, opts.index)
    if (
        parsed.follow
        and len(resolved) == 1
        and detect_scope(resolved[0]).kind == "documents"
    ):
        stream = await guard_operation(_watch, "read_bytes")(
            accessor, resolved[0], opts.index
        )
        if stream is not None:
            return stream, IOResult()
    counts = parsed.counts
    n = counts.lines if counts.lines is not None else 10
    notices: list[bytes] = []
    bounded = guard_operation(_tail_documents, "read_bytes")

    def read(path: PathSpec) -> PolymorphicReadResult:
        if (
            detect_scope(path).kind == "documents"
            and counts.byte_count is None
            and counts.from_byte is None
            and n > 0
            and counts.from_line is None
            and not parsed.follow
        ):
            return bounded(accessor, path, opts.index, n=n, notices=notices)
        return ops.read_stream(accessor, path, opts.index)

    out, io = await tail_generic(
        resolved,
        texts,
        opts,
        bound_op(ops.stat, accessor, opts.index),
        read,
    )
    return (note_after(out, io, notices) if out is not None else out), io


BUILDER = Builder("tail", tail, read=True)
