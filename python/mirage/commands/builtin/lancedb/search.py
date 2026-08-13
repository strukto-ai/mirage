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

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.commands.builtin.lancedb._provision import metadata_provision
from mirage.commands.builtin.utils.paths import default_paths
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.lancedb.search import search_rows_output
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


async def search_provision(accessor: LanceDBAccessor, paths: list[PathSpec],
                           texts: list[str],
                           opts: CommandOpts) -> ProvisionResult:
    return await metadata_provision(
        accessor, paths, texts,
        replace(opts, command="search " + " ".join(texts)))


@command("search",
         resource="lancedb",
         spec=SPECS["search"],
         provision=search_provision)
async def search(
    accessor: LanceDBAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["search"])
    if not texts:
        raise ValueError("search: query is required")
    if (fl.as_str("method") or "semantic") != "semantic":
        raise ValueError("search: only the 'semantic' method is supported")
    query = texts[0]
    target_paths = default_paths(paths, opts.cwd)
    mount_prefix = mount_prefix_of(
        target_paths[0].virtual,
        target_paths[0].resource_path) if target_paths else ""
    top_k = fl.as_int("top_k")
    limit = top_k if top_k is not None else accessor.config.search_limit
    output = await search_rows_output(accessor,
                                      query,
                                      target_paths,
                                      top_k=limit,
                                      threshold=fl.as_float("threshold")
                                      or 0.0,
                                      mount_prefix=mount_prefix)
    return output, IOResult()
