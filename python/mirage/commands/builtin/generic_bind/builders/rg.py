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

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def rg(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    prefix: str = "",
    index: IndexCacheStore = NULL_INDEX,
    **flags,
) -> tuple[ByteSource | None, IOResult]:
    if paths and ops.is_mounted(accessor):
        paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_rg(
        paths,
        texts,
        flags,
        readdir=bound_op(ops.readdir, accessor, index),
        stat=bound_op(ops.stat, accessor, index),
        read_bytes=bound_op(ops.read_bytes, accessor, index),
        read_stream=bound_op(ops.read_stream, accessor, index),
        stdin=stdin,
    )


BUILDER = Builder('rg', rg, None, False, None, read=True)
