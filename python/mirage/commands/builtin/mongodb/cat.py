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
from mirage.commands.builtin.generic.cat import cat_generic
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.commands.builtin.mongodb.io import IO
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.mongodb.read import read as mongodb_read
from mirage.core.mongodb.scope import detect_scope
from mirage.core.mongodb.stream import read_stream
from mirage.core.mongodb.types import ScopeLevel
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadResult


async def stream_any(accessor: MongoDBAccessor, path: PathSpec, *,
                     index: IndexCacheStore) -> PolymorphicReadResult:
    """Read one path by scope: documents stream, everything else renders.

    Mirrors the TS ``streamAny``: a documents scope has a native cursor
    to stream from, while collection/database renderings materialize.

    Args:
        accessor (MongoDBAccessor): Backend handle.
        path (PathSpec): Resolved operand.
        index (IndexCacheStore): Index cache store.
    """
    scope = detect_scope(path)
    if scope.level == ScopeLevel.DOCUMENTS:
        return read_stream(accessor, path, index)
    return await mongodb_read(accessor, path, index)


@command("cat", resource="mongodb", spec=SPECS["cat"])
async def cat(accessor: MongoDBAccessor, paths: list[PathSpec],
              texts: list[str],
              opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    resolved = await resolve_or_empty(IO, accessor, paths, opts.index)
    return await cat_generic(resolved,
                             list(texts),
                             opts,
                             bound_op(IO.stat, accessor, opts.index),
                             bound_op(stream_any, accessor, opts.index),
                             local=IO.local)
