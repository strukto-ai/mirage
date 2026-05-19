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
from mirage.commands.builtin.generic.find import find as generic_find
from mirage.commands.builtin.redis._provision import metadata_provision
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.redis.find import find as find_core
from mirage.core.redis.glob import resolve_glob
from mirage.core.redis.stat import stat as stat_core
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("find",
         resource="redis",
         spec=SPECS["find"],
         provision=metadata_provision)
async def find(
    accessor: RedisAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    name: str | None = None,
    type: str | None = None,
    maxdepth: str | None = None,
    size: str | None = None,
    mtime: str | None = None,
    iname: str | None = None,
    path: str | None = None,
    mindepth: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if accessor.store is None:
        raise ValueError("find: no resource")
    paths = await resolve_glob(accessor, paths, index)
    return await generic_find(paths,
                              texts,
                              find_core=partial(find_core, accessor),
                              stat=partial(stat_core, accessor),
                              name=name,
                              type=type,
                              size=size,
                              mtime=mtime,
                              maxdepth=maxdepth,
                              iname=iname,
                              path=path,
                              mindepth=mindepth)
