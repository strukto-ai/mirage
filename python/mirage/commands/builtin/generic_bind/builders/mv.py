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
from mirage.commands.builtin.generic.crossmount.utils import transfer_links_of
from mirage.commands.builtin.generic.mv import mv_generic as generic_mv
from mirage.commands.builtin.generic.mv import parse_flags
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    Operation,
    bound_op,
    refuse_reveal,
    require_op,
)
from mirage.commands.builtin.utils.links import links_of, mounts_of
from mirage.commands.config import CommandIO, Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.context import session_visibility
from mirage.io.types import ByteSource, IOResult
from mirage.types import NativeMove, PathSpec


async def mv(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("mv: no VFS")
    fl = FlagView(ctx.flags, spec=SPECS["mv"])
    parsed = parse_flags(fl)
    paths = await ops.resolve_glob(accessor, paths, ctx.index)
    links = links_of(ctx)
    mounts = mounts_of(ctx)
    return await generic_mv(
        paths,
        strategy=NativeMove(
            rename=partial(require_op(ops, Operation.RENAME), accessor)
        ),
        stat=bound_op(ops.stat, accessor, ctx.index),
        flags=parsed,
        readdir=bound_op(ops.readdir, accessor, ctx.index),
        guard=refuse_reveal,
        copies=(
            transfer_links_of(
                links,
                ctx.dispatch,
                ctx.cwd.virtual if ctx.cwd is not None else "/",
                session_visibility(),
            )
            if links is not None and ctx.dispatch is not None
            else None
        ),
        stdin=ctx.stdin,
        mount_root=mounts.is_root if mounts is not None else None,
    )


BUILDER = GenericCommand("mv", mv, write=True)
