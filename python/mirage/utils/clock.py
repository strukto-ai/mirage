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
import re
import time
from collections.abc import Awaitable
from contextvars import ContextVar
from datetime import datetime, timezone, tzinfo
from typing import Protocol, TypeVar

T = TypeVar("T")


class Clock(Protocol):
    """Wall timestamps and monotonic durations, both in seconds."""

    def now(self) -> float:
        """Seconds since the unix epoch (``time.time``)."""
        ...

    def monotonic(self) -> float:
        """Seconds from an arbitrary origin that never moves backwards."""
        ...

    async def sleep(self, seconds: float) -> None:
        """Wait ``seconds`` on this clock.

        Args:
            seconds (float): how long to wait; zero or less returns at
                once.
        """
        ...


class SystemClock:
    """Platform clock used when no clock is supplied."""

    def now(self) -> float:
        """Seconds since the unix epoch."""
        return time.time()

    def monotonic(self) -> float:
        """Seconds from an arbitrary origin that never moves backwards."""
        return time.monotonic()

    async def sleep(self, seconds: float) -> None:
        """Wait ``seconds`` of real time.

        Args:
            seconds (float): how long to wait; zero or less returns at
                once.
        """
        await asyncio.sleep(seconds)

    def __repr__(self) -> str:
        return "SystemClock()"


class ManualClock:
    """Clock advanced explicitly by the caller. Readings have no side effects.

    A sleep advances the clock by its length and returns without waiting,
    so a wait costs no real time. Waits do not overlap: two tasks that
    each sleep 30 seconds advance it by 60.

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

    async def sleep(self, seconds: float) -> None:
        """Advance by ``seconds`` and yield once to the loop.

        Args:
            seconds (float): how long the wait lasts on this clock; zero,
                a negative or NaN advances nothing.
        """
        if seconds > 0:
            self.advance(seconds)
        await asyncio.sleep(0)

    def __repr__(self) -> str:
        return (
            f"ManualClock(now={self._wall!r}, monotonic={self._monotonic!r})"
        )


def is_system_clock(clock: Clock) -> bool:
    """Whether ``clock`` reads the platform clock, so any two such agree.

    Args:
        clock (Clock): the clock to ask about.
    """
    return isinstance(clock, SystemClock)


class ShiftedClock:
    """``base`` shifted by a fixed offset: it starts at the instant it is
    built for and ticks at ``base``'s rate, as a workspace's
    ``system_time`` does. Monotonic time and waits are ``base``'s.
    Mirrors TypeScript's ``ShiftedClock``.

    Args:
        base (Clock): the clock it ticks with.
        offset (float): seconds added to ``base``'s wall time.
    """

    __slots__ = ("base", "offset")

    def __init__(self, base: Clock, offset: float) -> None:
        self.base = base
        self.offset = offset

    @classmethod
    def starting(cls, base: Clock, start: float) -> "ShiftedClock":
        """``base`` shifted so that it reads ``start`` seconds now.

        Args:
            base (Clock): the clock it ticks with.
            start (float): seconds since the unix epoch it reads now.
        """
        return cls(base, start - base.now())

    def now(self) -> float:
        """Seconds since the unix epoch, shifted."""
        return self.base.now() + self.offset

    def monotonic(self) -> float:
        """``base``'s monotonic seconds."""
        return self.base.monotonic()

    async def sleep(self, seconds: float) -> None:
        """Wait ``seconds`` on ``base``.

        Args:
            seconds (float): how long to wait.
        """
        await self.base.sleep(seconds)

    def __repr__(self) -> str:
        return f"ShiftedClock({self.base!r}, offset={self.offset!r})"


# An ISO 8601 instant with an offset: `2026-03-02T09:00:00Z`, `+08:00`.
_INSTANT = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})"
)


def parse_system_time(text: str) -> float:
    """Seconds since the unix epoch a ``system_time`` names: an ISO 8601
    instant with an offset (``Z`` or ``+08:00``). Mirrors TypeScript's
    ``parseSystemTime``.

    Args:
        text (str): the setting as written.

    Raises:
        ValueError: it is not one.
    """
    if isinstance(text, str) and _INSTANT.fullmatch(text):
        try:
            # Milliseconds kept, as TypeScript's Date keeps them.
            whole, dot, rest = text.partition(".")
            if dot:
                digits = len(rest) - len(rest.lstrip("0123456789"))
                rest = rest[:digits][:3].ljust(3, "0") + rest[digits:]
            moment = datetime.fromisoformat(
                (whole + dot + rest).replace("Z", "+00:00")
            )
            return moment.astimezone(timezone.utc).timestamp()
        except ValueError:
            pass
    raise ValueError(
        f"system_time {text!r} is not an ISO 8601 instant with an offset, "
        "as 2026-03-02T09:00:00Z"
    )


# The system clock of the workspace a line or an op runs in: what `date`,
# file times and the runtimes read. None, or unbound, is the host's time.
_system_clock: ContextVar[Clock | None] = ContextVar(
    "mirage_system_clock", default=None
)


async def run_with_system_clock(clock: Clock | None, call: Awaitable[T]) -> T:
    """``call`` awaited on a workspace's system clock, which
    ``system_now`` reads. Mirrors TypeScript's ``runWithSystemClock``.

    Args:
        clock (Clock | None): the workspace's system clock, None for the
            host's time.
        call (Awaitable[T]): the line or the op.
    """
    token = _system_clock.set(clock)
    try:
        return await call
    finally:
        _system_clock.reset(token)


def bound_system_clock() -> Clock | None:
    """The running workspace's system clock, None for the host's.
    Mirrors TypeScript's ``boundSystemClock``."""
    return _system_clock.get()


def system_now() -> float:
    """Seconds since the unix epoch on the running workspace's system
    clock: what the agent sees as now. Mirrors TypeScript's
    ``systemNow``."""
    clock = _system_clock.get()
    return time.time() if clock is None else clock.now()


def system_date(tz: tzinfo | None = timezone.utc) -> datetime:
    """``system_now`` as an aware ``datetime`` in ``tz``.

    Args:
        tz (tzinfo | None): the zone it is shown in; None for the host's
            local zone, as ``datetime.now()`` is.
    """
    return datetime.fromtimestamp(system_now(), tz)
