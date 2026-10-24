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
import sys
import time

YIELD_SWITCHES = 2


class YieldBudget:
    """A per-consumer time budget; small reads do not schedule a timer.

    A busy consumer yields every ``YIELD_SWITCHES`` GIL switch intervals
    (10 ms under Python's default 5 ms, 2 ms under the daemon's 1 ms).
    Each yield runs the loop's selector, which lets go of the GIL and
    takes it straight back, and a thread waiting on the GIL forces a
    switch only after a whole switch interval with no release: a loop
    that yields more often keeps every other thread (the server's HTTP
    loop, other workspaces) from the GIL. A line in another session of
    the workspace waits a few yields, so a shorter switch interval is
    what makes it answer sooner. The TypeScript twin has no GIL and
    keeps a fixed interval.
    """

    def __init__(self) -> None:
        self._interval = YIELD_SWITCHES * sys.getswitchinterval()
        self._next_yield = time.monotonic() + self._interval

    async def run(self) -> None:
        if time.monotonic() < self._next_yield:
            return
        # A positive delay lets due timers run before this task resumes.
        await asyncio.sleep(0.000001)
        self._next_yield = time.monotonic() + self._interval
