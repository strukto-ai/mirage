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
from mirage.commands.builtin.aggregators import prefix_aggregate
from mirage.commands.builtin.generic.grep import grep_generic, labelled
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    bound_op,
)
from mirage.commands.builtin.generic_bind.search import (
    narrow_scope,
    run_search,
)
from mirage.commands.builtin.grep_pattern import pattern_arg
from mirage.commands.builtin.grep_pushdown import grep_needs_every_file
from mirage.commands.config import CommandIO, CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def grep(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    if ops.search is not None:
        return await run_search(ops, "grep", accessor, paths, texts, opts)
    resolved: list[PathSpec] = []
    if paths and ops.is_mounted(accessor) and ops.content_search is None:
        resolved = await ops.resolve_glob(accessor, paths, opts.index)
    elif paths and ops.is_mounted(accessor):
        fl = FlagView(opts.flags, spec=SPECS["grep"])
        resolved, narrowed = await narrow_scope(
            ops,
            accessor,
            opts.index,
            paths,
            pattern_arg(texts, fl),
            fixed_string=fl.as_bool("F"),
            recursive=fl.as_bool("r") or fl.as_bool("R"),
            whole_word=fl.as_bool("w"),
            exact_file_set=grep_needs_every_file(fl),
        )
        if narrowed and not resolved:
            return b"", IOResult(exit_code=1)
        if narrowed:
            opts = labelled(opts)
    return await grep_generic(
        resolved,
        texts,
        opts,
        readdir=bound_op(ops.readdir, accessor, opts.index),
        stat=bound_op(ops.stat, accessor, opts.index),
        read_bytes=bound_op(ops.read_bytes, accessor, opts.index),
        read_stream=bound_op(ops.read_stream, accessor, opts.index),
        stdin=opts.stdin,
    )


BUILDER = GenericCommand("grep", grep, aggregate=prefix_aggregate, read=True)
