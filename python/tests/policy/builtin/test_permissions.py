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

from mirage.policy import (
    AdmissionRules,
    Ask,
    Deny,
    Outcome,
    PermissionsPolicy,
    Policies,
)
from tests.fixtures.command_trees import line, trees


class _Sessions:
    def __init__(self, rules: dict[str, AdmissionRules]) -> None:
        self.rules = rules

    def commands_of(self, session_id: str) -> AdmissionRules | None:
        return self.rules.get(session_id)


FULL = trees(
    {
        "rm": {
            "decision": "deny",
            "reason": "no repo deletes",
            "paths": ["/repo/*"],
        },
        "cp": {"decision": "ask", "reason": "sign-off"},
    },
    mounts={"/repo": {"cp": {"decision": "deny", "reason": "read-only"}}},
)
REVIEWER = trees({"*": "deny", "ls": "allow", "cat": "allow"})


def _policy() -> PermissionsPolicy:
    return PermissionsPolicy(_Sessions({"s": FULL, "rev": REVIEWER}))


async def _judge(
    policy: PermissionsPolicy, *words: str, session: str = "s", **kw
) -> Deny | Ask | None:
    answer = await policy.pre_command(line(*words, session_id=session, **kw))
    assert answer is None or isinstance(answer, (Deny, Ask))
    return answer


@pytest.mark.asyncio
async def test_no_tree_means_no_opinion():
    policy = PermissionsPolicy(_Sessions({}))
    assert await _judge(policy, "rm", "-rf", "/") is None


@pytest.mark.asyncio
async def test_a_closed_root_refuses_every_command_it_names_no_allow_for():
    policy = _policy()
    assert await _judge(policy, "ls", "-la", session="rev") is None
    deny = await _judge(policy, "rm", "/x", session="rev")
    assert isinstance(deny, Deny)
    assert deny.rule is not None and deny.rule.at == "/*"
    assert deny.reason == "denied by policy"
    assert await _judge(policy, "cd", "/x", session="rev", tool=False) is None


@pytest.mark.asyncio
async def test_a_leaf_speaks_by_its_paths_and_by_where_it_was_written():
    policy = _policy()
    deny = await _judge(policy, "cp", "a", "b", cwd="/repo/sub")
    assert isinstance(deny, Deny) and deny.reason == "read-only"
    assert deny.rule is not None and deny.rule.mount == "/repo"
    ask = await _judge(policy, "cp", "a", "b", cwd="/scratch")
    assert isinstance(ask, Ask) and ask.reason == "sign-off"
    assert ask.rules == (ask.rule,)
    refused = await _judge(policy, "rm", "/repo/x")
    assert isinstance(refused, Deny)
    assert refused.path == "/repo/x"
    assert refused.rule is not None and refused.rule.decision is Outcome.DENY
    assert await _judge(policy, "rm", "/scratch/x") is None


@pytest.mark.asyncio
async def test_seeded_in_a_policies_chain_after_the_builtins():
    policies = Policies([_policy()])
    deny = await policies.pre_command(
        line("cp", "a", "b", cwd="/repo", session_id="s")
    )
    assert isinstance(deny, Deny)
    assert deny.reason == "read-only"
    assert deny.policy == "PermissionsPolicy"
    assert not policies.wants("pre_vfs")
