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
from mirage.commands.builtin.generic.cmp import cmp_cmd as generic_cmp
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def cmp_cmd(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    s: bool = False,
    args_l: bool = False,
    n: str | None = None,
    b: bool = False,
    i: str | None = None,
    index: IndexCacheStore = NULL_INDEX,
    **flags,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor) or len(paths) < 2:
        raise ValueError('cmp: requires two paths')
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_cmp(paths,
                             read_bytes=bound_op(ops.read_bytes, accessor,
                                                 index),
                             silent=s,
                             verbose=args_l,
                             limit=int(n) if n is not None else None,
                             print_bytes=b,
                             skip=int(i) if i is not None else None)


BUILDER = Builder('cmp', cmp_cmd, None, False, None, read=True)
