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

from enum import Enum

from pydantic import BaseModel, Field


class Precision(str, Enum):
    EXACT = "exact"
    RANGE = "range"
    UNKNOWN = "unknown"
    UPPER_BOUND = "upper_bound"


class ProvisionResult(BaseModel):
    """Estimated cost of an operation before execution.

    Args:
        op (str | None): Operator ("|", "&&", etc.) or None for leaf.
        command (str | None): Leaf command string.
        children (list[ProvisionResult]): Child results for compound commands.
        network_read_low (int): Low estimate of network bytes read.
        network_read_high (int): High estimate of network bytes read.
        cache_read_low (int): Low estimate of cache bytes read.
        cache_read_high (int): High estimate of cache bytes read.
        network_write_low (int): Low estimate of network bytes written.
        network_write_high (int): High estimate of network bytes written.
        cache_write_low (int): Low estimate of cache bytes written.
        cache_write_high (int): High estimate of cache bytes written.
        read_ops (int): Number of read operations.
        cache_hits (int): Number of cache hits.
        precision (Precision): Estimate precision level.
        estimated_cost_usd (float | None): Estimated monetary cost.
    """

    op: str | None = None
    command: str | None = None
    children: list["ProvisionResult"] = Field(default_factory=list)
    network_read_low: int = 0
    network_read_high: int = 0
    cache_read_low: int = 0
    cache_read_high: int = 0
    network_write_low: int = 0
    network_write_high: int = 0
    cache_write_low: int = 0
    cache_write_high: int = 0
    read_ops: int = 0
    cache_hits: int = 0
    precision: Precision = Precision.EXACT
    estimated_cost_usd: float | None = None

    def _fmt_range(self, low: int, high: int) -> str:
        if low == high:
            return str(low)
        return f"{low}-{high}"

    @property
    def network_read(self) -> str:
        return self._fmt_range(self.network_read_low, self.network_read_high)

    @property
    def cache_read(self) -> str:
        return self._fmt_range(self.cache_read_low, self.cache_read_high)

    @property
    def network_write(self) -> str:
        return self._fmt_range(self.network_write_low, self.network_write_high)

    @property
    def cache_write(self) -> str:
        return self._fmt_range(self.cache_write_low, self.cache_write_high)
