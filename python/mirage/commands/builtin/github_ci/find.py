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

from mirage.accessor.github_ci import GitHubCIAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.find import parse_find_args, walk_find
from mirage.commands.builtin.github_ci._provision import metadata_provision
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.github_ci.glob import is_cross_run_root, resolve_glob
from mirage.core.github_ci.readdir import is_dir_name
from mirage.core.github_ci.readdir import readdir as _readdir
from mirage.core.github_ci.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def find_provision(
    accessor: GitHubCIAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await metadata_provision("find " + " ".join(
        p.virtual if isinstance(p, PathSpec) else p for p in paths))


@command("find",
         resource="github_ci",
         spec=SPECS["find"],
         provision=find_provision)
async def find(
    accessor: GitHubCIAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    name: str | None = None,
    type: str | None = None,
    maxdepth: str | None = None,
    size: str | None = None,
    mtime: str | None = None,
    iname: str | None = None,
    path: str | None = None,
    mindepth: str | None = None,
    empty: bool = False,
    prefix: str = "",
    index: IndexCacheStore,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    # The wrapper only exists for the cross-run guard: walking every run
    # would fetch every run's logs. Filtering is the shared generic walk.
    paths = await resolve_glob(accessor, paths, index=index)
    searches = paths if paths else [
        PathSpec(virtual="/", directory="/", resource_path="")
    ]
    args = parse_find_args(texts,
                           name=name,
                           type=type,
                           size=size,
                           mtime=mtime,
                           maxdepth=maxdepth,
                           iname=iname,
                           path=path,
                           mindepth=mindepth,
                           empty=empty)
    results: list[str] = []
    for search in searches:
        if is_cross_run_root(search):
            raise ValueError("find: recursive search across runs is disabled;"
                             " target a specific run (e.g. /ci/runs/<run>)")
        results.extend(await walk_find(search,
                                       readdir=partial(_readdir, accessor),
                                       stat=partial(_stat, accessor),
                                       is_dir_name=is_dir_name,
                                       index=index,
                                       args=args))
    return format_records(results), IOResult()
