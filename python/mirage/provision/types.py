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

    def scaled(self, n: int, command: str | None = None) -> "ProvisionResult":
        """Multiply every combinable field by an iteration count.

        Args:
            n (int): Iteration count (e.g. for-loop repetitions).
            command (str | None): Command label for the scaled result.

        Returns:
            ProvisionResult: New result with byte and op counters scaled;
            precision is carried over and estimated_cost_usd is dropped.
        """
        fields = {f: getattr(self, f) * n for f in COMBINE_FIELDS}
        return ProvisionResult(command=command,
                               precision=self.precision,
                               **fields)


COMBINE_FIELDS = (
    "network_read_low",
    "network_read_high",
    "cache_read_low",
    "cache_read_high",
    "network_write_low",
    "network_write_high",
    "cache_write_low",
    "cache_write_high",
    "read_ops",
    "cache_hits",
)
LOW_FIELDS = tuple(f for f in COMBINE_FIELDS if not f.endswith("_high"))
HIGH_FIELDS = tuple(f for f in COMBINE_FIELDS if f.endswith("_high"))

_PRECISION_ORDER = {
    Precision.EXACT: 0,
    Precision.RANGE: 1,
    Precision.UPPER_BOUND: 2,
    Precision.UNKNOWN: 3,
}


def combined_precision(children: list[ProvisionResult]) -> Precision:
    """Worst precision across children (EXACT < RANGE < UPPER_BOUND <
    UNKNOWN).

    Missing knowledge is carried by precision, not by null fields: when
    this returns UNKNOWN the combined numeric totals are lower bounds.

    Args:
        children (list[ProvisionResult]): Child results.

    Returns:
        Precision: Worst child precision; EXACT for no children.
    """
    if not children:
        return Precision.EXACT
    return max((c.precision for c in children),
               key=lambda p: _PRECISION_ORDER[p])


def combined_cost(children: list[ProvisionResult]) -> float | None:
    """Sum child costs; None unless every child has one.

    estimated_cost_usd is the only nullable field, so a single costless
    child makes the total unknowable rather than silently undercounted.

    Args:
        children (list[ProvisionResult]): Child results.

    Returns:
        float | None: Total cost, or None when any child lacks one.
    """
    costs = [
        c.estimated_cost_usd for c in children
        if c.estimated_cost_usd is not None
    ]
    if children and len(costs) == len(children):
        return sum(costs)
    return None


def combine_sum(op: str, children: list[ProvisionResult]) -> ProvisionResult:
    """Combine children that all run: field-wise sums (|, ;, &&).

    Args:
        op (str): Operator label stored on the combined result.
        children (list[ProvisionResult]): Child results.

    Returns:
        ProvisionResult: Field-wise sums with worst-of precision.
    """
    fields = {f: sum(getattr(c, f) for c in children) for f in COMBINE_FIELDS}
    return ProvisionResult(op=op,
                           children=children,
                           precision=combined_precision(children),
                           estimated_cost_usd=combined_cost(children),
                           **fields)


def combine_alternative(op: str,
                        children: list[ProvisionResult]) -> ProvisionResult:
    """Combine children where only one runs (||): best/worst envelope.

    Lows and op counters take the cheapest child (min), highs the most
    expensive (max), so the result brackets every possible branch.

    Args:
        op (str): Operator label stored on the combined result.
        children (list[ProvisionResult]): Child results.

    Returns:
        ProvisionResult: Envelope result; precision is RANGE unless a
        child is UNKNOWN, cost is the cheapest child's when all have one.
    """
    fields = {
        f: min((getattr(c, f) for c in children), default=0)
        for f in LOW_FIELDS
    }
    fields.update({
        f: max((getattr(c, f) for c in children), default=0)
        for f in HIGH_FIELDS
    })
    cost = combined_cost(children)
    if cost is not None:
        cost = min(c.estimated_cost_usd for c in children
                   if c.estimated_cost_usd is not None)
    precision = (Precision.UNKNOWN if combined_precision(children)
                 == Precision.UNKNOWN else Precision.RANGE)
    return ProvisionResult(op=op,
                           children=children,
                           precision=precision,
                           estimated_cost_usd=cost,
                           **fields)
