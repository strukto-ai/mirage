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

from mirage.accessor.ssh import SSHAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.ssh.glob import resolve_glob
from mirage.core.ssh.stat import stat as stat_impl
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


def _format_stat(fmt: str, s: FileStat) -> str:

    def _replace(m: re.Match) -> str:
        spec = m.group(1)
        if spec == "n":
            return s.name
        if spec == "s":
            return str(s.size if s.size is not None else 0)
        if spec == "F":
            return _TYPE_LABELS.get(
                s.type, "regular file") if s.type else "regular file"
        if spec == "y":
            return s.modified or ""
        return "?"

    return _FORMAT_RE.sub(_replace, fmt)


@command("stat", resource="ssh", spec=SPECS["stat"])
async def stat(
    accessor: SSHAccessor,
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
    for p in paths:
        s = await stat_impl(accessor, p)
        if fmt is not None:
            lines.append(_format_stat(fmt, s))
        else:
            lines.append(f"name={s.name} size={s.size}"
                         f" modified={s.modified}"
                         f" type={s.type.value if s.type else None}")
    return "\n".join(lines).encode(), IOResult()
