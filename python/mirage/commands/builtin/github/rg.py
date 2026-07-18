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

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.github.narrow import (files_only_shortcircuit,
                                                   narrow_scope)
from mirage.commands.builtin.grep_helper import pattern_arg
from mirage.commands.builtin.rg_helper import rg_matches_filter
from mirage.commands.errors import UsageError
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.github.constants import SCOPE_ERROR
from mirage.core.github.read import read as github_read
from mirage.core.github.readdir import readdir as _readdir
from mirage.core.github.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("rg", resource="github", spec=SPECS["rg"])
async def rg(
    accessor: GitHubAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    index: IndexCacheStore,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["rg"])
    pattern_str = pattern_arg(texts, fl)
    if pattern_str is None:
        raise UsageError("rg: usage: rg [flags] pattern [path]")

    if paths:
        scope = paths[0]
        paths, file_count, used_search = await narrow_scope(
            accessor,
            index,
            paths,
            pattern_str,
            fixed_string=fl.as_bool("F"),
            recursive=True,
        )
        if file_count > SCOPE_ERROR:
            msg = f"rg: {file_count} files in scope, narrow the path\n"
            return b"", IOResult(exit_code=1, stderr=msg.encode())
        if used_search:
            predicate = partial(rg_matches_filter,
                                file_type=fl.as_str("type"),
                                glob_pattern=fl.as_str("glob"),
                                hidden=fl.as_bool("hidden"))
            short = files_only_shortcircuit(fl,
                                            pattern_str,
                                            paths,
                                            scope,
                                            path_predicate=predicate)
            if short is not None:
                return short

    return await generic_rg(
        paths,
        texts,
        flags,
        readdir=bound_op(_readdir, accessor, index),
        stat=bound_op(_stat, accessor, index),
        read_bytes=bound_op(github_read, accessor, index),
        read_stream=None,
        stdin=stdin,
    )
