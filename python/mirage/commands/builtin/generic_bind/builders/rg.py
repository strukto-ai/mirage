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
from mirage.commands.builtin.generic.rg import (
    filters_files,
    labelled,
    needs_every_file,
    parse_flags,
    rg_generic,
    walk_filter,
)
from mirage.commands.builtin.generic_bind.adapter import (
    Builder,
    CommandIO,
    bound_op,
)
from mirage.commands.builtin.generic_bind.search import (
    narrow_scope,
    run_search,
)
from mirage.commands.builtin.grep_pattern import pattern_arg
from mirage.commands.builtin.rg_scan import walk_candidates
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def rg(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    if ops.search is not None:
        return await run_search(ops, "rg", accessor, paths, texts, opts)
    if paths and ops.is_mounted(accessor) and ops.content_search is None:
        paths = await ops.resolve_glob(accessor, paths, opts.index)
    elif paths and ops.is_mounted(accessor):
        fl = FlagView(opts.flags, spec=SPECS["rg"])
        f = parse_flags(fl)
        # -v and the rest of needs_every_file need the walk (a narrowed
        # superset hides the files they answer for); -g/-t keep the walk
        # so their file filtering stays in one place.
        narrowed, used_search = await narrow_scope(
            ops,
            accessor,
            opts.index,
            paths,
            pattern_arg(texts, fl, "regexp"),
            fixed_string=f.fixed_string,
            recursive=True,
            whole_word=f.whole_word,
            exact_file_set=needs_every_file(fl, f) or filters_files(f),
        )
        if used_search:
            narrowed = walk_candidates(
                narrowed, paths, walk_filter(f), opts.cwd.virtual
            )
            if not narrowed:
                return b"", IOResult(exit_code=1)
            opts = labelled(opts)
        paths = narrowed
    return await rg_generic(
        paths,
        texts,
        opts,
        readdir=bound_op(ops.readdir, accessor, opts.index),
        stat=bound_op(ops.stat, accessor, opts.index),
        read_bytes=bound_op(ops.read_bytes, accessor, opts.index),
        read_stream=bound_op(ops.read_stream, accessor, opts.index),
        stdin=opts.stdin,
    )


BUILDER = Builder("rg", rg, read=True)
