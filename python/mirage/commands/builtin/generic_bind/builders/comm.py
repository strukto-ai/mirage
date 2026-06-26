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
from mirage.commands.builtin.generic.comm import comm as generic_comm
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          with_index)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def comm(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    check_order: bool = False,
    index: IndexCacheStore | None = None,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor) or len(paths) < 2:
        raise ValueError("comm: requires two paths")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_comm(
        paths,
        read_bytes=with_index(ops.read_bytes, index),
        accessor=accessor,
        suppress1=bool(kwargs.get("args_1", False)),
        suppress2=bool(kwargs.get("2", False)),
        suppress3=bool(kwargs.get("3", False)),
        check_order=check_order,
    )


BUILDER = Builder('comm', comm, None, False, None)
