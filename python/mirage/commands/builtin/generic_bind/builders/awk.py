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
from mirage.commands.builtin.generic.awk import awk_generic as generic_awk
from mirage.commands.builtin.generic.awk import served_here
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    bound_op,
    resolve_or_empty,
)
from mirage.commands.builtin.utils.links import dispatch_of
from mirage.commands.config import CommandIO, Context
from mirage.core.awk.builtins import split_assignment
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def resolve_operands(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    ctx: Context,
) -> list[PathSpec]:
    """Expand awk's file operands, keeping ``var=value`` ones in place.

    An assignment operand names no file, so it is never globbed: awk
    assigns it when its input reaches it, between the files around it.
    An operand another mount serves arrives expanded and is read through
    the dispatcher, so it is left as it is too.

    Args:
        ops (CommandIO): Backend I/O bundle.
        accessor (Accessor): Backend accessor.
        paths (list[PathSpec]): The operands in command-line order.
        ctx (Context): The invocation context.
    """
    out: list[PathSpec] = []
    run: list[PathSpec] = []
    for path in paths:
        if split_assignment(path.raw_path) is None and served_here(
            ctx.vfs, ctx.mount_prefix, path
        ):
            run.append(path)
            continue
        out.extend(await resolve_or_empty(ops, accessor, run, ctx.index))
        run = []
        out.append(path)
    out.extend(await resolve_or_empty(ops, accessor, run, ctx.index))
    return out


async def awk(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    paths = await resolve_operands(ops, accessor, paths, ctx)
    return await generic_awk(
        paths,
        texts,
        ctx.flags,
        read_bytes=bound_op(ops.read_bytes, accessor, ctx.index),
        read_stream=bound_op(ops.read_stream, accessor, ctx.index),
        stdin=ctx.stdin,
        dispatch=dispatch_of(ctx),
        cwd=ctx.cwd,
        index=ctx.index,
        shell=ctx.shell,
        vfs=ctx.vfs,
        mount_prefix=ctx.mount_prefix,
        env=ctx.env,
    )


BUILDER = GenericCommand("awk", awk, read=True)
