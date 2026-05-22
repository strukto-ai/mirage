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

from mirage.accessor.email import EmailAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.email._provision import metadata_provision
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.email._client import fetch_headers
from mirage.core.email.glob import resolve_glob
from mirage.core.email.readdir import _date_from_header, _sanitize
from mirage.core.email.readdir import readdir as _readdir
from mirage.core.email.scope import extract_folder
from mirage.core.email.search import search_messages
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def _walk(
    accessor: EmailAccessor,
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
        if not child.endswith(".email.json"):
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


def _is_folder_level(paths: list[PathSpec]) -> bool:
    if not paths:
        return False
    key = paths[0].strip_prefix.strip("/")
    parts = [x for x in key.split("/") if x]
    return len(parts) <= 1


async def find_provision(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await metadata_provision("find " + " ".join(
        p.original if isinstance(p, PathSpec) else p for p in paths))


@command("find",
         resource="email",
         spec=SPECS["find"],
         provision=find_provision)
async def find(
    accessor: EmailAccessor,
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

    if name and _is_folder_level(paths):
        return await _find_server_side(accessor, paths, name, search_prefix)

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


async def _find_server_side(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    name_pattern: str,
    prefix: str,
) -> tuple[ByteSource | None, IOResult]:
    folder = extract_folder(paths)
    if not folder:
        return b"", IOResult()

    subject_query = name_pattern.replace("*", "").replace("?", "").replace(
        ".email.json", "").replace("__", " ").strip("_")
    if not subject_query:
        return b"", IOResult()

    uids = await search_messages(accessor,
                                 folder,
                                 subject=subject_query,
                                 max_results=accessor.config.max_messages)
    if not uids:
        return b"", IOResult()

    headers = await fetch_headers(accessor, folder, uids)
    results: list[str] = []
    for h in headers:
        date_str = _date_from_header(h.get("date", ""))
        subject = _sanitize(h.get("subject", "No Subject"))
        uid = h.get("uid", "")
        filename = f"{subject}__{uid}.email.json"
        if fnmatch.fnmatch(filename, name_pattern):
            vfs_path = "/".join(p
                                for p in [prefix, folder, date_str, filename]
                                if p)
            results.append(vfs_path)

    output = "\n".join(sorted(results)).encode()
    return output, IOResult()
