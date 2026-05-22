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
from collections.abc import AsyncIterator

from mirage.accessor.email import EmailAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.email.glob import resolve_glob
from mirage.core.email.read import read as email_read
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _should_number(line: str, body_numbering: str,
                   pattern: re.Pattern[str] | None) -> bool:
    if body_numbering == "n":
        return False
    if body_numbering == "a":
        return True
    if body_numbering == "p" and pattern is not None:
        return pattern.search(line) is not None
    return bool(line.strip())


@command("nl", resource="email", spec=SPECS["nl"])
async def nl(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    b: str | None = None,
    v: str | None = None,
    i: str | None = None,
    w: str | None = None,
    s: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    body_numbering_raw = b if b is not None else "t"
    pattern: re.Pattern[str] | None = None
    if body_numbering_raw.startswith("p"):
        body_numbering = "p"
        pattern = re.compile(body_numbering_raw[1:])
    else:
        body_numbering = body_numbering_raw
    start = int(v) if v is not None else 1
    increment = int(i) if i is not None else 1
    width = int(w) if w is not None else 6
    separator = s if s is not None else "\t"

    if paths:
        paths = await resolve_glob(accessor, paths, index)
        p = paths[0]
        raw = await email_read(accessor, p, index)
    else:
        raw = await _read_stdin_async(stdin)
        if raw is None:
            raise ValueError("nl: missing operand")

    num = start
    out_lines: list[str] = []
    for line in raw.decode(errors="replace").splitlines():
        if _should_number(line, body_numbering, pattern):
            out_lines.append(f"{num:{width}d}{separator}{line}")
            num += increment
        else:
            out_lines.append(f"{' ' * width}{separator}{line}")
    return ("\n".join(out_lines) + "\n").encode(), IOResult()
