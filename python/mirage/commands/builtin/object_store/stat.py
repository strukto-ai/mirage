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

from collections.abc import Callable
from functools import partial
from typing import Any

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.stat import stat_generic
from mirage.commands.builtin.generic_bind.adapter import (CommandIO, bound_op,
                                                          overlaid_stat)
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def make_stat(vfs: str, io: CommandIO) -> Callable[..., Any]:
    """Build the index-threaded stat override for one keyed store.

    Wiring only, and it delegates to ``stat_generic`` rather than to the
    generic itself, so every fact the generic reads off ``CommandOpts``
    reaches a keyed store too. Reading the flags here and calling the
    generic with keywords is how the mount boundaries and the dispatched
    stat went missing on s3 and gridfs: the two arguments were added to
    the generic and to the one builder that calls it, and this wrapper
    named the older set.

    Args:
        vfs (str): VFS name the command registers under.
        io (CommandIO): the backend's op table.
    """
    stat_core = io.stat
    resolve_glob = io.resolve_glob

    async def stat(
        accessor: Accessor,
        paths: list[PathSpec],
        texts: list[str],
        opts: CommandOpts,
    ) -> tuple[ByteSource | None, IOResult]:
        if not paths:
            raise ValueError("stat: missing operand")
        resolved = await resolve_glob(accessor, paths, opts.index)
        stat_fn = bound_op(stat_core, accessor, opts.index)
        overlay = opts.ns.stat_overlay if opts.ns is not None else None
        if overlay is not None:
            stat_fn = partial(overlaid_stat,
                              partial(stat_core, accessor),
                              overlay,
                              index=opts.index)
        return await stat_generic(resolved, list(texts), opts, stat_fn)

    wrapped: Callable[..., Any] = command("stat", vfs=vfs,
                                          spec=SPECS["stat"])(stat)
    return wrapped
