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
"""How late a deployed server's event loop ran over an access run.

``serve.py`` runs a ``LoopLag`` on the server's loop when
``ACCESS_LOOP_LAG`` names a file and writes its summary there as the
server stops, for ``run.py`` to report; the server itself neither keeps
nor serves it. ``loop_lag.ts`` is the TypeScript twin.
"""

import asyncio
import gc
import math
import time

LOOP_LAG_ENV = "ACCESS_LOOP_LAG"
INTERVAL_MS = 20
STALL_MS = 50


def percentile(ordered: list[float], fraction: float) -> float:
    """The nearest-rank percentile of sorted samples, 0 when there are none.

    Args:
        ordered (list[float]): the samples, ascending.
        fraction (float): the rank, from 0 to 1.
    """
    if not ordered:
        return 0.0
    rank = math.ceil(len(ordered) * fraction)
    return ordered[min(len(ordered), max(1, rank)) - 1]


class LoopLag:
    """How late the loop runs a timer, and how long collections took.

    A timer due every ``INTERVAL_MS`` records how far past its due time
    it ran: time the loop spent on anything else, such as a callback that
    never awaits, the GIL held by another thread or a collection. Lag is
    read off the monotonic clock, not the loop's: uvloop's caches whole
    milliseconds per iteration.
    """

    def __init__(self) -> None:
        self._lags: list[float] = []
        self._gc_ms = 0.0
        self._collecting = 0.0
        self._timer: asyncio.TimerHandle | None = None
        self._due = 0.0

    def start(self) -> None:
        """Sample the running loop and time every collection."""
        gc.callbacks.append(self._collected)
        self._arm(asyncio.get_running_loop())

    def stop(self) -> dict[str, float]:
        """Stop sampling and summarize the run.

        Returns:
            dict[str, float]: the sample count, the median, 99th percentile
            and worst lag, the lags of ``STALL_MS`` or more, and the
            milliseconds spent collecting.
        """
        if self._timer is not None:
            self._timer.cancel()
        gc.callbacks.remove(self._collected)
        lags = sorted(self._lags)
        return {
            "samples": len(lags),
            "p50_ms": round(percentile(lags, 0.5), 1),
            "p99_ms": round(percentile(lags, 0.99), 1),
            "max_ms": round(lags[-1] if lags else 0.0, 1),
            "stalls": sum(1 for lag in lags if lag >= STALL_MS),
            "gc_ms": round(self._gc_ms, 1),
        }

    def _arm(self, loop: asyncio.AbstractEventLoop) -> None:
        self._due = time.monotonic() + INTERVAL_MS / 1000
        self._timer = loop.call_later(INTERVAL_MS / 1000, self._tick, loop)

    def _tick(self, loop: asyncio.AbstractEventLoop) -> None:
        self._lags.append(max(0.0, (time.monotonic() - self._due) * 1000))
        self._arm(loop)

    def _collected(self, phase: str, info: dict[str, int]) -> None:
        if phase == "start":
            self._collecting = time.monotonic()
            return
        self._gc_ms += (time.monotonic() - self._collecting) * 1000
