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

from mirage.cache.context import (active_cache_manager,
                                  invalidate_after_unlink,
                                  invalidate_after_write, push_cache_manager)


def _run(coro):
    return asyncio.run(coro)


class FakeManager:

    def __init__(self) -> None:
        self.writes: list[str] = []
        self.unlinks: list[str] = []

    async def invalidate_after_write(self, path: str) -> None:
        self.writes.append(path)

    async def invalidate_after_unlink(self, path: str) -> None:
        self.unlinks.append(path)


async def _delegates() -> FakeManager:
    manager = FakeManager()
    prev = push_cache_manager(manager)
    await invalidate_after_write("/a.txt")
    await invalidate_after_unlink("/b.txt")
    push_cache_manager(prev)
    return manager


def test_delegates_to_active_manager():
    manager = _run(_delegates())
    assert manager.writes == ["/a.txt"]
    assert manager.unlinks == ["/b.txt"]


async def _noop_without_manager() -> None:
    push_cache_manager(None)
    await invalidate_after_write("/a.txt")
    await invalidate_after_unlink("/b.txt")


def test_noop_without_active_manager():
    _run(_noop_without_manager())


async def _push_restores() -> tuple[object, object, object]:
    first = FakeManager()
    second = FakeManager()
    prev0 = push_cache_manager(first)
    prev1 = push_cache_manager(second)
    active = active_cache_manager()
    push_cache_manager(prev1)
    restored = active_cache_manager()
    push_cache_manager(prev0)
    return prev1, active, restored


def test_push_returns_previous_manager():
    prev1, active, restored = _run(_push_restores())
    assert prev1 is not None
    assert active is not restored
    assert restored is prev1
