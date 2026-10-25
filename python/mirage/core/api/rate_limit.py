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

from mirage.utils.clock import Clock, SystemClock


class RateLimiter:
    """Spaces calls that share a key to at most ``rate`` per second.

    For an API that meters requests per second per resource and answers a
    burst with a penalty window rather than a queue (Airtable allows 5 per
    base, then refuses everything for 30 seconds), spacing the calls up
    front is cheaper than any retry. Each call reserves the next free slot
    for its key before it awaits anything, so concurrent callers queue in
    arrival order and the event loop needs no lock. A caller the loop
    wakes late moves every slot behind it back by as much, so a stall
    cannot release the callers queued behind it in one burst. Slots hold
    monotonic seconds, not loop handles, so one limiter serves every loop
    in the process.

    Args:
        rate (float): calls per second allowed per key.
        clock (Clock | None): what slots are read and waited on; None is
            the system clock until `bind_clock` names the workspace's.
    """

    def __init__(self, rate: float, *, clock: Clock | None = None) -> None:
        if not rate > 0:
            raise ValueError(f"rate must be positive, got {rate!r}")
        self._interval = 1.0 / rate
        self._clock: Clock = clock if clock is not None else SystemClock()
        self._next: dict[str, float] = {}
        self._shift: dict[str, float] = {}
        self._schedule = 0

    def bind_clock(self, clock: Clock) -> None:
        """Read and wait on the workspace's clock from now on.

        Slots taken on another clock mean nothing on this one, so they
        are dropped; binding the clock already in use keeps them, so a
        second mount of one accessor cannot release a burst.

        Args:
            clock (Clock): the workspace's clock.
        """
        if clock is self._clock:
            return
        self._clock = clock
        self._schedule += 1
        self._next.clear()
        self._shift.clear()

    async def acquire(self, key: str) -> None:
        """Wait for this key's next slot.

        A caller waits out its slot on the clock it took it on. If the
        limiter is bound to another clock meanwhile, even one it then
        returns to, its slot means nothing on the new schedule, so it
        leaves that schedule alone.

        Args:
            key (str): what the server meters by (an Airtable base id).
        """
        clock = self._clock
        schedule = self._schedule
        now = clock.monotonic()
        slot = max(now, self._next.get(key, now))
        self._next[key] = slot + self._interval
        if slot <= now:
            return
        seen = self._shift.get(key, 0.0)
        await clock.sleep(slot - now)
        while (
            self._schedule == schedule
            and (moved := self._shift.get(key, 0.0)) != seen
        ):
            slot += moved - seen
            seen = moved
            now = clock.monotonic()
            if slot > now:
                await clock.sleep(slot - now)
        if self._schedule != schedule:
            return
        late = clock.monotonic() - slot
        if late > 0:
            self._shift[key] = seen + late
            self._next[key] += late
