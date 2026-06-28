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
from mirage.commands.builtin.generic.join import join_cmd as generic_join
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          with_index)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def join(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    t: str | None = None,
    a: str | None = None,
    v: str | None = None,
    e: str | None = None,
    o: str | None = None,
    index: IndexCacheStore | None = None,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor) or len(paths) < 2:
        raise ValueError("join: requires two paths")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_join(paths,
                              read_bytes=with_index(ops.read_bytes, index),
                              accessor=accessor,
                              field1=int(kwargs.get("args_1", 1)) - 1,
                              field2=int(kwargs.get("2", 1)) - 1,
                              separator=t,
                              also_unpairable=a,
                              only_unpairable=v,
                              empty_value=e,
                              output_format=o)


BUILDER = Builder('join', join, None, False, None, read=True)
