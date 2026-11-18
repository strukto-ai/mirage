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

from mirage.policy.errors import describe_decision
from mirage.types import PolicyDecision


def test_describe_decision_carries_the_reason_the_stderr_line_dropped():
    assert (
        describe_decision(
            PolicyDecision(
                kind="deny", reason="user rule", policy="RulePolicy"
            )
        )
        == "policy denied: user rule"
    )
    assert (
        describe_decision(
            PolicyDecision(kind="pending", reason="sign-off", ask_id="abc123")
        )
        == "requires approval: sign-off (ask abc123)"
    )
    assert (
        describe_decision(PolicyDecision(kind="pending", reason="sign-off"))
        == "requires approval: sign-off (ask )"
    )
    assert (
        describe_decision(
            PolicyDecision(
                kind="failed", reason="Raising failed", policy="Raising"
            )
        )
        == "policy Raising failed"
    )
