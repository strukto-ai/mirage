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
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager


class KeyLockMixin:
    """Per-key async locking for RAM-backed cache stores.

    Provides fine-grained locking so operations on different keys
    run concurrently while same-key operations are serialized.

    Only for in-process RAM stores. Redis/SQLite backends handle
    concurrency natively and do not need this mixin.
    """

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._key_locks: dict[str, asyncio.Lock] = {}

    def _lock_for(self, key: str) -> asyncio.Lock:
        if key not in self._key_locks:
            self._key_locks[key] = asyncio.Lock()
        return self._key_locks[key]

    def _discard_lock(self, key: str) -> None:
        self._key_locks.pop(key, None)

    def _clear_locks(self) -> None:
        self._key_locks.clear()


class KeyLock:
    """Per-key async mutual exclusion that keeps nothing for an idle key.

    Callers on one key run one at a time; callers on different keys
    never wait on each other. A key's lock lives only while a caller
    holds or awaits it, so an owner that touches many keys over its
    life keeps no state for the ones it is done with.
    """

    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = {}
        self._users: dict[str, int] = {}

    @asynccontextmanager
    async def with_lock(self, key: str) -> AsyncIterator[None]:
        """Hold `key` for the body of the ``async with``.

        Args:
            key (str): what the callers contend on.
        """
        lock = self._locks.get(key)
        if lock is None:
            lock = self._locks[key] = asyncio.Lock()
        self._users[key] = self._users.get(key, 0) + 1
        try:
            async with lock:
                yield
        finally:
            self._users[key] -= 1
            if self._users[key] == 0:
                del self._users[key]
                del self._locks[key]
