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

from mirage.commands.builtin.utils.safeguard import CommandTimeoutError

PIPELINE = "pipeline"


class JobBudget:
    """A monotonic wall-clock budget for one top-level command line.

    Created once per pipeline; ``remaining()`` returns the seconds left
    against a single deadline so that any stage finishing or timing out
    tears down the whole chain. A non-positive or None total means the
    budget is off and never bounds anything.

    Args:
        total (float | None): total seconds for the line, or None/<=0
            to disable.
    """

    def __init__(self, total: float | None) -> None:
        self.total = total
        self._start = time.monotonic()

    def remaining(self) -> float | None:
        if not self.total or self.total <= 0:
            return None
        return max(0.0, self.total - (time.monotonic() - self._start))

    async def run(self, coro):
        """Await ``coro`` under the remaining budget.

        Returns the coroutine result when the budget is off or the work
        finishes in time; raises CommandTimeoutError otherwise.

        Args:
            coro: the awaitable to bound (typically the final pipeline
                materialize).
        """
        left = self.remaining()
        if left is None:
            return await coro
        if left <= 0:
            coro.close()
            raise CommandTimeoutError(PIPELINE, self.total)
        try:
            return await asyncio.wait_for(coro, timeout=left)
        except asyncio.TimeoutError as exc:
            raise CommandTimeoutError(PIPELINE, self.total) from exc
