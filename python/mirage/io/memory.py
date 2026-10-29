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

from collections.abc import Awaitable
from contextvars import ContextVar
from typing import TypeVar

from mirage.io.errors import MemoryExhausted

T = TypeVar("T")

# The running line's `max_memory`, None outside a line or once lifted.
_limit: ContextVar[int | None] = ContextVar(
    "mirage_memory_limit", default=None
)


async def run_with_memory_limit(limit: int | None, call: Awaitable[T]) -> T:
    """``call`` awaited under a line's ``max_memory``, which every
    object it holds is checked against. Mirrors TypeScript's
    ``runWithMemoryLimit``.

    Args:
        limit (int | None): the bytes one object may reach, None for no cap.
        call (Awaitable[T]): the line.
    """
    token = _limit.set(limit)
    try:
        return await call
    finally:
        _limit.reset(token)


def line_memory_limit() -> int | None:
    """The bytes one object the running line holds may reach, None for
    no cap. Mirrors TypeScript's ``lineMemoryLimit``."""
    return _limit.get()


def check_memory(size: int) -> None:
    """Refuse an object that grew to ``size`` bytes past the running
    line's ``max_memory``. Mirrors TypeScript's ``checkMemory``.

    Args:
        size (int): the object's bytes so far.

    Raises:
        MemoryExhausted: the object is past the limit.
    """
    limit = _limit.get()
    if limit is not None and size > limit:
        raise MemoryExhausted()
