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
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.redis.glob import resolve_glob
from mirage.core.redis.read import read_bytes as _read_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _comm_merge(lines1: list[str], lines2: list[str]) -> list[tuple[int, str]]:
    result: list[tuple[int, str]] = []
    i, j = 0, 0
    while i < len(lines1) and j < len(lines2):
        if lines1[i] < lines2[j]:
            result.append((1, lines1[i]))
            i += 1
        elif lines1[i] > lines2[j]:
            result.append((2, lines2[j]))
            j += 1
        else:
            result.append((3, lines1[i]))
            i += 1
            j += 1
    while i < len(lines1):
        result.append((1, lines1[i]))
        i += 1
    while j < len(lines2):
        result.append((2, lines2[j]))
        j += 1
    return result


def _format_comm(
    merged: list[tuple[int, str]],
    suppress1: bool,
    suppress2: bool,
    suppress3: bool,
) -> str:
    out: list[str] = []
    for col, text in merged:
        if col == 1 and not suppress1:
            out.append(text)
        elif col == 2 and not suppress2:
            prefix = "" if suppress1 else "\t"
            out.append(prefix + text)
        elif col == 3 and not suppress3:
            prefix = ""
            if not suppress1:
                prefix += "\t"
            if not suppress2:
                prefix += "\t"
            out.append(prefix + text)
    return "\n".join(out) + "\n" if out else ""


@command("comm", resource="redis", spec=SPECS["comm"])
async def comm(
    accessor: RedisAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    check_order: bool = False,
    nocheck_order: bool = False,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if accessor.store is None or len(paths) < 2:
        raise ValueError("comm: requires two paths")
    paths = await resolve_glob(accessor, paths, _extra.get("index"))
    data1 = (await _read_bytes(accessor, paths[0])).decode(errors="replace")
    data2 = (await _read_bytes(accessor, paths[1])).decode(errors="replace")
    lines1 = data1.splitlines()
    lines2 = data2.splitlines()
    stderr = ""
    if check_order:
        if lines1 != sorted(lines1):
            stderr = "comm: file 1 is not in sorted order\n"
        elif lines2 != sorted(lines2):
            stderr = "comm: file 2 is not in sorted order\n"
    suppress1 = bool(_extra.get("args_1", False))
    suppress2 = bool(_extra.get("2", False))
    suppress3 = bool(_extra.get("3", False))
    merged = _comm_merge(lines1, lines2)
    output = _format_comm(merged, suppress1, suppress2, suppress3)
    return output.encode(), IOResult(
        stderr=stderr.encode() if stderr else None)
