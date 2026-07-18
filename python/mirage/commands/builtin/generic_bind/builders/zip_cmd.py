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
from mirage.commands.builtin.generic.zip_cmd import zip_cmd as generic_zip
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation,
                                                          with_index)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def zip_cmd(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    r: bool = False,
    j: bool = False,
    q: bool = False,
    index: IndexCacheStore | None = None,
    **flags,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor) or len(paths) < 2:
        raise ValueError("zip: usage: zip archive.zip file1 [file2 ...]")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_zip(paths,
                             read_bytes=with_index(ops.read_bytes, index),
                             write_bytes=ops.require(Operation.WRITE),
                             accessor=accessor,
                             r=r,
                             j=j,
                             q=q)


BUILDER = Builder('zip',
                  zip_cmd,
                  write=True,
                  requirements=frozenset({Operation.WRITE}))
