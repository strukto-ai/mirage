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

from mirage.accessor.notion import NotionAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.notion._provision import file_read_provision
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.notion.glob import resolve_glob
from mirage.core.notion.read import read as notion_read
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def cat_provision(
    accessor: NotionAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await file_read_provision(
        accessor, paths,
        "cat " + " ".join(p.original if isinstance(p, PathSpec) else p
                          for p in paths))


async def _number_lines(data: bytes) -> AsyncIterator[bytes]:
    lines = data.decode(errors="replace").splitlines()
    for i, line in enumerate(lines, 1):
        yield f"     {i}\t{line}\n".encode()


@command("cat", resource="notion", spec=SPECS["cat"], provision=cat_provision)
async def cat(
    accessor: NotionAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths, index)
        p = paths[0]
        data = await notion_read(accessor, p, index)
        io = IOResult(reads={p.strip_prefix: data}, cache=[p.strip_prefix])
        if n:
            return _number_lines(data), io
        return yield_bytes(data), io
    source = _resolve_source(stdin, "cat: missing operand")
    if n:
        raw = b""
        async for chunk in source:
            raw += chunk
        return _number_lines(raw), IOResult()
    return source, IOResult()
