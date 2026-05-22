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

from mirage.accessor.gmail import GmailAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.gmail._provision import metadata_provision
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.gmail.glob import resolve_glob
from mirage.core.gmail.readdir import readdir as _readdir
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def _walk(
    accessor: GmailAccessor,
    path: PathSpec,
    index: IndexCacheStore | None,
    maxdepth: int | None,
    depth: int = 0,
) -> list[str]:
    if maxdepth is not None and depth > maxdepth:
        return []
    try:
        children = await _readdir(accessor, path, index)
    except FileNotFoundError:
        return []
    results: list[str] = []
    for child in children:
        results.append(child)
        if not child.endswith(".gmail.json"):
            child_spec = PathSpec(original=child,
                                  directory=child,
                                  resolved=False,
                                  prefix=path.prefix)
            results.extend(await _walk(accessor,
                                       child_spec,
                                       index,
                                       maxdepth,
                                       depth=depth + 1))
    return results


async def find_provision(
    accessor: GmailAccessor,
    paths: list[PathSpec],
    *texts: str,
    index: IndexCacheStore = None,
    **_extra: object,
) -> ProvisionResult:
    return await metadata_provision(
        "find " + " ".join(p.original if isinstance(p, PathSpec) else p
                           for p in paths),
        index=index)


@command("find",
         resource="gmail",
         spec=SPECS["find"],
         provision=find_provision)
async def find(
    accessor: GmailAccessor,
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
    prefix: str = "",
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    index = index
    paths = await resolve_glob(accessor, paths, index)
    p0 = paths[0] if paths else None
    search_path = p0.original if p0 else "/"
    search_prefix = p0.prefix if p0 else ""
    md = int(maxdepth) if maxdepth is not None else None
    md_min = int(mindepth) if mindepth is not None else None

    search_spec = PathSpec(original=search_path,
                           directory=search_path,
                           resolved=False,
                           prefix=search_prefix)
    all_paths = await _walk(accessor, search_spec, index, md)
    results: list[str] = []
    base_depth = search_path.strip("/").count("/") if search_path.strip(
        "/") else -1
    for p in sorted(all_paths):
        entry_name = p.rsplit("/", 1)[-1]
        depth = p.strip("/").count("/") - (base_depth + 1)
        if md_min is not None and depth < md_min:
            continue
        if name and not fnmatch.fnmatch(entry_name, name):
            continue
        if iname and not fnmatch.fnmatch(entry_name.lower(), iname.lower()):
            continue
        results.append(p)
    output = "\n".join(results).encode()
    return output, IOResult()
