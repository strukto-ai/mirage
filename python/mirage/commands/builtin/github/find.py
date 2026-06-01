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

import fnmatch

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.github._provision import metadata_provision
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.github.glob import resolve_glob
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


def _match_entry(
    path: str,
    entry,
    name: str | None,
    ftype: str | None,
    maxdepth: int | None,
    base_depth: int,
) -> bool:
    depth = path.count("/") - base_depth
    if maxdepth is not None and depth > maxdepth:
        return False
    if name and not fnmatch.fnmatch(path.rsplit("/", 1)[-1], name):
        return False
    if ftype == "directory" and entry.resource_type != "folder":
        return False
    if ftype == "file" and entry.resource_type != "file":
        return False
    return True


async def find_provision(
    accessor: GitHubAccessor,
    paths: list[PathSpec],
    *texts: str,
    index: IndexCacheStore = None,
    **_extra: object,
) -> ProvisionResult:
    path_strs = [
        p.original if isinstance(p, PathSpec) else str(p) for p in paths
    ]
    return await metadata_provision("find " + " ".join(path_strs))


@command("find",
         resource="github",
         spec=SPECS["find"],
         provision=find_provision)
async def find(
    accessor: GitHubAccessor,
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
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if index is None:
        raise ValueError("find: no tree loaded")
    paths = await resolve_glob(accessor, paths, index)
    p = paths[0]
    mount_prefix = p.prefix if isinstance(p, PathSpec) else ""
    search_path = p.original
    if mount_prefix and search_path.startswith(mount_prefix):
        search_path = search_path[len(mount_prefix):] or "/"
    ftype = None
    if type == "d":
        ftype = "directory"
    elif type == "f":
        ftype = "file"
    elif type is not None:
        ftype = type
    md = int(maxdepth) if maxdepth is not None else None
    md_min = int(mindepth) if mindepth is not None else None

    key = search_path
    search_prefix = key + "/" if key != "/" else "/"
    base_depth = key.count("/") - 1 if key != "/" else -1

    results: list[str] = []
    for ep, entry in sorted(index._entries.items()):
        if key and not ep.startswith(search_prefix) and ep != key:
            continue
        if not key or ep.startswith(search_prefix) or ep == key:
            if not _match_entry(ep, entry, name, ftype, md, base_depth + 1):
                continue
            depth = ep.count("/") - (base_depth + 1) if key else ep.count("/")
            if md_min is not None and depth < md_min:
                continue
            results.append(ep)
    if mount_prefix:
        results = [mount_prefix + "/" + r.lstrip("/") for r in results]
    output = format_records(results)
    return output, IOResult()
