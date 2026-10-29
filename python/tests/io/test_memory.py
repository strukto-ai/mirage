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
    check_memory,
    line_memory_limit,
    run_with_memory_limit,
)


def test_outside_a_line_nothing_is_capped():
    assert line_memory_limit() is None
    check_memory(1 << 40)


@pytest.mark.asyncio
async def test_an_object_past_the_line_limit_is_refused():
    async def hold() -> int | None:
        check_memory(10)
        with pytest.raises(MemoryExhausted, match="memory exhausted"):
            check_memory(11)
        return line_memory_limit()

    assert await run_with_memory_limit(10, hold()) == 10
    assert line_memory_limit() is None


@pytest.mark.asyncio
async def test_a_lifted_limit_caps_nothing():
    async def hold() -> None:
        check_memory(1 << 40)

    await run_with_memory_limit(None, hold())
