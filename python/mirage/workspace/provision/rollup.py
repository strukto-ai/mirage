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

from mirage.provision import (Precision, ProvisionResult, combine_alternative,
                              combine_sum)


def rollup_pipe(children: list[ProvisionResult]) -> ProvisionResult:
    """Aggregate plan results for a pipe (all stages run).

    A stage downstream of an UNKNOWN stage cannot be trusted either (its
    input volume is unknowable), so its precision is degraded before the
    field-wise sum.

    Args:
        children (list[ProvisionResult]): Per-stage results.

    Returns:
        ProvisionResult: Field-wise sums under op "|".
    """
    unknown_seen = False
    for child in children:
        if unknown_seen:
            child.precision = Precision.UNKNOWN
        elif child.precision == Precision.UNKNOWN:
            unknown_seen = True
    return combine_sum("|", children)


def rollup_list(
    op: str,
    children: list[ProvisionResult],
) -> ProvisionResult:
    """Aggregate plan results for ;, &&, ||.

    Args:
        op (str): List operator.
        children (list[ProvisionResult]): Per-command results.

    Returns:
        ProvisionResult: Sums for ;/&& (every command runs); a min/max
        envelope for || (only one branch runs).
    """
    if op == "||":
        return combine_alternative(op, children)
    return combine_sum(op, children)
