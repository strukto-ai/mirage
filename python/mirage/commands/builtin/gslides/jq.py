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

from mirage.accessor.gslides import GSlidesAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.jq import jq as generic_jq
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.gslides.glob import resolve_glob
from mirage.core.gslides.read import read as gslides_read
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("jq", resource="gslides", spec=SPECS["jq"])
async def jq(
    accessor: GSlidesAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    r: bool = False,
    c: bool = False,
    s: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths, index)
    else:
        paths = []
    return await generic_jq(
        paths,
        *texts,
        read_bytes=partial(gslides_read, index=index),
        read_stream=partial(stream_from_bytes, gslides_read, index=index),
        accessor=accessor,
        stdin=stdin,
        r=r,
        c=c,
        s=s,
    )
