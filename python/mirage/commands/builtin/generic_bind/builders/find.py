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

import logging
from collections.abc import Awaitable, Callable
from functools import partial

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.find import (
    find_walk_generic,
    parse_find_args,
    parse_flags,
)
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    bound_op,
    overlaid_stat,
)
from mirage.commands.builtin.utils.tree import tree_walk
from mirage.commands.config import CommandIO, CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, PathSpec

logger = logging.getLogger(__name__)


def _maxdepth(texts: list[str], opts: CommandOpts) -> int | None:
    """How many levels below a start point the expression reads.

    Asked of the mount's ``read_tree`` so ``find -maxdepth 1`` lists one
    level; None when the expression reads them all, or does not parse
    (the walk reports that).

    Args:
        texts (list[str]): the raw expression words.
        opts (CommandOpts): the parsed flags.
    """
    try:
        return parse_find_args(
            tuple(texts), maxdepth=parse_flags(opts.flags).maxdepth
        ).maxdepth
    except ValueError as exc:
        logger.debug("find: no maxdepth for read_tree: %s", exc)
        return None


async def find(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("find: no VFS")
    resolved = await ops.resolve_glob(accessor, paths, opts.index)
    readdir, stat = tree_walk(
        bound_op(ops.read_tree, accessor, opts.index),
        partial(ops.readdir, accessor),
        partial(ops.stat, accessor),
        _maxdepth(texts, opts),
    )
    # -mtime must see namespace times (touch results, observed writes on
    # mtime-less backends), same as ls.
    walk_stat: Callable[..., Awaitable[FileStat]] = stat
    overlay = opts.ns.stat_overlay if opts.ns is not None else None
    if overlay is not None:
        walk_stat = partial(overlaid_stat, walk_stat, overlay)
    return await find_walk_generic(
        resolved,
        list(texts),
        opts,
        readdir=readdir,
        stat=walk_stat,
    )


BUILDER = GenericCommand("find", find)
