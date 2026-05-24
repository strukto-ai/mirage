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

from mirage.accessor.redis import RedisAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.du import du as generic_du
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.redis.du import du as du_core
from mirage.core.redis.du import du_all as du_all_core
from mirage.core.redis.glob import resolve_glob
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("du", resource="redis", spec=SPECS["du"])
async def du(
    accessor: RedisAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    h: bool = False,
    s: bool = False,
    a: bool = False,
    max_depth: str | None = None,
    c: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if accessor.store is None:
        raise ValueError("du: no resource")
    paths = await resolve_glob(accessor, paths, index)
    if not paths:
        raise ValueError("du: missing operand")
    out = await generic_du(
        paths,
        compute_total=partial(du_core, accessor),
        compute_all=partial(du_all_core, accessor),
        s=s,
        a=a,
        h=h,
        max_depth=int(max_depth) if max_depth is not None else None,
        c=c,
    )
    return out.encode(), IOResult()
