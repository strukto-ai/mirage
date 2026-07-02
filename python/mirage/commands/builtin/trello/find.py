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

from mirage.accessor.trello import TrelloAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.find_helper import (_parse_depth,
                                                 _validate_size_mtime)
from mirage.commands.builtin.trello._provision import metadata_provision
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.trello.glob import resolve_glob
from mirage.core.trello.readdir import readdir
from mirage.core.trello.stat import stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of


async def _walk(
    accessor: TrelloAccessor,
    path: PathSpec,
    index: IndexCacheStore | None,
) -> list[str]:
    results = [path.virtual]
    file_stat = await stat(accessor, path, index)
    if file_stat.type != FileType.DIRECTORY:
        return results
    for entry in await readdir(accessor, path, index):
        entry_spec = PathSpec(virtual=entry,
                              directory=entry,
                              resolved=False,
                              resource_path=mount_key(
                                  entry,
                                  mount_prefix_of(path.virtual,
                                                  path.resource_path)))
        results.extend(await _walk(accessor, entry_spec, index))
    return results


async def find_provision(
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await metadata_provision("find " + " ".join(
        p.virtual if isinstance(p, PathSpec) else p for p in paths))


@command("find",
         resource="trello",
         spec=SPECS["find"],
         provision=find_provision)
async def find(
    accessor: TrelloAccessor,
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
    index: IndexCacheStore | None = index
    paths = await resolve_glob(accessor, paths, index)
    p0 = paths[0]
    root = p0.virtual
    pfx = mount_prefix_of(p0.virtual, p0.resource_path)
    max_depth_val = (_parse_depth(maxdepth, "-maxdepth")
                     if maxdepth is not None else None)
    min_depth_val = (_parse_depth(mindepth, "-mindepth")
                     if mindepth is not None else None)
    _validate_size_mtime(size, mtime)
    all_paths = await _walk(accessor, p0, index)
    stripped_root = root
    if pfx and stripped_root.startswith(pfx):
        stripped_root = stripped_root[len(pfx):] or "/"
    root_depth = stripped_root.strip("/").count("/") if stripped_root.strip(
        "/") else 0
    wanted_type = {"d": FileType.DIRECTORY, "f": None}.get(type)
    results: list[str] = []
    for entry_path in all_paths:
        stripped_entry = entry_path
        if pfx and stripped_entry.startswith(pfx):
            stripped_entry = stripped_entry[len(pfx):] or "/"
        if entry_path == root:
            depth = 0
        else:
            depth = stripped_entry.strip("/").count("/") - root_depth
        if max_depth_val is not None and depth > max_depth_val:
            continue
        if min_depth_val is not None and depth < min_depth_val:
            continue
        entry_spec = PathSpec(virtual=entry_path,
                              directory=entry_path,
                              resolved=False,
                              resource_path=mount_key(entry_path, pfx))
        file_stat = await stat(accessor, entry_spec, index)
        if (wanted_type == FileType.DIRECTORY
                and file_stat.type != FileType.DIRECTORY):
            continue
        if type == "f" and file_stat.type == FileType.DIRECTORY:
            continue
        matcher = iname or name
        candidate = file_stat.name.lower() if iname else file_stat.name
        pattern = matcher.lower() if iname and matcher else matcher
        if pattern and not fnmatch.fnmatch(candidate, pattern):
            continue
        if pfx and not entry_path.startswith(pfx):
            value = pfx + "/" + entry_path.lstrip("/")
        else:
            value = entry_path
        results.append(value)
    return format_records(results), IOResult()
