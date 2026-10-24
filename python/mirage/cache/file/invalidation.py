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

from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from typing import TypeAlias

from mirage.utils.key_prefix import under_path

Stamp: TypeAlias = tuple[int, int]


class Invalidation:
    """The invalidations a cache writer checks before it installs.

    A writer holds bytes it read earlier; an invalidation that lands
    between the read and the install makes them stale even though the
    writer was granted its turn after it. The writer takes a stamp before
    it waits and compares it before it installs.

    The RAM store holds a per-key lock only for its in-memory install,
    never across hashing or backend I/O. A free lock admits its writer
    without suspending on both hosts; a queued writer checks its stamp
    after acquiring the lock. Redis holds no client-side key lock: it
    sends atomic writes to the server and checks after acquiring its
    client (an await on TypeScript, synchronous on Python). The guard
    tracks local invalidations, not writes by other Redis clients.

    Two counters, because invalidations have different reaches. The
    store-wide epoch answers ``clear``. The per-key counter answers a
    removal of one key and a prefix eviction, so a large fill is not
    thrown away because an unrelated key or folder was dropped. A prefix
    eviction can name its victims although a fill in flight has no entry
    yet: every writer registers here in ``enter`` before it waits. Per-key
    counters exist only while a writer for that key is in flight, which
    bounds the map by concurrent writers, not by every key ever removed.
    """

    def __init__(self) -> None:
        self._epoch = 0
        self._keys: dict[str, int] = {}
        self._writers: dict[str, int] = {}

    def enter(self, key: str) -> Stamp:
        """Register a writer for ``key`` and take its stamp.

        Args:
            key (str): the key the writer will install.
        """
        self._writers[key] = self._writers.get(key, 0) + 1
        return (self._epoch, self._keys.get(key, 0))

    def leave(self, key: str) -> None:
        """Unregister a writer for ``key``; the last one out drops the
        key's counter.

        Args:
            key (str): the key the writer installed or gave up on.
        """
        # Tolerant, as the TypeScript twin is: this runs in a finally,
        # where a raise would replace the error that is unwinding.
        left = self._writers.get(key, 1) - 1
        if left:
            self._writers[key] = left
        else:
            del self._writers[key]
            self._keys.pop(key, None)

    def stale(self, key: str, stamp: Stamp) -> bool:
        """Whether an invalidation reached ``key`` since ``stamp``.

        Args:
            key (str): the key the writer is about to install.
            stamp (Stamp): what ``enter`` returned to this writer.
        """
        return stamp != (self._epoch, self._keys.get(key, 0))

    def invalidate(self, key: str) -> None:
        """Record a removal of ``key`` for the writers in flight on it.

        Args:
            key (str): the key removed.
        """
        if key in self._writers:
            self._keys[key] = self._keys.get(key, 0) + 1

    def invalidate_prefix(
        self, prefix: str, excluded: tuple[str, ...] = ()
    ) -> None:
        """Record a prefix eviction for the writers in flight under it.

        Args:
            prefix (str): the evicted key prefix, matched as the stores
                match it (``startswith``).
            excluded (tuple[str, ...]): roots whose writers it spares.
        """
        for key in self._writers:
            if key.startswith(prefix) and not any(
                under_path(key, root) for root in excluded
            ):
                self._keys[key] = self._keys.get(key, 0) + 1

    def invalidate_all(self) -> None:
        """Record an invalidation whose victims cannot be enumerated."""
        self._epoch += 1


@contextmanager
def with_fill_guard(
    invalidation: Invalidation, keys: Iterable[str]
) -> Iterator[Callable[[str], bool]]:
    """Track a fill's keys until it completes, fails or is cancelled.

    Enter before any lock/client wait, then call the yielded predicate
    immediately before each install or retry. Unknown keys are not live.

    Args:
        invalidation (Invalidation): the store's local invalidations.
        keys (Iterable[str]): keys the fill may install; duplicates count once.
    """
    stamps = {key: invalidation.enter(key) for key in dict.fromkeys(keys)}

    def is_live(key: str) -> bool:
        return key in stamps and not invalidation.stale(key, stamps[key])

    try:
        yield is_live
    finally:
        for key in stamps:
            invalidation.leave(key)
