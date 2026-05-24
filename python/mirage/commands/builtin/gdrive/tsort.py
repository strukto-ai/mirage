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
from functools import partial

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.tsort import tsort as generic_tsort
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.gdrive.glob import resolve_glob
from mirage.core.gdrive.read import read as read_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("tsort", resource="gdrive", spec=SPECS["tsort"])
async def tsort(
    accessor: GDriveAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths, index)
    else:
        paths = []
    return await generic_tsort(paths,
                               read_bytes=partial(read_bytes, index=index),
                               accessor=accessor,
                               stdin=stdin)
