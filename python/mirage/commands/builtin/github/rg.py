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

from collections.abc import AsyncIterator

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import IndexCacheStore
from mirage.cache.read_through import cache_aware_read_bytes
from mirage.commands.builtin.constants import PatternType
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.grep_helper import classify_pattern, pattern_arg
from mirage.commands.errors import UsageError
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.github.constants import SCOPE_ERROR, SCOPE_WARN
from mirage.core.github.glob import resolve_glob
from mirage.core.github.read import read as github_read
from mirage.core.github.readdir import readdir as _readdir
from mirage.core.github.scope import (count_scope_files, is_repo_root,
                                      scope_relative_key, should_use_search)
from mirage.core.github.search import narrow_paths
from mirage.core.github.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("rg", resource="github", spec=SPECS["rg"])
async def rg(
    accessor: GitHubAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    index: IndexCacheStore = None,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["rg"])
    pattern_str = pattern_arg(texts, fl)
    if pattern_str is None:
        raise UsageError("rg: usage: rg [flags] pattern [path]")

    if paths and index is None:
        return b"", IOResult(exit_code=1)
    if paths:
        key = scope_relative_key(paths[0])
        file_count = count_scope_files(index._entries, key)
        pt = classify_pattern(pattern_str, fl.bool("F"))
        use_search = (should_use_search(
            is_regex=(pt == PatternType.REGEX),
            recursive=True,
            on_default_branch=(accessor.ref == accessor.default_branch),
        ) and is_repo_root(key) and file_count > SCOPE_WARN)
        if use_search:
            narrowed = await narrow_paths(accessor.config, accessor.owner,
                                          accessor.repo, pattern_str, paths)
            if narrowed:
                paths = narrowed
                file_count = len(narrowed)
            else:
                paths = await resolve_glob(accessor, paths, index)
        else:
            paths = await resolve_glob(accessor, paths, index)
        if file_count > SCOPE_ERROR:
            msg = f"rg: {file_count} files in scope, narrow the path\n"
            return b"", IOResult(exit_code=1, stderr=msg.encode())

    return await generic_rg(
        paths,
        texts,
        flags,
        readdir=_readdir,
        stat=_stat,
        read_bytes=cache_aware_read_bytes(github_read),
        read_stream=None,
        accessor=accessor,
        stdin=stdin,
        index=index,
    )
