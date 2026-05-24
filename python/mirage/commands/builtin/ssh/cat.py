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

from mirage.accessor.ssh import SSHAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.ssh._provision import file_read_provision
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.ssh.glob import resolve_glob
from mirage.core.ssh.stat import stat
from mirage.core.ssh.stream import read_stream
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _number_lines_stream(
        source: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    num = 1
    async for line in AsyncLineIterator(source):
        yield f"     {num}\t".encode() + line + b"\n"
        num += 1


@command("cat",
         resource="ssh",
         spec=SPECS["cat"],
         provision=file_read_provision)
async def cat(
    accessor: SSHAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths, index)
        await stat(accessor, paths[0], index)
        source = read_stream(accessor, paths[0])
        cachable = CachableAsyncIterator(source)
        io = IOResult(reads={paths[0].strip_prefix: cachable},
                      cache=[paths[0].strip_prefix])
        if n:
            return _number_lines_stream(cachable), io
        return cachable, io
    source = _resolve_source(stdin, "cat: missing operand")
    if n:
        return _number_lines_stream(source), IOResult()
    return source, IOResult()
