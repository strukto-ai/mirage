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

from mirage.accessor.disk import DiskAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.formatting import _human_size
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.disk.glob import resolve_glob
from mirage.core.disk.readdir import readdir
from mirage.core.disk.stat import stat as local_stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


def _get_extension(path: str) -> str | None:
    dot = path.rfind(".")
    if dot == -1 or "/" in path[dot:]:
        return None
    return path[dot:]


async def _ls_async(
    accessor: DiskAccessor,
    path: str,
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
        entries = [await local_stat(accessor, path)]
    else:
        raw = await readdir(accessor, path, index)
        entries = []
        for e in raw:
            try:
                entries.append(await local_stat(accessor, e))
            except (FileNotFoundError, ValueError) as exc:
                if warnings is not None:
                    warnings.append(f"ls: cannot access '{e}': {exc}")

    if not all_files:
        entries = [e for e in entries if not e.name.startswith(".")]

    if sort_by == "time":
        entries = sorted(entries,
                         key=lambda e: e.modified or "",
                         reverse=not reverse)
    elif sort_by == "size":
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
                sub_path = path.rstrip("/") + "/" + e.name
                sub = await _ls_async(accessor,
                                      sub_path,
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


@command("ls", resource="disk", spec=SPECS["ls"])
async def ls(
    accessor: DiskAccessor,
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
    filetype_fns: dict | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if accessor.root is None:
        raise ValueError("ls: no resource")
    paths = await resolve_glob(accessor, paths, index)
    all_files = a or A
    sort_by = "name"
    if t:
        sort_by = "time"
    elif S:
        sort_by = "size"
    warnings: list[str] = []
    results: list[str] = []
    for gp in paths:
        p = gp.strip_prefix
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
                index=index,
            )
        except (FileNotFoundError, ValueError) as exc:
            warnings.append(f"ls: cannot access '{gp.original}': {exc}")
            continue
        if args_l and not args_1:
            for e in entries:
                ext = _get_extension(e.name)
                if filetype_fns and ext in filetype_fns:
                    try:
                        fn = filetype_fns[ext]
                        path_for_entry = p.rstrip("/") + "/" + e.name
                        stdout, _io = await fn(
                            accessor,
                            [path_for_entry],
                            args_l=True,
                        )
                        if stdout:
                            if isinstance(stdout, bytes):
                                results.append(stdout.decode(errors="replace"))
                            else:
                                chunks = [chunk async for chunk in stdout]
                                results.append(
                                    b"".join(chunks).decode(errors="replace"))
                            continue
                    except Exception:
                        pass
                size_str = _human_size(e.size or 0) if h else str(e.size or 0)
                line = (f"{e.type or '-'}\t{size_str}"
                        f"\t{e.modified or ''}\t{e.name}")
                results.append(line)
        else:
            for e in entries:
                is_dir = F and e.type == FileType.DIRECTORY
                name = e.name + "/" if is_dir else e.name
                results.append(name)
    output = "\n".join(results).encode()
    stderr = "\n".join(warnings).encode() if warnings else None
    exit_code = 1 if warnings and not results else 0
    return output, IOResult(stderr=stderr, exit_code=exit_code)
