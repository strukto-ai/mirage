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
import asyncio
import time

YIELD_INTERVAL = 0.002


class YieldBudget:
    """A per-consumer time budget; small reads do not schedule a timer.

    Each await of another task on the loop waits for a yield, and a line
    run in another session of the workspace takes several, so the
    interval bounds how long a busy command holds it back per step. A
    yield costs microseconds here; the TypeScript twin keeps a longer
    interval, as its yield waits a whole timer turn and its awaits settle
    as microtasks within one.
    """

    def __init__(self) -> None:
        self._next_yield = time.monotonic() + YIELD_INTERVAL

    async def run(self) -> None:
        if time.monotonic() < self._next_yield:
            return
        # A positive delay lets due timers run before this task resumes.
        await asyncio.sleep(0.000001)
        self._next_yield = time.monotonic() + YIELD_INTERVAL
