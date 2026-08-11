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

import re

from mirage.policy.base import Policy
from mirage.policy.types import (Action, CommandContext, Deny, GuardSpec,
                                 OpsContext)


def wildcard_regex(pattern: str) -> re.Pattern[str]:
    """Compile a ``*``/``?`` wildcard into an anchored regex.

    Deliberately not fnmatch: both languages support exactly these two
    metacharacters, so a pattern means the same thing in Python and
    TypeScript.

    Args:
        pattern (str): the wildcard pattern.
    """
    parts = []
    for ch in pattern:
        if ch == "*":
            parts.append(".*")
        elif ch == "?":
            parts.append(".")
        else:
            parts.append(re.escape(ch))
    return re.compile("^" + "".join(parts) + "$")


class SpecPolicy(Policy):
    """A GuardSpec compiled to a policy.

    Args:
        spec (GuardSpec): the declarative rule.
    """

    def __init__(self, spec: GuardSpec) -> None:
        self.spec = spec
        self._patterns = [wildcard_regex(p) for p in spec.paths]

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        spec = self.spec
        if spec.commands and ctx.command not in spec.commands:
            return None
        if not self._patterns:
            return Deny(f"{ctx.command}: {spec.reason}\n")
        for p in ctx.paths:
            for pattern in self._patterns:
                if pattern.match(p.virtual):
                    display = p.raw_path or p.virtual
                    return Deny(f"{ctx.command}: {display}: {spec.reason}\n")
        return None

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        # The op-layer twin: pure path protection (no command scope)
        # also holds at the op doors, so FUSE, programmatic ops, and
        # the warm cache cannot bypass it. Command-scoped specs stay
        # command-layer: an op does not know which command issued it.
        spec = self.spec
        if spec.commands or not self._patterns:
            return None
        for pattern in self._patterns:
            if pattern.match(ctx.path.virtual):
                return Deny(f"{spec.reason}\n")
        return None
