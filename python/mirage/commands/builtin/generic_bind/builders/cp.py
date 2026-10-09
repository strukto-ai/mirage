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
    overlaid_stat,
    require_op,
)
from mirage.commands.builtin.utils.links import typed_link
from mirage.commands.config import CommandIO, CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.core.generic.find import walk_find
from mirage.io.types import ByteSource, IOResult
from mirage.types import NativeCopy, PathSpec, PrimitiveCopy
from mirage.utils.key_prefix import rekey
from mirage.vfs.types import OperationFn
from mirage.view.types import StatOverlay


async def _walk_find(
    readdir: OperationFn,
    stat: OperationFn,
    index: IndexCacheStore,
    src: PathSpec,
    type: str | None = None,
) -> list[str]:
    results = await walk_find(
        src,
        readdir=readdir,
        stat=stat,
        index=index,
        args=parse_find_args((), type=type),
    )
    return ["/" + rekey(src.virtual, src.vfs_path, path) for path in results]


def _make_find(
    ops: CommandIO, accessor: Accessor, index: IndexCacheStore
) -> OperationFn:
    if ops.find is not None:
        return partial(ops.find, accessor, index=index)
    return partial(
        _walk_find,
        partial(ops.readdir, accessor),
        partial(ops.stat, accessor),
        index,
    )


def overlayable_stat(
    ops: CommandIO,
    accessor: Accessor,
    index: IndexCacheStore,
    stat_overlay: StatOverlay | None,
) -> OperationFn:
    """The backend stat, merged with the namespace attr overlay if any.

    cp/mv freshness checks (``-u``) must see touch/chmod overlay state,
    exactly like ls and stat rendering.

    Args:
        ops (CommandIO): Backend command IO facade.
        accessor (Accessor): Backend handle.
        index (IndexCacheStore): Cache index threaded through.
        stat_overlay (StatOverlay | None): Namespace merge, or None.
    """
    if stat_overlay is None:
        return bound_op(ops.stat, accessor, index)
    return partial(
        overlaid_stat, partial(ops.stat, accessor), stat_overlay, index=index
    )


async def _write(
    op: OperationFn, accessor: Accessor, path: PathSpec, data: bytes = b""
) -> None:
    await op(accessor, path, data)


async def cp(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("cp: no VFS")
    fl = FlagView(opts.flags, spec=SPECS["cp"])
    parsed = parse_flags(fl)
    paths = await ops.resolve_glob(accessor, paths, opts.index)
    dir_copy = partial(ops.dir_copy, accessor) if ops.dir_copy else None
    mkdir = partial(ops.mkdir, accessor) if ops.mkdir else None
    if ops.copy is None and ops.write is None:
        # Directory creation is not a usable copy step without a file
        # transfer capability. Refuse it through the same guarded entry point
        # before the command leaves an uncopyable destination tree.
        mkdir = partial(
            require_op(replace(ops, mkdir=None), Operation.MKDIR), accessor
        )
    strategy: NativeCopy | PrimitiveCopy
    primitive = ops.copy is None
    if primitive and ops.write is not None:
        # A native copy moves a tree in one backend call and a native
        # find lists it, neither of which passes an entry through the
        # guard the way a read does; while a path rule scopes cp, or a
        # hide could cover an entry under an operand (the native find
        # listed hidden names and the per-file read then printed them
        # in its refusal), the primitive walk copies entry by entry
        # (the cross-mount relay's own path), which is also where GNU's
        # per-entry refusals are worded.
        strategy = PrimitiveCopy(
            read_bytes=bound_op(ops.read_bytes, accessor, opts.index),
            write=partial(_write, ops.write, accessor),
            mkdir=partial(require_op(ops, Operation.MKDIR), accessor),
            readdir=bound_op(ops.readdir, accessor, opts.index),
        )
    else:
        strategy = NativeCopy(
            copy=partial(require_op(ops, Operation.COPY), accessor),
            find=_make_find(ops, accessor, opts.index),
            dir_copy=dir_copy,
            mkdir=mkdir,
        )
    overlay = opts.ns.stat_overlay if opts.ns is not None else None
    links = opts.ns.links if opts.ns is not None else None
    cwd = opts.cwd.virtual if opts.cwd is not None else "/"
    return await generic_cp(
        paths,
        strategy=strategy,
        stat=overlayable_stat(ops, accessor, opts.index, overlay),
        flags=parsed,
        readdir=bound_op(ops.readdir, accessor, opts.index),
        link_at=(
            partial(typed_link, links, cwd=cwd) if links is not None else None
        ),
        copies=(
            transfer_links_of(
                links,
                opts.dispatch,
                cwd,
                opts.ns.visibility if opts.ns is not None else None,
            )
            if links is not None and opts.dispatch is not None
            else None
        ),
        stdin=opts.stdin,
    )


BUILDER = GenericCommand("cp", cp, write=True)
