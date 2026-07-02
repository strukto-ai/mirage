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

from mirage.provision import Precision, ProvisionResult
from mirage.workspace.provision.control import (handle_for_provision,
                                                handle_if_provision,
                                                handle_while_provision)

COSTS = {
    "cond":
    ProvisionResult(network_read_low=24,
                    network_read_high=24,
                    read_ops=1,
                    precision=Precision.EXACT),
    "then":
    ProvisionResult(network_read_low=6,
                    network_read_high=6,
                    read_ops=1,
                    precision=Precision.EXACT),
    "else":
    ProvisionResult(network_read_low=12,
                    network_read_high=12,
                    read_ops=1,
                    precision=Precision.EXACT),
    "free":
    ProvisionResult(precision=Precision.EXACT),
}


async def _node(node, session) -> ProvisionResult:
    return COSTS[node]


@pytest.mark.asyncio
async def test_if_sums_condition_with_each_branch():
    result = await handle_if_provision(_node, [("cond", ["then"])], ["else"],
                                       session=None)
    # then-path: 24 + 6 = 30; else-path: 24 + 12 = 36
    assert result.network_read_low == 30
    assert result.network_read_high == 36
    assert result.precision == Precision.RANGE


@pytest.mark.asyncio
async def test_if_without_else_pays_the_conditions():
    result = await handle_if_provision(_node, [("cond", ["then"])],
                                       None,
                                       session=None)
    # then-path: 24 + 6 = 30; fall-through still stats the condition: 24
    assert result.network_read_low == 24
    assert result.network_read_high == 30


@pytest.mark.asyncio
async def test_if_elif_ladder_accumulates_conditions():
    branches = [("cond", ["free"]), ("cond", ["then"])]
    result = await handle_if_provision(_node, branches, None, session=None)
    # branch1: 24; branch2: 24 + 24 + 6 = 54; fall-through: 48
    assert result.network_read_low == 24
    assert result.network_read_high == 54


@pytest.mark.asyncio
async def test_for_scales_and_while_is_unknown():
    result = await handle_for_provision(_node, ["then"], 3, session=None)
    assert result.network_read_low == 18
    assert result.precision == Precision.EXACT
    result = await handle_while_provision(_node, ["then"], session=None)
    assert result.precision == Precision.UNKNOWN
