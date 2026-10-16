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

import logging

from redis.exceptions import RedisError

from mirage.accessor.redis import RedisAccessor
from mirage.types import CapacityResult, CapacityState

logger = logging.getLogger(__name__)


async def capacity(accessor: RedisAccessor) -> CapacityResult:
    """The server's memory, for df, from ``INFO memory``: its ``maxmemory``
    limit as the total and ``used_memory`` as used, the rest available.

    The numbers are the server's, whatever share of its keys the mount
    holds. A server with no limit set (``maxmemory`` 0) grows until its
    host stops it, ELASTIC; one that does not answer INFO (the command
    renamed away or refused) is UNKNOWN.

    Args:
        accessor (RedisAccessor): the mount's store.
    """
    try:
        info = await accessor.store.info_memory()
    except RedisError as exc:
        logger.debug("redis INFO memory unanswered: %s", exc)
        return CapacityResult(state=CapacityState.UNKNOWN)
    used = info.get("used_memory")
    limit = info.get("maxmemory")
    if not isinstance(used, int) or not isinstance(limit, int):
        return CapacityResult(state=CapacityState.UNKNOWN)
    if limit == 0:
        return CapacityResult(state=CapacityState.ELASTIC)
    return CapacityResult(
        state=CapacityState.QUOTA,
        total=limit,
        used=used,
        available=max(limit - used, 0),
    )
