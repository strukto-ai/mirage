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
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.filetype.orc import wc as orc_wc
from mirage.core.redis.glob import resolve_glob
from mirage.core.redis.read import read_bytes as _read_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("wc", resource="redis", spec=SPECS["wc"], filetype=".orc")
async def wc_orc(
    accessor: RedisAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    args_l: bool = False,
    w: bool = False,
    c: bool = False,
    m: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if accessor.store is None or not paths:
        raise ValueError("wc: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    if w or c or m:
        return None, IOResult(
            exit_code=1,
            stderr=b"wc: -w/-c/-m not supported for orc files",
        )
    try:
        raw = await _read_bytes(accessor, paths[0])
        row_count = orc_wc(raw)
        return str(row_count).encode(), IOResult(
            reads={paths[0].strip_prefix: raw}, cache=[paths[0].strip_prefix])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"wc: {paths[0].original}: failed to read as orc: {e}".
            encode(),
        )
