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

from functools import partial

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.sort import sort as generic_sort
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op)
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def sort(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    index: IndexCacheStore = NULL_INDEX,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await resolve_or_empty(ops, accessor, paths, index)
    return await generic_sort(
        paths,
        read_bytes=bound_op(ops.read_bytes, accessor, index),
        write_bytes=(partial(ops.write, accessor)
                     if ops.write is not None else None),
        stdin=stdin,
        flags=flags,
    )


BUILDER = Builder('sort', sort, None, False, None, read=True)
