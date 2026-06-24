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
from mirage.commands.builtin.generic.patch import patch as generic_patch
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          with_index)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def patch(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    p: str | None = None,
    R: bool = False,
    i: PathSpec | None = None,
    N: bool = False,
    index: IndexCacheStore | None = None,
    **flags,
) -> tuple[ByteSource | None, IOResult]:
    return await generic_patch(paths,
                               read_bytes=with_index(ops.read_bytes, index),
                               write_bytes=ops.write,
                               has_resource=ops.is_mounted(accessor),
                               accessor=accessor,
                               stdin=stdin,
                               p=p,
                               R=R,
                               i=i,
                               N=N)


BUILDER = Builder('patch', patch, None, True, None)
