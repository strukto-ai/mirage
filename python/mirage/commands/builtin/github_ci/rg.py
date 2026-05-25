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

from mirage.accessor.github_ci import GitHubCIAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.github_ci.glob import is_cross_run_root, resolve_glob
from mirage.core.github_ci.read import read as ci_read
from mirage.core.github_ci.readdir import readdir as _readdir
from mirage.core.github_ci.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("rg", resource="github_ci", spec=SPECS["rg"])
async def rg(
    accessor: GitHubCIAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    i: bool = False,
    v: bool = False,
    n: bool = False,
    c: bool = False,
    args_l: bool = False,
    w: bool = False,
    F: bool = False,
    o: bool = False,
    m: str | None = None,
    A: str | None = None,
    B: str | None = None,
    C: str | None = None,
    hidden: bool = False,
    type: str | None = None,
    glob: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise ValueError("rg: usage: rg [flags] pattern [path]")
    pattern = texts[0]
    max_count = int(m) if m is not None else None
    context_after = int(A) if A is not None else 0
    context_before = int(B) if B is not None else 0
    if C is not None:
        context_before = context_after = int(C)
    resolved = await resolve_glob(accessor, paths, index) if paths else []
    if any(is_cross_run_root(p) for p in resolved):
        raise ValueError("rg: recursive search across runs is disabled; "
                         "target a specific run (e.g. /ci/runs/<run>/jobs)")
    return await generic_rg(
        resolved,
        pattern=pattern,
        readdir=_readdir,
        stat=_stat,
        read_bytes=ci_read,
        read_stream=None,
        accessor=accessor,
        stdin=stdin,
        ignore_case=i,
        invert=v,
        line_numbers=n,
        count_only=c,
        files_only=args_l,
        whole_word=w,
        fixed_string=F,
        only_matching=o,
        max_count=max_count,
        context_before=context_before,
        context_after=context_after,
        hidden=hidden,
        file_type=type,
        glob_pattern=glob,
        index=index,
    )
