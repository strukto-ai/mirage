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
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.databricks_volume.glob import resolve_glob
from mirage.core.databricks_volume.readdir import readdir
from mirage.core.databricks_volume.stat import stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


async def _tree_recurse(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    prefix: str = "",
    max_depth: int | None = None,
    show_hidden: bool = False,
    dirs_only: bool = False,
    depth: int = 0,
    warnings: list[str] | None = None,
    index: IndexCacheStore | None = None,
) -> list[str]:
    lines: list[str] = []
    try:
        entries = await readdir(accessor, path, index)
    except (FileNotFoundError, ValueError) as exc:
        if warnings is not None:
            warnings.append(f"tree: '{path.original}': {exc}")
        return lines
    filtered: list[tuple[PathSpec, str, FileType | None]] = []
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
            if warnings is not None:
                warnings.append(f"tree: '{entry}': {exc}")
            continue
        if not show_hidden and entry_stat.name.startswith("."):
            continue
        if dirs_only and entry_stat.type != FileType.DIRECTORY:
            continue
        filtered.append((entry_spec, entry_stat.name, entry_stat.type))
    for i, (entry_spec, name, file_type) in enumerate(filtered):
        is_last = i == len(filtered) - 1
        connector = "\u2514\u2500\u2500 " if is_last else "\u251c\u2500\u2500 "
        lines.append(prefix + connector + name)
        if file_type != FileType.DIRECTORY:
            continue
        if max_depth is not None and depth >= max_depth:
            continue
        extension = "    " if is_last else "\u2502   "
        lines.extend(await _tree_recurse(
            accessor,
            entry_spec,
            prefix + extension,
            max_depth=max_depth,
            show_hidden=show_hidden,
            dirs_only=dirs_only,
            depth=depth + 1,
            warnings=warnings,
            index=index,
        ))
    return lines


@command("tree", resource="databricks_volume", spec=SPECS["tree"])
async def tree(
    accessor: DatabricksVolumeAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    L: str | None = None,
    a: bool = False,
    d: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await resolve_glob(accessor, paths, index)
    path = paths[0]
    max_depth = int(L) if L is not None else None
    warnings: list[str] = []
    results = await _tree_recurse(
        accessor,
        path,
        max_depth=max_depth,
        show_hidden=a,
        dirs_only=d,
        warnings=warnings,
        index=index,
    )
    stderr = "\n".join(warnings).encode() if warnings else None
    return "\n".join(results).encode(), IOResult(stderr=stderr)
