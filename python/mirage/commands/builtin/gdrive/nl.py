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
from mirage.commands.builtin.generic.nl import nl as generic_nl
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.gdrive.glob import resolve_glob
from mirage.core.gdrive.stream import read_stream
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("nl", resource="gdrive", spec=SPECS["nl"])
async def nl(
    accessor: GDriveAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    b: str | None = None,
    v: str | None = None,
    i: str | None = None,
    w: str | None = None,
    s: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths, index)
    else:
        paths = []
    return await generic_nl(
        paths,
        read_stream=partial(read_stream, index=index),
        accessor=accessor,
        stdin=stdin,
        body_numbering_raw=b,
        start_raw=v,
        increment_raw=i,
        width_raw=w,
        separator=s,
    )
