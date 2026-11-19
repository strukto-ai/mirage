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

from collections import deque
from collections.abc import Callable, Mapping
from contextvars import ContextVar

from mirage.utils.clock import Clock

# The machine whose served mount makes the file ops running now, None for
# any other caller: that machine's kernel already holds what its own
# requests changed.
SERVED_BY: ContextVar[str | None] = ContextVar("served_by", default=None)


def _overlaps(path: str, prefix: str) -> bool:
    """Whether a change at ``path`` reaches what is under ``prefix``: it
    is the prefix, under it, or above it.

    Args:
        path (str): the changed path.
        prefix (str): the served prefix.
    """
    a, b = path.rstrip("/"), prefix.rstrip("/")
    return a == b or b.startswith(a + "/") or a.startswith(b + "/")


class RecentChanges:
    """The file changes of the last ``window`` seconds, each with the
    machine whose served mount made it, so a machine whose kernel keeps
    what its mounts answered that long starts a program only once nothing
    another made there may still be held.

    Args:
        clock (Clock): the workspace's clock.
        window (float): how long a machine's kernel keeps an answer.
    """

    def __init__(self, clock: Clock, window: float) -> None:
        self._clock = clock
        self._window = window
        self._changes: deque[tuple[float, str | None, str]] = deque()
        self._watchers: set[Callable[[str, str | None], None]] = set()

    def note(self, path: str) -> None:
        """Record a change at ``path``, made by ``SERVED_BY``'s machine.

        Args:
            path (str): the virtual path changed; ``/`` for every mount.
        """
        now = self._clock.monotonic()
        self._forget(now)
        by = SERVED_BY.get()
        self._changes.append((now, by, path))
        for watcher in list(self._watchers):
            watcher(path, by)

    def watch(
        self, listener: Callable[[str, str | None], None]
    ) -> Callable[[], None]:
        """Hear each change as it is noted, with the machine whose served
        mount made it, so a machine that keeps answers longer than the
        window learns of every change at once.

        Args:
            listener (Callable[[str, str | None], None]): told each
                change's path and machine.

        Returns:
            Callable[[], None]: the call that stops hearing.
        """
        self._watchers.add(listener)

        def stop() -> None:
            self._watchers.discard(listener)

        return stop

    def now(self) -> float:
        """The workspace clock's monotonic reading, which ``wait_out``
        compares the start of a mount's caching with."""
        return self._clock.monotonic()

    async def wait_out(
        self, served: Mapping[str, float], machine: str
    ) -> None:
        """Wait until no change another made under a served prefix since
        its mount began keeping answers is younger than the window, so
        ``machine``'s kernel holds none.

        Args:
            served (Mapping[str, float]): each prefix served into the
                machine, with when its mount began (``now``).
            machine (str): the machine, whose own changes do not count.
        """
        now = self._clock.monotonic()
        self._forget(now)
        last = max(
            (
                at
                for at, by, path in self._changes
                if by != machine
                and any(
                    at >= since and _overlaps(path, prefix)
                    for prefix, since in served.items()
                )
            ),
            default=None,
        )
        if last is not None:
            await self._clock.sleep(last + self._window - now)

    def _forget(self, now: float) -> None:
        while self._changes and self._changes[0][0] <= now - self._window:
            self._changes.popleft()
