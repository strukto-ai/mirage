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
from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.github_ci.glob import is_cross_run_root, resolve_glob
from mirage.core.github_ci.read import read as ci_read
from mirage.core.github_ci.readdir import readdir as _readdir
from mirage.core.github_ci.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("grep", resource="github_ci", spec=SPECS["grep"])
async def grep(
    accessor: GitHubCIAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    index: IndexCacheStore | None = None,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["grep"])
    resolved = await resolve_glob(accessor, paths, index) if paths else []
    recursive = fl.bool("r") or fl.bool("R")
    if recursive and any(is_cross_run_root(p) for p in resolved):
        raise ValueError("grep: recursive search across runs is disabled; "
                         "target a specific run (e.g. /ci/runs/<run>/jobs)")
    return await generic_grep(
        resolved,
        texts,
        flags,
        readdir=_readdir,
        stat=_stat,
        read_bytes=ci_read,
        read_stream=None,
        accessor=accessor,
        stdin=stdin,
        index=index,
    )
