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

from mirage.accessor.box import BoxAccessor
from mirage.commands.builtin.box.pushdown import narrow_scope
from mirage.commands.builtin.generic.rg import (filters_files, labelled,
                                                needs_every_file, parse_flags)
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.generic.rg import walk_filter
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.grep_pattern import pattern_arg
from mirage.commands.builtin.rg_scan import walk_candidates
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.core.box.read import read as _read
from mirage.core.box.read import stream as _stream
from mirage.core.box.readdir import readdir as _readdir
from mirage.core.box.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("rg", vfs="box", spec=SPECS["rg"])
async def rg(accessor: BoxAccessor, paths: list[PathSpec], texts: list[str],
             opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["rg"])
    pattern_str = pattern_arg(texts, fl, "regexp")

    run_opts = opts
    if paths:
        f = parse_flags(fl)
        # -v and the rest of needs_every_file need the walk (a narrowed
        # superset hides the files they answer for); -g/-t keep the walk
        # so their file filtering stays in one place.
        narrowed, used_search = await narrow_scope(
            accessor,
            opts.index,
            paths,
            pattern_str,
            fixed_string=f.fixed_string,
            recursive=True,
            whole_word=f.whole_word,
            exact_file_set=needs_every_file(fl, f) or filters_files(f),
        )
        if used_search:
            narrowed = walk_candidates(narrowed, paths, walk_filter(f),
                                       opts.cwd.virtual)
            if not narrowed:
                return b"", IOResult(exit_code=1)
            run_opts = labelled(opts)
        paths = narrowed

    return await generic_rg(
        paths,
        texts,
        run_opts,
        readdir=bound_op(_readdir, accessor, opts.index),
        stat=bound_op(_stat, accessor, opts.index),
        read_bytes=bound_op(_read, accessor, opts.index),
        read_stream=bound_op(_stream, accessor, opts.index),
        stdin=opts.stdin,
    )
