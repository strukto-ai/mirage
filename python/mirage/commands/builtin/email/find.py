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
from functools import partial

from mirage.accessor.email import EmailAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.email._provision import metadata_provision
from mirage.commands.builtin.email.io import resolve_glob
from mirage.commands.builtin.generic.find import parse_find_args, walk_find
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.email._client import fetch_headers
from mirage.core.email.readdir import _date_from_header, _sanitize, is_dir_name
from mirage.core.email.readdir import readdir as _readdir
from mirage.core.email.scope import extract_folder
from mirage.core.email.search import search_messages
from mirage.core.email.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


def _is_folder_level(paths: list[PathSpec]) -> bool:
    if not paths:
        return False
    key = paths[0].mount_path.strip("/")
    parts = [x for x in key.split("/") if x]
    return len(parts) <= 1


async def find_provision(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await metadata_provision("find " + " ".join(
        p.virtual if isinstance(p, PathSpec) else p for p in paths))


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
    empty: bool = False,
    prefix: str = "",
    index: IndexCacheStore,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await resolve_glob(accessor, paths, index)
    # A pure -name search at folder level pushes the subject query down to
    # IMAP search instead of walking every message; any other predicate
    # falls through to the local walk so nothing is silently dropped.
    name_only = not (texts or size or mtime or type or iname or path
                     or mindepth or maxdepth or empty)
    if name and name_only and _is_folder_level(paths):
        p0 = paths[0]
        search_prefix = mount_prefix_of(p0.virtual, p0.resource_path)
        return await _find_server_side(accessor, paths, name, search_prefix)

    args = parse_find_args(texts,
                           name=name,
                           type=type,
                           size=size,
                           mtime=mtime,
                           maxdepth=maxdepth,
                           iname=iname,
                           path=path,
                           mindepth=mindepth,
                           empty=empty)
    searches = paths if paths else [
        PathSpec(virtual="/", directory="/", resource_path="")
    ]
    results: list[str] = []
    for search in searches:
        results.extend(await walk_find(search,
                                       readdir=partial(_readdir, accessor),
                                       stat=partial(_stat, accessor),
                                       is_dir_name=is_dir_name,
                                       index=index,
                                       args=args))
    return format_records(results), IOResult()


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

    output = format_records(sorted(results))
    return output, IOResult()
