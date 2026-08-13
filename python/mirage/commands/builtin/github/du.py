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
from mirage.commands.builtin.generic.du import du_generic
from mirage.commands.builtin.github._provision import metadata_provision
from mirage.commands.builtin.github.io import IO, resolve_glob
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def _subtree(index: IndexCacheStore,
                   path: PathSpec) -> list[tuple[str, int]]:
    key = "/" + path.resource_path if path.resource_path else "/"
    prefix = key.rstrip("/") + "/"
    found = [(ep, entry.size) for ep, entry in (await index.entries()).items()
             if (ep == key or ep.startswith(prefix)) and entry.size is not None
             ]
    found.sort()
    return found


async def _du_size(index: IndexCacheStore, path: PathSpec) -> int:
    return sum(size for _, size in await _subtree(index, path))


async def _du_entries(index: IndexCacheStore,
                      path: PathSpec) -> tuple[list[tuple[str, int]], int]:
    found = await _subtree(index, path)
    return found, sum(size for _, size in found)


async def du_provision(accessor: GitHubAccessor, paths: list[PathSpec],
                       texts: list[str], opts: CommandOpts) -> ProvisionResult:
    return await metadata_provision("du " + " ".join(
        p.virtual if isinstance(p, PathSpec) else p for p in paths))


async def _resolve(accessor: GitHubAccessor, index: IndexCacheStore,
                   targets: list[PathSpec]) -> list[PathSpec]:
    return await resolve_glob(accessor, targets, index)


async def _stat(accessor: GitHubAccessor, index: IndexCacheStore,
                path: PathSpec):
    return await IO.stat(accessor, path, index)


@command("du", resource="github", spec=SPECS["du"], provision=du_provision)
async def du(accessor: GitHubAccessor, paths: list[PathSpec], texts: list[str],
             opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    return await du_generic(paths, list(texts), opts,
                            partial(_resolve, accessor, opts.index),
                            partial(_stat, accessor, opts.index),
                            partial(_du_size, opts.index),
                            partial(_du_entries, opts.index))
