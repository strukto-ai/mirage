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
from mirage.commands.builtin.generic.base64_cmd import \
    base64_cmd as generic_base64
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.redis.glob import resolve_glob
from mirage.core.redis.stream import stream as _stream_core
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("base64", resource="redis", spec=SPECS["base64"])
async def base64_cmd(
    accessor: RedisAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    d: bool = False,
    D: bool = False,
    w: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths and accessor.store is not None:
        paths = await resolve_glob(accessor, paths, index)
    else:
        paths = []
    return await generic_base64(paths,
                                read_stream=_stream_core,
                                accessor=accessor,
                                stdin=stdin,
                                decode=d or D,
                                wrap=int(w) if w is not None else None)
