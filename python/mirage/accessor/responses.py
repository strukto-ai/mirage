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
from collections.abc import Awaitable, Callable, Hashable
from typing import Generic, TypeVar

from mirage.types import ReadPolicy, ReadSpec

K = TypeVar("K", bound=Hashable)
V = TypeVar("V")


class ResponseCache(Generic[K, V]):
    """Answers a client keeps of its own service, under its mount's read
    policy.

    A store's search results and a database's names never pass the
    dispatcher's cache stage, so the stage can neither bound nor drop
    them. They are kept here instead, where the mount reaches them:
    ``govern`` keeps an answer no longer than the mount's read policy lets
    it serve one unchecked, which is not at all under ``fresh`` (an answer
    carries no token to check) and within the bound under ``bounded``; and
    the mount clears them with its own caches after a write that went past
    the dispatcher (``Accessor.forget``).

    Args:
        ttl (float | None): seconds an answer is kept, before any mount
            governs it; None keeps it until cleared, 0 keeps nothing.
    """

    def __init__(self, ttl: float | None = None) -> None:
        self._ttl = ttl
        self._answers: dict[K, tuple[float | None, V]] = {}
        self._generation = 0

    def govern(self, read: ReadSpec) -> None:
        """Keep answers no longer than a mount's read policy allows. A
        client mounted at several prefixes keeps the strictest.

        Args:
            read (ReadSpec): the mount's read policy.
        """
        bound = 0 if read.policy is ReadPolicy.FRESH else read.ttl
        self._ttl = bound if self._ttl is None else min(self._ttl, bound)

    async def get(self, key: K, fetch: Callable[[], Awaitable[V]]) -> V:
        """The kept answer for ``key``, else ``fetch``'s, kept.

        Args:
            key (K): the question.
            fetch (Callable[[], Awaitable[V]]): asks the service.
        """
        if self._ttl is not None and self._ttl <= 0:
            return await fetch()
        now = time.monotonic()
        kept = self._answers.get(key)
        if kept is not None and (kept[0] is None or now < kept[0]):
            return kept[1]
        generation = self._generation
        value = await fetch()
        # A clear while the service answered may be for the very write
        # this answer predates, so it is handed back but not kept.
        if generation == self._generation:
            expires = None if self._ttl is None else now + self._ttl
            self._answers[key] = (expires, value)
        return value

    def clear(self) -> None:
        """Drop every kept answer, and any answer still on its way."""
        self._generation += 1
        self._answers.clear()
