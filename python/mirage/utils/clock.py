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
    """Wall timestamps and monotonic durations, both in seconds."""

    def now(self) -> float:
        """Seconds since the unix epoch (``time.time``)."""
        ...

    def monotonic(self) -> float:
        """Seconds from an arbitrary origin that never moves backwards."""
        ...


class SystemClock:
    """Platform clock used when no clock is supplied."""

    def now(self) -> float:
        """Seconds since the unix epoch."""
        return time.time()

    def monotonic(self) -> float:
        """Seconds from an arbitrary origin that never moves backwards."""
        return time.monotonic()

    def __repr__(self) -> str:
        return "SystemClock()"


class ManualClock:
    """Clock advanced explicitly by the caller. Readings have no side effects.

    Args:
        start (float): initial wall time in seconds; monotonic starts at zero.
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
