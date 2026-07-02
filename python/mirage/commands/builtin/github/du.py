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
from mirage.commands.builtin.generic.du import du_multi
from mirage.commands.builtin.github._provision import metadata_provision
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.github.glob import resolve_glob
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def _du_total(index: IndexCacheStore, path: PathSpec) -> int:
    key = "/" + path.resource_path if path.resource_path else "/"
    du_prefix = key.rstrip("/") + "/"
    total = 0
    for ep, entry in index._entries.items():
        if (ep == key or ep.startswith(du_prefix)) and entry.size is not None:
            total += entry.size
    return total


async def du_provision(
    accessor: GitHubAccessor,
    paths: list[PathSpec],
    *texts: str,
    index: IndexCacheStore = None,
    **_extra: object,
) -> ProvisionResult:
    return await metadata_provision("du " + " ".join(
        p.virtual if isinstance(p, PathSpec) else p for p in paths))


@command("du", resource="github", spec=SPECS["du"], provision=du_provision)
async def du(
    accessor: GitHubAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    h: bool = False,
    s: bool = False,
    a: bool = False,
    max_depth: str | None = None,
    c: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if index is None:
        raise ValueError("du: no tree loaded")
    paths = await resolve_glob(accessor, paths, index)
    out = await du_multi(
        paths,
        compute_total=partial(_du_total, index),
        h=h,
        s=s,
        a=a,
        c=c,
    )
    return out, IOResult()
