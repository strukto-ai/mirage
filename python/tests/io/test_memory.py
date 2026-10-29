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

import pytest

from mirage.io.errors import MemoryExhausted
from mirage.io.memory import (
    MemoryBudget,
    check_memory,
    memory_room,
    run_with_memory,
)


def test_outside_a_workspace_nothing_is_capped():
    assert memory_room() is None
    check_memory(1 << 40)


@pytest.mark.asyncio
async def test_an_object_past_what_is_left_is_refused():
    stored = [4]
    budget = MemoryBudget(10, lambda: stored[0])

    async def hold() -> int | None:
        check_memory(6)
        with pytest.raises(MemoryExhausted, match="memory exhausted"):
            check_memory(7)
        stored[0] = 12
        return memory_room()

    assert await run_with_memory(budget, hold()) == 0
    assert memory_room() is None


@pytest.mark.asyncio
async def test_no_budget_caps_nothing():
    async def hold() -> None:
        check_memory(1 << 40)

    await run_with_memory(None, hold())
