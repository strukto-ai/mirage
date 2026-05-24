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

from mirage.accessor.paperclip import PaperclipAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.paperclip.glob import resolve_glob
from mirage.core.paperclip.read import read as paperclip_read
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _number_lines(data: bytes) -> AsyncIterator[bytes]:
    lines = data.decode(errors="replace").splitlines()
    for i, line in enumerate(lines, 1):
        yield f"     {i}\t{line}\n".encode()


@command("cat", resource="paperclip", spec=SPECS["cat"])
async def cat(
    accessor: PaperclipAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths)
        p = paths[0]
        data = await paperclip_read(accessor, p, index)
        io = IOResult(reads={p.strip_prefix: data}, cache=[p.strip_prefix])
        if n:
            return _number_lines(data), io
        return data, io
    source = _resolve_source(stdin, "cat: missing operand")
    if n:
        raw = b""
        async for chunk in source:
            raw += chunk
        return _number_lines(raw), IOResult()
    return source, IOResult()
