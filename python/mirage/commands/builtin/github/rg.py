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

from mirage.accessor.github import GitHubAccessor
from mirage.commands.builtin.generic.rg import (labelled, needs_every_file,
                                                parse_flags,
                                                refuse_missing_pattern)
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.generic.rg import walk_filter
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.github.pushdown import narrow_scope, scope_refusal
from mirage.commands.builtin.grep_pattern import pattern_arg
from mirage.commands.builtin.rg_scan import walk_candidates
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.core.github.constants import SCOPE_ERROR
from mirage.core.github.read import read as github_read
from mirage.core.github.readdir import readdir as _readdir
from mirage.core.github.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("rg", vfs="github", spec=SPECS["rg"])
async def rg(accessor: GitHubAccessor, paths: list[PathSpec], texts: list[str],
             opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["rg"])
    pattern_str = pattern_arg(texts, fl, "regexp")
    f = parse_flags(fl)
    refuse_missing_pattern(pattern_str, fl, f)

    run_opts = opts
    if paths:
        narrowed, file_count, used_search = await narrow_scope(
            accessor,
            opts.index,
            paths,
            pattern_str,
            fixed_string=f.fixed_string,
            recursive=True,
            whole_word=f.whole_word,
            # A narrowing holds only files matching the searched literal:
            # -v and --files-without-match print from the rest, and -f adds
            # patterns code search never saw.
            exact_file_set=needs_every_file(fl, f),
        )
        if used_search:
            # The walk a narrowing stands in for filters what it walks
            # (-g, -t, hidden entries, -d) and labels every file it finds.
            narrowed = walk_candidates(narrowed, paths, walk_filter(f),
                                       opts.cwd.virtual)
            if not narrowed:
                return b"", IOResult(exit_code=1)
            run_opts = labelled(opts)
        if file_count > SCOPE_ERROR and not (f.list_files or f.type_list):
            # A scope this large with no trusted narrowing is refused rather
            # than scanned blob by blob; a listing reads no blob.
            msg = scope_refusal("rg", file_count, f.whole_word)
            return b"", IOResult(exit_code=1, stderr=msg.encode())
        paths = narrowed

    return await generic_rg(
        paths,
        texts,
        run_opts,
        readdir=bound_op(_readdir, accessor, opts.index),
        stat=bound_op(_stat, accessor, opts.index),
        read_bytes=bound_op(github_read, accessor, opts.index),
        read_stream=None,
        stdin=opts.stdin,
    )
