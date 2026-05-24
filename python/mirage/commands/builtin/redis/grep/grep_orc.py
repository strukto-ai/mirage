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
from mirage.core.filetype.orc import grep as orc_grep
from mirage.core.redis.glob import resolve_glob
from mirage.core.redis.read import read_bytes as _read_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("grep", resource="redis", spec=SPECS["grep"], filetype=".orc")
async def grep_orc(
    accessor: RedisAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    r: bool = False,
    R: bool = False,
    i: bool = False,
    v: bool = False,
    n: bool = False,
    c: bool = False,
    args_l: bool = False,
    w: bool = False,
    F: bool = False,
    E: bool = False,
    o: bool = False,
    m: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if accessor.store is None or not paths or not texts:
        raise ValueError("grep: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    try:
        pattern = texts[0]
        raw = await _read_bytes(accessor, paths[0])
        result = orc_grep(raw, pattern, ignore_case=i)
        if c:
            count = len(result.decode().strip().splitlines()) - 1
            return str(max(0, count)).encode(), IOResult(
                reads={paths[0].strip_prefix: raw},
                cache=[paths[0].strip_prefix])
        return result, IOResult(reads={paths[0].strip_prefix: raw},
                                cache=[paths[0].strip_prefix])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"grep: {paths[0].original}: failed to read as orc: {e}".
            encode(),
        )
