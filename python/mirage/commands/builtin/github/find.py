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
from mirage.commands.builtin.generic.find import find_generic
from mirage.commands.builtin.github._provision import metadata_provision
from mirage.commands.builtin.github.io import resolve_glob
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.github.find import find as find_core
from mirage.core.github.stat import stat as stat_core
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def find_provision(accessor: GitHubAccessor, paths: list[PathSpec],
                         texts: list[str],
                         opts: CommandOpts) -> ProvisionResult:
    path_strs = [
        p.virtual if isinstance(p, PathSpec) else str(p) for p in paths
    ]
    return await metadata_provision("find " + " ".join(path_strs))


@command("find",
         resource="github",
         spec=SPECS["find"],
         provision=find_provision)
async def find(
    accessor: GitHubAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    paths = await resolve_glob(accessor, paths, opts.index)
    return await find_generic(paths,
                              texts,
                              opts,
                              find_core=partial(find_core,
                                                accessor,
                                                index=opts.index),
                              stat=partial(stat_core,
                                           accessor,
                                           index=opts.index))
