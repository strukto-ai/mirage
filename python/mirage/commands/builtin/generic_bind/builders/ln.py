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

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic_bind.adapter import Builder, CommandIO
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def ln(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    s: bool = False,
    f: bool = False,
    n: bool = False,
    v: bool = False,
    index: IndexCacheStore | None = None,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor) or len(paths) < 2:
        raise ValueError("ln: usage: ln [-s] [-f] source dest")
    paths = await ops.resolve_glob(accessor, paths, index)
    source_path = paths[0]
    dest_path = paths[1]
    if n and await ops.exists(accessor, dest_path):
        return None, IOResult()
    data = await ops.read_bytes(accessor, source_path)
    await ops.write(accessor, dest_path, data)
    output = f"'{source_path.original}' -> '{dest_path.original}'\n".encode(
    ) if v else None
    return output, IOResult(writes={dest_path.strip_prefix: data})


BUILDER = Builder('ln', ln, None, True, None, ('write', ))
