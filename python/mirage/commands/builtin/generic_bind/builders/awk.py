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
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.builtin.utils.links import dispatch_of, mount_root
from mirage.commands.config import Context
from mirage.core.awk.builtins import split_assignment
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.glob_walk import ResolveGlobFn


async def resolve_operands(
    resolve: ResolveGlobFn, paths: list[PathSpec], ctx: Context
) -> list[PathSpec]:
    """Expand awk's file operands, keeping ``var=value`` ones in place.

    An assignment operand names no file, so it is never globbed: awk
    assigns it when its input reaches it, between the files around it.
    An operand another mount serves arrives expanded and is read through
    the dispatcher, so it is left as it is too.

    Args:
        resolve (ResolveGlobFn): the command's glob resolution.
        paths (list[PathSpec]): The operands in command-line order.
        ctx (Context): The invocation context.
    """
    home = mount_root(ctx)
    out: list[PathSpec] = []
    run: list[PathSpec] = []
    for path in paths:
        if split_assignment(path.raw_path) is None and served_here(
            ctx.vfs, home, path
        ):
            run.append(path)
            continue
        if run:
            out.extend(await resolve(run))
        run = []
        out.append(path)
    if run:
        out.extend(await resolve(run))
    return out


async def awk(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    resolved = await resolve_operands(files.resolve_glob, paths, ctx)
    return await generic_awk(
        resolved,
        texts,
        ctx.flags,
        stream=files.read,
        stdin=ctx.stdin,
        dispatch=dispatch_of(ctx),
        cwd=ctx.cwd,
        shell=ctx.shell,
        vfs=ctx.vfs,
        mount_prefix=mount_root(ctx),
        env=ctx.env,
    )


BUILDER = GenericCommand("awk", awk, write=True, read=True)
