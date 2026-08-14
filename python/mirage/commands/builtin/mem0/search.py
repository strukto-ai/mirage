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

from dataclasses import dataclass

from mirage.accessor.mem0 import Mem0Accessor
from mirage.commands.builtin.generic_bind import metadata_provision
from mirage.commands.builtin.mem0.io import resolve_glob
from mirage.commands.builtin.utils.paths import default_paths
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.mem0.scope import ScopeLevel, detect
from mirage.core.mem0.search import search_memories_rendered
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


@dataclass(frozen=True, slots=True)
class SearchFlags:
    method: str
    top_k: int
    threshold: float


def parse_flags(fl: FlagView, default_limit: int) -> SearchFlags:
    method = fl.as_str("method") or "semantic"
    try:
        top_k_value = fl.as_int("top_k")
        threshold = float(fl.as_str("threshold") or "0")
    except ValueError as exc:
        raise UsageError("search: invalid numeric option") from exc
    top_k = default_limit if top_k_value is None else top_k_value
    return SearchFlags(method=method, top_k=top_k, threshold=threshold)


def is_mount_root(path: PathSpec) -> bool:
    root = mount_prefix_of(path.virtual, path.resource_path).rstrip("/") or "/"
    value = path.virtual.rstrip("/") or "/"
    return value == "/" or value == root


def memory_ids(paths: list[PathSpec]) -> set[str]:
    ids: set[str] = set()
    for path in paths:
        scope = detect(path)
        if scope.level != ScopeLevel.MEMORY or scope.memory_id is None:
            raise FileNotFoundError(path.virtual)
        ids.add(scope.memory_id)
    return ids


@command("search",
         resource="mem0",
         spec=SPECS["search"],
         provision=metadata_provision)
async def search(accessor: Mem0Accessor, paths: list[PathSpec],
                 texts: list[str],
                 opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise UsageError("search: query is required")
    query = texts[0]
    parsed = parse_flags(FlagView(opts.flags, spec=SPECS["search"]),
                         accessor.config.default_search_limit)
    if parsed.method != "semantic":
        raise UsageError("search: only the 'semantic' method is supported")
    target_paths = default_paths(paths, opts.cwd)
    mount_prefix = mount_prefix_of(target_paths[0].virtual,
                                   target_paths[0].resource_path)
    target_ids: set[str] | None = None
    if not any(is_mount_root(path) for path in target_paths):
        target_ids = memory_ids(await resolve_glob(accessor, target_paths,
                                                   opts.index))
    output = await search_memories_rendered(
        accessor,
        query,
        mount_prefix=mount_prefix,
        top_k=parsed.top_k,
        threshold=parsed.threshold,
        memory_ids=target_ids,
    )
    return output, IOResult()
