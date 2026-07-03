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

from mirage.provision import Precision, ProvisionResult


def test_plan_result_defaults():
    r = ProvisionResult()
    assert r.network_read_low == 0
    assert r.precision == Precision.EXACT
    assert r.estimated_cost_usd is None


def test_plan_result_network_read_range():
    r = ProvisionResult(network_read_low=100, network_read_high=200)
    assert r.network_read == "100-200"


def test_plan_result_network_read_exact():
    r = ProvisionResult(network_read_low=100, network_read_high=100)
    assert r.network_read == "100"


def test_precision_values():
    assert Precision.EXACT == "exact"
    assert Precision.RANGE == "range"
    assert Precision.UNKNOWN == "unknown"


def test_scaled_multiplies_cost():
    result = ProvisionResult(network_read_low=10,
                             network_read_high=10,
                             read_ops=1,
                             estimated_cost_usd=0.5)
    tripled = result.scaled(3)
    assert tripled.network_read_low == 30
    assert tripled.estimated_cost_usd == 1.5
    free = ProvisionResult(network_read_low=10, network_read_high=10)
    assert free.scaled(3).estimated_cost_usd is None
