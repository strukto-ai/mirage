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

import pytest

from mirage.commands.builtin.utils.safeguard import CommandTimeoutError
from mirage.shell.job_budget import JobBudget


async def _sleep_then(value, seconds):
    await asyncio.sleep(seconds)
    return value


@pytest.mark.asyncio
async def test_unlimited_budget_has_no_remaining():
    budget = JobBudget(None)
    assert budget.remaining() is None
    assert await budget.run(_sleep_then("ok", 0.05)) == "ok"


@pytest.mark.asyncio
async def test_nonpositive_budget_is_off():
    budget = JobBudget(0)
    assert budget.remaining() is None
    assert await budget.run(_sleep_then("ok", 0.05)) == "ok"


@pytest.mark.asyncio
async def test_positive_budget_counts_down_and_clamps():
    budget = JobBudget(0.2)
    first = budget.remaining()
    assert first is not None and 0 < first <= 0.2
    await asyncio.sleep(0.25)
    assert budget.remaining() == 0.0


@pytest.mark.asyncio
async def test_run_returns_result_within_budget():
    budget = JobBudget(0.3)
    assert await budget.run(_sleep_then("done", 0.05)) == "done"


@pytest.mark.asyncio
async def test_run_raises_pipeline_timeout_on_overrun():
    budget = JobBudget(0.05)
    with pytest.raises(CommandTimeoutError) as info:
        await budget.run(_sleep_then("never", 5))
    assert info.value.command == "pipeline"
    assert info.value.seconds == 0.05


@pytest.mark.asyncio
async def test_run_raises_when_already_expired():
    budget = JobBudget(0.05)
    await asyncio.sleep(0.1)
    with pytest.raises(CommandTimeoutError) as info:
        await budget.run(_sleep_then("never", 5))
    assert info.value.command == "pipeline"
    assert info.value.seconds == 0.05
