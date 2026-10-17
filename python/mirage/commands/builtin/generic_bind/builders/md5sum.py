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
from mirage.commands.builtin.generic.md5sum import md5sum_generic
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    bound_uncached,
    dir_aware_stat,
    dir_aware_stream,
    resolve_or_empty,
)
from mirage.commands.config import CommandIO, Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def md5sum(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    resolved = await resolve_or_empty(ops, accessor, paths, ctx.index)
    return await md5sum_generic(
        resolved,
        list(texts),
        ctx,
        dir_aware_stat(ops, accessor, ctx),
        dir_aware_stream(ops, accessor, ctx),
        bound_uncached(ops.checksum, accessor, ctx.index),
    )


BUILDER = GenericCommand("md5sum", md5sum, read=True)
