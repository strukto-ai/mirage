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

from mirage.accessor.qdrant import QdrantAccessor
from mirage.commands.builtin.qdrant._provision import metadata_provision
from mirage.commands.errors import UsageError
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.qdrant.search import search_rows_output
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


def _default_paths(paths: list[PathSpec],
                   cwd: PathSpec | None) -> list[PathSpec]:
    if paths:
        return paths
    if cwd is not None:
        return [cwd]
    return [
        PathSpec(resource_path=("/").strip("/"), virtual="/", directory="/")
    ]


async def search_provision(
    accessor: QdrantAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await metadata_provision("search " + " ".join(texts))


@command("search",
         resource="qdrant",
         spec=SPECS["search"],
         provision=search_provision)
async def search(
    accessor: QdrantAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    method: str = "semantic",
    top_k: str | int | None = None,
    threshold: str | float = 0.0,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise UsageError("search: query is required")
    if method != "semantic":
        raise UsageError("search: only the 'semantic' method is supported")
    query = texts[0]
    cwd = _extra.get("cwd")
    target_paths = _default_paths(paths,
                                  cwd if isinstance(cwd, PathSpec) else None)
    mount_prefix = mount_prefix_of(
        target_paths[0].virtual,
        target_paths[0].resource_path) if target_paths else ""
    limit = int(top_k) if top_k is not None else accessor.config.search_limit
    output = await search_rows_output(accessor,
                                      query,
                                      target_paths,
                                      top_k=limit,
                                      threshold=float(threshold),
                                      mount_prefix=mount_prefix)
    return output, IOResult()
