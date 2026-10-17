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

from dataclasses import replace
from functools import partial

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.cp import cp_generic as generic_cp
from mirage.commands.builtin.generic.cp import parse_flags
from mirage.commands.builtin.generic.crossmount.utils import transfer_links_of
from mirage.commands.builtin.generic.find import parse_find_args
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    Operation,
    bound_op,
    require_op,
)
from mirage.commands.builtin.utils.links import (
    dispatch_of,
    links_of,
    mounts_of,
    serves,
    typed_link,
)
from mirage.commands.builtin.utils.tree import tree_walk
from mirage.commands.config import CommandIO, Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.context import session_visibility
from mirage.core.generic.find import walk_find
from mirage.io.types import ByteSource, IOResult
from mirage.types import NativeCopy, PathSpec, PrimitiveCopy
from mirage.utils.key_prefix import rekey
from mirage.vfs.types import OperationFn
from mirage.view.namespace_view import paths_scoped


async def _walk_find(
    readdir: OperationFn,
    stat: OperationFn,
    index: IndexCacheStore,
    src: PathSpec,
    type: str | None = None,
    unreadable: list[str] | None = None,
) -> list[str]:
    refused: list[str] | None = None if unreadable is None else []
    results = await walk_find(
        src,
        readdir=readdir,
        stat=stat,
        index=index,
        args=parse_find_args((), type=type),
        unreadable=refused,
    )
    if unreadable is not None and refused is not None:
        unreadable.extend(
            "/" + rekey(src.virtual, src.vfs_path, path) for path in refused
        )
    return ["/" + rekey(src.virtual, src.vfs_path, path) for path in results]


def _make_find(
    ops: CommandIO, accessor: Accessor, index: IndexCacheStore
) -> OperationFn:
    readdir, stat = tree_walk(
        bound_op(ops.read_tree, accessor, index),
        partial(ops.readdir, accessor),
        partial(ops.stat, accessor),
    )
    return partial(_walk_find, readdir, stat, index)


async def _write(
    op: OperationFn, accessor: Accessor, path: PathSpec, data: bytes = b""
) -> None:
    await op(accessor, path, data)


async def cp(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("cp: no VFS")
    fl = FlagView(ctx.flags, spec=SPECS["cp"])
    parsed = parse_flags(fl)
    # A native copy or find answers for a whole tree in one call, so the
    # dispatcher declines one whose tree the caller's view restricts; cp
    # takes the entry-by-entry walk up front there, which is where GNU's
    # per-entry refusals are worded.
    if paths_scoped(paths, ctx.mount_prefix):
        ops = replace(ops, copy=None, dir_copy=None)
    paths = await ops.resolve_glob(accessor, paths, ctx.index)
    dir_copy = partial(ops.dir_copy, accessor) if ops.dir_copy else None
    mkdir = partial(ops.mkdir, accessor) if ops.mkdir else None
    if ops.copy is None and ops.write is None:
        # Directory creation is not a usable copy step without a file
        # transfer capability. Refuse it through the same guarded call
        # before the command leaves an uncopyable destination tree.
        mkdir = partial(
            require_op(replace(ops, mkdir=None), Operation.MKDIR), accessor
        )
    strategy: NativeCopy | PrimitiveCopy
    primitive = ops.copy is None
    if primitive and ops.write is not None:
        # A native copy moves a tree in one backend call and read_tree
        # lists it, neither of which passes an entry through the guard
        # the way a read does; while a path rule scopes cp, or a hide
        # could cover an entry under an operand (a one-call listing
        # names hidden entries and the per-file read then prints them
        # in its refusal), the primitive walk copies entry by entry
        # (the cross-mount relay's own path), which is also where GNU's
        # per-entry refusals are worded.
        strategy = PrimitiveCopy(
            read_bytes=bound_op(ops.read_bytes, accessor, ctx.index),
            read_stream=bound_op(ops.read_stream, accessor, ctx.index),
            write=partial(_write, ops.write, accessor),
            mkdir=partial(require_op(ops, Operation.MKDIR), accessor),
            readdir=bound_op(ops.readdir, accessor, ctx.index),
        )
    else:
        strategy = NativeCopy(
            copy=partial(require_op(ops, Operation.COPY), accessor),
            find=_make_find(ops, accessor, ctx.index),
            dir_copy=dir_copy,
            mkdir=mkdir,
        )
    links = links_of(ctx)
    cwd = ctx.cwd.virtual if ctx.cwd is not None else "/"
    return await generic_cp(
        paths,
        strategy=strategy,
        stat=bound_op(ops.stat, accessor, ctx.index),
        flags=parsed,
        readdir=bound_op(ops.readdir, accessor, ctx.index),
        link_at=(
            partial(typed_link, links, cwd=cwd) if links is not None else None
        ),
        copies=(
            transfer_links_of(
                links,
                ctx.vfs.dispatch,
                cwd,
                session_visibility(),
                partial(
                    serves,
                    mounts_of(ctx),
                    ctx.mount_prefix,
                ),
            )
            if links is not None and ctx.vfs is not None
            else None
        ),
        stdin=ctx.stdin,
        dispatch=dispatch_of(ctx),
    )


BUILDER = GenericCommand("cp", cp, write=True)
