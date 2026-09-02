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

import time
from typing import Protocol


class Clock(Protocol):
    """The one door mirage reads time through.

    Two readings, because a deadline and a stamp are different
    questions. ``monotonic`` measures a duration or a TTL and never
    moves backwards, which wall clock cannot promise, since NTP can
    step it mid-measurement. ``now`` answers what time it is, which is
    the only thing a stored timestamp can mean.

    Implemented by :class:`SystemClock` in production and
    :class:`ManualClock` under a test or an embedding harness. It is a
    ``Protocol``, so an embedder's own class satisfies it by shape and
    needs no import of mirage.
    """

    def now(self) -> float:
        """Seconds since the unix epoch (``time.time``)."""
        ...

    def monotonic(self) -> float:
        """Seconds from an arbitrary origin that never moves backwards."""
        ...


class SystemClock:
    """The real clock: both readings delegate to the stdlib.

    The default everywhere, so production behavior is exactly what it
    was before the seam existed. Stateless, so constructing one per
    holder costs nothing and there is no shared instance for code to
    reach ambiently.
    """

    def now(self) -> float:
        """Seconds since the unix epoch."""
        return time.time()

    def monotonic(self) -> float:
        """Seconds from an arbitrary origin that never moves backwards."""
        return time.monotonic()

    def __repr__(self) -> str:
        return "SystemClock()"


class ManualClock:
    """A clock that stands still until the caller moves it.

    Reading it has no side effect, so a test can probe a TTL at
    ``ttl - 1`` and again at ``ttl`` and get exactly those two answers.
    ``advance`` is the only thing that moves time, which is what makes
    a boundary assertion mean what it says.

    An earlier draft ticked the clock on every read, copying
    ``integ/server/kit/typescript/clock.ts``. That was the wrong model
    to copy: the kit's clock is a timestamp generator that hands each
    file a distinct mtime, not a clock a duration is measured with, and
    a read that moves time makes every deadline depend on how many
    times the code under test happened to look. A test that needs two
    events ordered advances between them and says so.

    Wall and monotonic are held separately, because they answer
    different questions and a caller may only ever compare like with
    like. ``advance`` moves both, since virtual time passing is one
    event.

    Args:
        start (float): the wall-clock reading, in seconds. 0 keeps a
            run reproducible; pass ``time.time()`` for a
            wall-clock-relative one.
    """

    __slots__ = ("_monotonic", "_wall")

    def __init__(self, start: float = 0.0) -> None:
        self._wall = start
        self._monotonic = 0.0

    def now(self) -> float:
        """Seconds on the virtual wall clock."""
        return self._wall

    def monotonic(self) -> float:
        """Seconds on the virtual monotonic clock."""
        return self._monotonic

    def advance(self, seconds: float) -> None:
        """Move the clock forward by ``seconds``.

        Args:
            seconds (float): how far forward to move; must not be
                negative, since a monotonic reading may not go back.
        """
        if seconds < 0:
            raise ValueError("cannot advance a clock backwards")
        self._wall += seconds
        self._monotonic += seconds

    def __repr__(self) -> str:
        return (f"ManualClock(now={self._wall!r}, "
                f"monotonic={self._monotonic!r})")
