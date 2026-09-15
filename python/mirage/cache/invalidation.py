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

from typing import TypeAlias

Stamp: TypeAlias = tuple[int, int]


class Invalidation:
    """The invalidations a fingerprinting writer checks before it
    installs.

    A writer reads its bytes, then hashes them, and the hash yields; an
    invalidation that lands in that window makes the bytes stale even
    though the writer was granted its turn after it. The writer takes a
    stamp before it waits and compares it after it hashed.

    Two counters, because invalidations have two reaches. The store-wide
    epoch answers ``clear`` and a prefix eviction, whose victims cannot
    be enumerated (a fill in flight has no entry yet). The per-key
    counter answers a removal of one key, so a large fill for one key is
    not thrown away because an unrelated key was removed. Per-key
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

    def invalidate_all(self) -> None:
        """Record an invalidation whose victims cannot be enumerated."""
        self._epoch += 1
