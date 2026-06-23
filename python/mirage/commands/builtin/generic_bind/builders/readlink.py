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
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.readlink import \
    readlink as generic_readlink
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def readlink(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    f: bool = False,
    e: bool = False,
    m: bool = False,
    n: bool = False,
    index: IndexCacheStore | None = None,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("readlink: missing operand")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_readlink(paths, f=f, e=e, m=m, n=n)


# (name, builder, provision_builder, write, aggregate)
BUILDER = ('readlink', readlink, None, False, None)
