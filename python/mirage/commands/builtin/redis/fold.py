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

from collections.abc import AsyncIterator

from mirage.accessor.redis import RedisAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.redis.glob import resolve_glob
from mirage.core.redis.read import read_bytes as _read_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _fold_line(line: str, width: int, break_spaces: bool) -> str:
    if len(line) <= width:
        return line
    parts: list[str] = []
    while len(line) > width:
        if break_spaces:
            idx = line.rfind(" ", 0, width)
            if idx > 0:
                parts.append(line[:idx + 1])
                line = line[idx + 1:]
            else:
                parts.append(line[:width])
                line = line[width:]
        else:
            parts.append(line[:width])
            line = line[width:]
    if line:
        parts.append(line)
    return "\n".join(parts)


@command("fold", resource="redis", spec=SPECS["fold"])
async def fold(
    accessor: RedisAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    w: str | None = None,
    s: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    width = int(w) if w is not None else 80
    if paths and accessor.store is not None:
        paths = await resolve_glob(accessor, paths, index)
        all_lines: list[str] = []
        for p in paths:
            data = (await _read_bytes(accessor, p)).decode(errors="replace")
            for line in data.splitlines():
                all_lines.append(_fold_line(line, width, s))
        return ("\n".join(all_lines) + "\n").encode(), IOResult()
    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("fold: missing operand")
    lines = raw.decode(errors="replace").splitlines()
    result = [_fold_line(ln, width, s) for ln in lines]
    return ("\n".join(result) + "\n").encode(), IOResult()
