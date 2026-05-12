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

from mirage.accessor.trello import TrelloAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.trello._provision import metadata_provision
from mirage.commands.builtin.utils.formatting import _human_size
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.trello.glob import resolve_glob
from mirage.core.trello.readdir import readdir
from mirage.core.trello.stat import stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import FileType, PathSpec


async def ls_provision(
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await metadata_provision("ls " + " ".join(
        p.original if isinstance(p, PathSpec) else p for p in paths))


@command("ls", resource="trello", spec=SPECS["ls"], provision=ls_provision)
async def ls(
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    args_l: bool = False,
    args_1: bool = False,
    a: bool = False,
    A: bool = False,
    h: bool = False,
    t: bool = False,
    S: bool = False,
    r: bool = False,
    R: bool = False,
    d: bool = False,
    F: bool = False,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    all_files = a or A
    sort_by = "size" if S else "name"
    reverse = r
    index: IndexCacheStore | None = _extra.get("index")
    paths = await resolve_glob(accessor, paths, index)
    warnings: list[str] = []
    results: list[str] = []
    for p in paths:
        try:
            targets = ([p.original] if d else await readdir(
                accessor, p, index))
        except (FileNotFoundError, ValueError) as exc:
            warnings.append(f"ls: cannot access '{p.original}': {exc}")
            continue
        entries = []
        for entry_path in targets:
            entry_spec = PathSpec(original=entry_path,
                                  directory=entry_path,
                                  resolved=False,
                                  prefix=p.prefix)
            try:
                entries.append(await stat(accessor, entry_spec, index))
            except (FileNotFoundError, ValueError) as exc:
                warnings.append(f"ls: cannot access '{entry_path}': {exc}")
        if not all_files:
            entries = [
                entry for entry in entries if not entry.name.startswith(".")
            ]
        if sort_by == "size":
            entries.sort(key=lambda item: item.size or 0, reverse=not reverse)
        else:
            entries.sort(key=lambda item: item.name, reverse=reverse)
        for entry in entries:
            if args_l and not args_1:
                size_str = _human_size(entry.size or 0) if h else str(
                    entry.size or 0)
                results.append(f"{entry.type or '-'}\t{size_str}\t"
                               f"{entry.modified or ''}\t{entry.name}")
            else:
                suffix = "/" if F and entry.type == FileType.DIRECTORY else ""
                results.append(entry.name + suffix)
    stderr = "\n".join(warnings).encode() if warnings else None
    exit_code = 1 if warnings and not results else 0
    return "\n".join(results).encode(), IOResult(stderr=stderr,
                                                 exit_code=exit_code)
