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

from mirage.accessor.disk import DiskAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.stat import stat as generic_stat
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.disk.glob import resolve_glob
from mirage.core.disk.stat import stat as local_stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("stat", resource="disk", spec=SPECS["stat"])
async def stat(
    accessor: DiskAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    c: str | None = None,
    f: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if accessor.root is None:
        raise ValueError("stat: no resource")
    paths = await resolve_glob(accessor, paths, index)
    return await generic_stat(paths,
                              stat_fn=local_stat,
                              accessor=accessor,
                              c=c,
                              f=f)
