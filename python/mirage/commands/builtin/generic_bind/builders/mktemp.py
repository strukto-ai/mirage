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
from mirage.commands.builtin.generic.mktemp import mktemp_generic
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    Operation,
    require_op,
)
from mirage.commands.builtin.utils.copy import path_exists
from mirage.commands.builtin.utils.links import dispatch_of
from mirage.commands.builtin.utils.paths import vfs_stat_path
from mirage.commands.config import CommandIO, Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


async def mktemp(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    # The name a pathless mktemp creates is under $TMPDIR or /tmp, which
    # the working directory's mount rarely owns, so the create goes
    # through the dispatcher to whichever mount does. Only a generic run
    # outside a workspace, with no dispatcher and no other mount, writes
    # through this mount's own ops.
    dispatch = dispatch_of(ctx)
    stat_path = vfs_stat_path(ctx.vfs)

    def local(path: PathSpec) -> PathSpec:
        return PathSpec.from_str_path(
            path.virtual, mount_key(path.virtual, ctx.mount_prefix or "")
        )

    async def mkdir(path: PathSpec) -> None:
        if dispatch is not None:
            await dispatch("mkdir", path)
        else:
            await require_op(ops, Operation.MKDIR)(accessor, local(path))

    async def write(path: PathSpec, data: bytes) -> None:
        if dispatch is not None:
            await dispatch("write", path, data=data)
        else:
            await require_op(ops, Operation.WRITE)(accessor, local(path), data)

    async def exists(path: PathSpec) -> bool:
        if stat_path is not None:
            return await stat_path(path) is not None
        return await path_exists(partial(ops.stat, accessor), local(path))

    return await mktemp_generic(paths, list(texts), ctx, mkdir, write, exists)


BUILDER = GenericCommand("mktemp", mktemp, write=True)
