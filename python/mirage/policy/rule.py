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

from mirage.policy.base import Policy
from mirage.policy.match import match_op, match_rule
from mirage.policy.types import (
    Action,
    CommandContext,
    CommandRule,
    Deny,
    DenyScope,
    VfsContext,
)
from mirage.utils.hidden import classify_paths


class RulePolicy(Policy):
    """A CommandRule compiled to a policy.

    Internal: the permissions policy evaluates the document's rules
    through the same matcher this wraps, and nothing outside the
    package constructs one; it survives as the one-rule form for tests
    and for code that wants a single rule as a Policy. The rule's paths
    compile through the same classifier as ``paths.hide`` and match
    through the same matcher, so a deny scope and a hide read one
    grammar.

    Args:
        rule (CommandRule): the declarative rule.
    """

    def __init__(self, rule: CommandRule) -> None:
        self.rule = rule
        self._scope = classify_paths(rule.paths)

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        hit = match_rule(self.rule, self._scope, ctx)
        if hit is None:
            return None
        if hit.operand is None:
            return Deny(self.rule.reason)
        return Deny(self.rule.reason, DenyScope.OPERAND, path=hit.operand)

    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        # The op-layer twin: pure path protection (no command scope)
        # also holds at the op doors, so FUSE, programmatic ops, and
        # the warm cache cannot bypass it. Command-scoped rules stay
        # command-layer: an op does not know which command issued it.
        if match_op(self.rule, self._scope, ctx):
            return Deny(self.rule.reason)
        return None
