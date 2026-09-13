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
from collections.abc import AsyncGenerator, AsyncIterator

from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.yield_budget import YieldBudget

CHUNK_SIZE = 16 * 1024


async def chunks(
        source: bytes | AsyncIterator[bytes]) -> AsyncGenerator[bytes, None]:
    """Split even a single RAM/cache blob; close producers on cancellation."""
    budget = YieldBudget()
    if isinstance(source, bytes):
        for offset in range(0, len(source), CHUNK_SIZE):
            await budget.run()
            yield source[offset:offset + CHUNK_SIZE]
        return
    try:
        async for data in source:
            # Once per pull as well as per chunk: a run of empty chunks
            # never enters the inner loop, and a task that never awaits a
            # real suspension point cannot be cancelled.
            await budget.run()
            for offset in range(0, len(data), CHUNK_SIZE):
                await budget.run()
                yield data[offset:offset + CHUNK_SIZE]
    except BaseException as exc:
        if isinstance(source, CachableAsyncIterator) and not isinstance(
                exc, GeneratorExit):
            await source.discard()
        close = getattr(source, "aclose", None)
        if close is not None:
            await close()
        raise
