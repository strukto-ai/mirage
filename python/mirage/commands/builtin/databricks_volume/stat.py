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

import re
from functools import partial

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.databricks_volume.glob import resolve_glob
from mirage.core.databricks_volume.stat import stat as stat_impl
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FileType, PathSpec

_FORMAT_RE = re.compile(r"%([nsFy]|.)")

_TYPE_LABELS = {
    FileType.DIRECTORY: "directory",
    FileType.TEXT: "regular file",
    FileType.BINARY: "regular file",
    FileType.JSON: "regular file",
    FileType.CSV: "regular file",
}


def _stat_type_label(file_stat: FileStat) -> str:
    if file_stat.type is None:
        return "regular file"
    return _TYPE_LABELS.get(file_stat.type, "regular file")


def _replace_stat_format(file_stat: FileStat, match: re.Match) -> str:
    spec = match.group(1)
    if spec == "n":
        return file_stat.name
    if spec == "s":
        return str(file_stat.size if file_stat.size is not None else 0)
    if spec == "F":
        return _stat_type_label(file_stat)
    if spec == "y":
        return file_stat.modified or ""
    return "?"


def _format_stat(fmt: str, file_stat: FileStat) -> str:
    return _FORMAT_RE.sub(partial(_replace_stat_format, file_stat), fmt)


@command("stat", resource="databricks_volume", spec=SPECS["stat"])
async def stat(
    accessor: DatabricksVolumeAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    c: str | None = None,
    f: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("stat: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    fmt = c if c is not None else f
    lines: list[str] = []
    for path in paths:
        file_stat = await stat_impl(accessor, path, index)
        if fmt is not None:
            lines.append(_format_stat(fmt, file_stat))
        else:
            type_value = file_stat.type.value if file_stat.type else None
            lines.append(f"name={file_stat.name} size={file_stat.size}"
                         f" modified={file_stat.modified} type={type_value}")
    return "\n".join(lines).encode(), IOResult()
