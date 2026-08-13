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

from dataclasses import replace
from functools import partial

from mirage.accessor.github_ci import GitHubCIAccessor
from mirage.commands.builtin.generic.find import (is_link, parse_find_args,
                                                  resolve_start, walk_find)
from mirage.commands.builtin.github_ci._provision import metadata_provision
from mirage.commands.builtin.github_ci.io import resolve_glob
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.github_ci.readdir import is_cross_run_root
from mirage.core.github_ci.readdir import readdir as _readdir
from mirage.core.github_ci.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def find_provision(accessor: GitHubCIAccessor, paths: list[PathSpec],
                         texts: list[str],
                         opts: CommandOpts) -> ProvisionResult:
    return await metadata_provision(
        accessor, paths, texts,
        replace(opts, command="find " + " ".join(p.virtual for p in paths)))


@command("find",
         resource="github_ci",
         spec=SPECS["find"],
         provision=find_provision)
async def find(
    accessor: GitHubCIAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    # The wrapper only exists for the cross-run guard: walking every run
    # would fetch every run's logs. Filtering is the shared generic walk.
    fl = FlagView(opts.flags, spec=SPECS["find"])
    paths = await resolve_glob(accessor, paths, index=opts.index)
    searches = paths if paths else [
        PathSpec(virtual="/", directory="/", resource_path="")
    ]
    args = parse_find_args(tuple(texts),
                           name=fl.as_str("name"),
                           type=fl.as_str("type"),
                           size=fl.as_str("size"),
                           mtime=fl.as_str("mtime"),
                           maxdepth=fl.as_str("maxdepth"),
                           iname=fl.as_str("iname"),
                           path=fl.as_str("path"),
                           mindepth=fl.as_str("mindepth"),
                           empty=fl.as_bool("empty"))
    results: list[str] = []
    for search in searches:
        # Same start-point rule as every other find path: only a
        # directory has a subtree to walk.
        start = await resolve_start(search,
                                    args,
                                    opts.stat_path,
                                    is_link=is_link(opts.links, search))
        if not start.walk:
            results.extend(start.results)
            continue
        if is_cross_run_root(search):
            raise ValueError("find: recursive search across runs is disabled;"
                             " target a specific run (e.g. /ci/runs/<run>)")
        results.extend(await walk_find(search,
                                       readdir=partial(_readdir, accessor),
                                       stat=partial(_stat, accessor),
                                       index=opts.index,
                                       args=args,
                                       links=opts.links,
                                       follow=fl.as_bool("L")))
    return format_records(results), IOResult()
