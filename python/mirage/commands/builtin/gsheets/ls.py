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

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.gsheets._provision import metadata_provision
from mirage.commands.builtin.utils.formatting import _human_size
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.gsheets.glob import resolve_glob
from mirage.core.gsheets.readdir import readdir
from mirage.core.gsheets.stat import stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import FileType, PathSpec


async def _ls_async(
    accessor: GSheetsAccessor,
    path: PathSpec,
    long: bool = False,
    all_files: bool = False,
    sort_by: str = "name",
    reverse: bool = False,
    recursive: bool = False,
    list_dir: bool = False,
    warnings: list[str] | None = None,
    index: IndexCacheStore = None,
):
    if list_dir:
        entries = [await stat(accessor, path, index)]
    else:
        raw = await readdir(accessor, path, index)
        entries = []
        for e in raw:
            try:
                e_spec = PathSpec(original=e,
                                  directory=e,
                                  resolved=False,
                                  prefix=path.prefix)
                entries.append(await stat(accessor, e_spec, index))
            except (FileNotFoundError, ValueError) as exc:
                if warnings is not None:
                    warnings.append(f"ls: cannot access '{e}': {exc}")

    if not all_files:
        entries = [e for e in entries if not e.name.startswith(".")]

    if sort_by == "size":
        entries = sorted(entries,
                         key=lambda e: e.size or 0,
                         reverse=not reverse)
    else:
        entries = sorted(entries, key=lambda e: e.name, reverse=reverse)

    if recursive:
        all_entries = []
        for e in entries:
            all_entries.append(e)
            if e.type == FileType.DIRECTORY:
                sub_path = path.child(e.name)
                sub_spec = PathSpec(original=sub_path,
                                    directory=sub_path,
                                    resolved=False,
                                    prefix=path.prefix)
                sub = await _ls_async(accessor,
                                      sub_spec,
                                      long=long,
                                      all_files=all_files,
                                      sort_by=sort_by,
                                      reverse=reverse,
                                      recursive=True,
                                      warnings=warnings,
                                      index=index)
                all_entries.extend(sub)
        return all_entries
    return entries


async def ls_provision(
    accessor: GSheetsAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await metadata_provision(
        "ls " + " ".join(p.original if isinstance(p, PathSpec) else p
                         for p in paths),
        index=_extra.get("index"))


@command("ls", resource="gsheets", spec=SPECS["ls"], provision=ls_provision)
async def ls(
    accessor: GSheetsAccessor,
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
    sort_by = "name"
    if S:
        sort_by = "size"
    warnings: list[str] = []
    results: list[str] = []
    if not paths:
        cwd = _extra.get("cwd", "/")
        paths = [cwd] if isinstance(cwd, PathSpec) else [
            PathSpec(original=cwd, directory=cwd, resolved=False)
        ]
    paths = await resolve_glob(accessor, paths, _extra.get("index"))
    for p in paths:
        try:
            entries = await _ls_async(
                accessor,
                p,
                long=args_l,
                all_files=all_files,
                sort_by=sort_by,
                reverse=r,
                recursive=R,
                list_dir=d,
                warnings=warnings,
                index=_extra.get("index"),
            )
        except (FileNotFoundError, ValueError) as exc:
            warnings.append(f"ls: cannot access '{p.original}': {exc}")
            continue
        if args_l and not args_1:
            for e in entries:
                size_str = _human_size(e.size or 0) if h else str(e.size or 0)
                line = (f"{e.type or '-'}\t{size_str}"
                        f"\t{e.modified or ''}\t{e.name}")
                results.append(line)
        else:
            for e in entries:
                is_dir = F and e.type == FileType.DIRECTORY
                name = e.name + "/" if is_dir else e.name
                results.append(name)
    stderr = "\n".join(warnings).encode() if warnings else None
    exit_code = 1 if warnings and not results else 0
    output = "\n".join(results).encode()
    return output, IOResult(stderr=stderr, exit_code=exit_code)
