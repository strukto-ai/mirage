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

from mirage.accessor.linear import LinearAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.linear._provision import file_read_provision
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.linear.glob import resolve_glob
from mirage.core.linear.read import read as linear_read
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def wc_provision(
    accessor: LinearAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await file_read_provision(
        accessor, paths,
        "wc " + " ".join(p.original if isinstance(p, PathSpec) else p
                         for p in paths))


@command("wc", resource="linear", spec=SPECS["wc"], provision=wc_provision)
async def wc(
    accessor: LinearAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    args_l: bool = False,
    w: bool = False,
    c: bool = False,
    m: bool = False,
    L: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths)
        p = paths[0]
        data = await linear_read(accessor, p, index)
    else:
        data = await _read_stdin_async(stdin)
        if data is None:
            raise ValueError("wc: missing operand")
    text = data.decode(errors="replace")
    line_count = text.count("\n")
    word_count = len(text.split())
    byte_count = len(data)
    if L:
        max_len = max((len(ln) for ln in text.splitlines()), default=0)
        return str(max_len).encode(), IOResult()
    if args_l:
        return str(line_count).encode(), IOResult()
    if w:
        return str(word_count).encode(), IOResult()
    if m:
        return str(len(text)).encode(), IOResult()
    if c:
        return str(byte_count).encode(), IOResult()
    return f"{line_count}\t{word_count}\t{byte_count}".encode(), IOResult()
