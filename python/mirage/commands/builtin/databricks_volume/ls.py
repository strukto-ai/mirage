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

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.formatting import _human_size
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.databricks_volume.glob import resolve_glob
from mirage.core.databricks_volume.readdir import readdir
from mirage.core.databricks_volume.stat import stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FileType, PathSpec


async def _ls_entries(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    all_files: bool,
    sort_by: str,
    reverse: bool,
    recursive: bool,
    list_dir: bool,
    warnings: list[str],
    index: IndexCacheStore | None = None,
) -> list[FileStat]:
    if list_dir:
        return [await stat(accessor, path, index)]

    try:
        entries = await readdir(accessor, path, index)
    except (FileNotFoundError, ValueError) as exc:
        warnings.append(f"ls: cannot access '{path.original}': {exc}")
        return []

    stats: list[FileStat] = []
    for entry in entries:
        try:
            entry_spec = PathSpec(
                original=entry,
                directory=entry,
                resolved=False,
                prefix=path.prefix,
            )
            entry_stat = await stat(accessor, entry_spec, index)
        except (FileNotFoundError, ValueError) as exc:
            warnings.append(f"ls: cannot access '{entry}': {exc}")
            continue
        if not all_files and entry_stat.name.startswith("."):
            continue
        stats.append(entry_stat)

    if sort_by == "time":
        stats.sort(key=lambda entry: entry.modified or "", reverse=not reverse)
    elif sort_by == "size":
        stats.sort(key=lambda entry: entry.size or 0, reverse=not reverse)
    else:
        stats.sort(key=lambda entry: entry.name, reverse=reverse)

    if recursive:
        sub_entries: list[FileStat] = []
        for entry_stat in stats:
            sub_entries.append(entry_stat)
            if entry_stat.type == FileType.DIRECTORY:
                entry_path = path.child(entry_stat.name)
                entry_spec = PathSpec(
                    original=entry_path,
                    directory=entry_path,
                    resolved=False,
                    prefix=path.prefix,
                )
                sub_entries.extend(await _ls_entries(
                    accessor,
                    entry_spec,
                    all_files,
                    sort_by,
                    reverse,
                    recursive,
                    False,
                    warnings,
                    index,
                ))
        return sub_entries

    return stats


@command("ls", resource="databricks_volume", spec=SPECS["ls"])
async def ls(
    accessor: DatabricksVolumeAccessor,
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
    index: IndexCacheStore = None,
    cwd: PathSpec | str = "/",
    prefix: str = "",
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        cwd_str = cwd.original if isinstance(cwd, PathSpec) else cwd
        cwd_prefix = cwd.prefix if isinstance(cwd, PathSpec) else ""
        paths = [
            PathSpec(
                original=cwd_str,
                directory=cwd_str,
                resolved=False,
                prefix=cwd_prefix,
            )
        ]
    paths = await resolve_glob(accessor, paths, index)
    all_files = a or A
    sort_by = "name"
    if t:
        sort_by = "time"
    elif S:
        sort_by = "size"
    warnings: list[str] = []
    results: list[str] = []
    for path in paths:
        try:
            entries = await _ls_entries(
                accessor,
                path,
                all_files,
                sort_by,
                r,
                R,
                d,
                warnings,
                index,
            )
        except (FileNotFoundError, ValueError) as exc:
            warnings.append(f"ls: cannot access '{path.original}': {exc}")
            continue
        if args_l and not args_1:
            for entry in entries:
                size_str = _human_size(entry.size or 0) if h else str(
                    entry.size or 0)
                results.append(f"{entry.type or '-'}\t{size_str}\t"
                               f"{entry.modified or ''}\t{entry.name}")
        else:
            for entry in entries:
                is_dir = F and entry.type == FileType.DIRECTORY
                results.append(entry.name + ("/" if is_dir else ""))
    stderr = "\n".join(warnings).encode() if warnings else None
    exit_code = 1 if warnings and not results else 0
    return "\n".join(results).encode(), IOResult(
        stderr=stderr,
        exit_code=exit_code,
    )
