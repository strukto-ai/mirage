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

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.shuf import shuf as generic_shuf
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def shuf(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    n: str | None = None,
    e: bool = False,
    z: bool = False,
    r: bool = False,
    index: IndexCacheStore = NULL_INDEX,
    **flags,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await ops.resolve_glob(accessor, paths, index)
    elif not ops.is_mounted(accessor):
        paths = []
    return await generic_shuf(paths,
                              texts,
                              read_bytes=bound_op(ops.read_bytes, accessor,
                                                  index),
                              stdin=stdin,
                              count=int(n) if n is not None else None,
                              echo=e,
                              zero_terminated=z,
                              with_replacement=r)


BUILDER = Builder('shuf', shuf, None, False, None, read=True)
