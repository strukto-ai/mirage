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

from mirage.accessor.redis import RedisAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.cmp import cmp_cmd as generic_cmp
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.redis.glob import resolve_glob
from mirage.core.redis.read import read_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("cmp", resource="redis", spec=SPECS["cmp"])
async def cmp_cmd(
    accessor: RedisAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    s: bool = False,
    args_l: bool = False,
    n: str | None = None,
    b: bool = False,
    i: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if accessor.store is None or len(paths) < 2:
        raise ValueError("cmp: requires two paths")
    paths = await resolve_glob(accessor, paths, index)
    return await generic_cmp(paths,
                             read_bytes=read_bytes,
                             accessor=accessor,
                             silent=s,
                             verbose=args_l,
                             limit=int(n) if n is not None else None,
                             print_bytes=b,
                             skip=int(i) if i is not None else None)
