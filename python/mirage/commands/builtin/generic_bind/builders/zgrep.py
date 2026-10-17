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
from mirage.commands.builtin.generic.zgrep import zgrep_generic
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    bound_op,
)
from mirage.commands.builtin.utils.links import link_resolver
from mirage.commands.config import CommandIO, Context
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import utf8_locale
from mirage.types import PathSpec


async def zgrep(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    resolved = (
        await ops.resolve_glob(accessor, paths, ctx.index)
        if paths and ops.is_mounted(accessor)
        else []
    )
    return await zgrep_generic(
        resolved,
        texts,
        ctx.flags,
        read_bytes=bound_op(ops.read_stream, accessor, ctx.index),
        stdin=ctx.stdin,
        stat=partial(ops.stat, accessor),
        resolver=link_resolver(ctx),
        utf8=utf8_locale(ctx.env),
    )


BUILDER = GenericCommand("zgrep", zgrep, read=True)
