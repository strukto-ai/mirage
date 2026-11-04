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

from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import TypeVar

from mirage.io.errors import MemoryExhausted

T = TypeVar("T")

# The max_memory a workspace runs under when it names none: with the
# 32 MB read cache, 64 MB a workspace, 32 of them on a 2 GiB machine.
MAX_MEMORY = 32 << 20
MAX_BODY_BYTES = 64 * 1024 * 1024


class MemoryBudget:
    """A workspace's ``max_memory`` and the bytes its stores hold.

    What the workspace stores is counted exactly, by the stores
    themselves, and ``held`` sums it when asked, so nothing is charged
    or released here and the count cannot drift. An object a command
    builds while it runs must fit in what is left (``room``). Mirrors
    the TS ``MemoryBudget``.

    Args:
        limit (int): the workspace's ``max_memory`` in bytes.
        held (Callable[[], int]): the bytes the workspace's stores hold.
    """

    def __init__(self, limit: int, held: Callable[[], int]) -> None:
        self.limit = limit
        self.held = held

    def room(self) -> int:
        """The bytes left under the limit, never below 0."""
        return max(self.limit - self.held(), 0)


# The budget of the workspace a line or an op runs in, None for no cap.
_budget: ContextVar[MemoryBudget | None] = ContextVar(
    "mirage_memory_budget", default=None
)


_body_limit: ContextVar[int] = ContextVar(
    "mirage_body_limit", default=MAX_BODY_BYTES
)


def body_limit() -> int:
    """The workspace per-reply ceiling, or 64 MiB outside a workspace."""
    return _body_limit.get()


async def run_with_memory(
    budget: MemoryBudget | None, call: Awaitable[T], body: int = MAX_BODY_BYTES
) -> T:
    """``call`` awaited under a workspace's memory budget, which what it
    stores and every object it builds are checked against. Mirrors
    TypeScript's ``runWithMemory``.

    Args:
        budget (MemoryBudget | None): the workspace's budget, None for
            no cap.
        call (Awaitable[T]): the line or the op.
        body (int): the workspace per-reply ceiling in decoded bytes.
    """
    token = _budget.set(budget)
    body_token = _body_limit.set(body)
    try:
        return await call
    finally:
        _budget.reset(token)
        _body_limit.reset(body_token)


def memory_room() -> int | None:
    """The bytes left in the running workspace's budget, None for no cap.
    Mirrors TypeScript's ``memoryRoom``."""
    budget = _budget.get()
    return None if budget is None else budget.room()


def check_memory(size: int) -> None:
    """Refuse an object that grew to ``size`` bytes past what the running
    workspace's budget has left. Mirrors TypeScript's ``checkMemory``.

    Args:
        size (int): the object's bytes so far.

    Raises:
        MemoryExhausted: the object does not fit.
    """
    room = memory_room()
    if room is not None and size > room:
        raise MemoryExhausted()
