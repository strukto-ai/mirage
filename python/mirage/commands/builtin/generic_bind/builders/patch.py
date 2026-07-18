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

from functools import partial

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.patch import patch as generic_patch
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation, bound_op)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def patch(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    p: str | None = None,
    R: bool = False,
    i: PathSpec | None = None,
    N: bool = False,
    index: IndexCacheStore = NULL_INDEX,
    **flags,
) -> tuple[ByteSource | None, IOResult]:
    return await generic_patch(paths,
                               read_bytes=bound_op(ops.read_bytes, accessor,
                                                   index),
                               write_bytes=partial(
                                   ops.require(Operation.WRITE), accessor),
                               has_resource=ops.is_mounted(accessor),
                               stdin=stdin,
                               p=p,
                               R=R,
                               i=i,
                               N=N)


BUILDER = Builder('patch',
                  patch,
                  write=True,
                  requirements=frozenset({Operation.WRITE}))
