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

import inspect
from collections.abc import Mapping
from typing import Any, Protocol

from mirage.policy.base import Policy
from mirage.policy.errors import PolicyError
from mirage.policy.types import Action, Deny, ExecuteContext, Route
from mirage.runtime.base import Runtime
from mirage.runtime.route.decide import eval_source, evaluator_of
from mirage.runtime.route.types import PolicyFn, ScriptSource

POLICY_DENY_EXIT = 126


class EntriesProvider(Protocol):
    """Where the routing policy reads the world's current entries.

    The workspace's Runtimes owner satisfies this structurally; the
    narrow protocol keeps the dependency one-way (runtime never
    imports workspace).
    """

    @property
    def entries(self) -> list[Runtime]:
        ...


def parse_verdict(verdict: Any) -> Route | Deny | None:
    """Normalize a routing verdict to an Action or None to pass.

    Accepts the Action arms themselves (Route/Deny), a bare runtime
    name, None, and the wire dict the arms spell as: {"runtime":
    name} places the line, {"deny": reason} refuses it, keys mutually
    exclusive. Unknown keys fail loud so a typo never silently passes.

    Args:
        verdict (Any): whatever the policy returned.

    Raises:
        PolicyError: the verdict is not an Action arm, a name, None,
            or a verdict dict (mirrors the TS parseVerdict).
    """
    if verdict is None:
        return None
    if isinstance(verdict, str):
        return Route(verdict)
    if isinstance(verdict, (Route, Deny)):
        return verdict
    if isinstance(verdict, Mapping):
        unknown = sorted(set(verdict) - {"runtime", "deny"})
        if unknown:
            raise PolicyError(f"unknown policy verdict keys: {unknown}")
        if "deny" in verdict and "runtime" in verdict:
            raise PolicyError("policy verdict cannot both place and deny")
        if "deny" in verdict:
            return Deny(str(verdict["deny"]), POLICY_DENY_EXIT)
        name = verdict.get("runtime")
        if isinstance(name, str):
            return Route(name)
        raise PolicyError("policy verdict dict needs a 'runtime' name "
                          "or a 'deny' reason")
    raise PolicyError(f"policy must return a runtime name, a verdict "
                      f"dict, or None, got {verdict!r}")


class RoutingPolicy(Policy):
    """The ``policy=`` routing script as a pre_execute policy.

    The one built-in the runtime world contributes to the Policies
    chain: it answers "who takes this line?" by running the configured
    callable or config-borne script and translating its verdict into
    the closed Action vocabulary, so routing rides the same chain as
    every other decision instead of a parallel system.

    Args:
        policy (PolicyFn): a callable taking the ExecuteContext, or a
            config-borne ScriptSource (last expression = the verdict).
        runtimes (EntriesProvider): the workspace's ordered world, read
            per line so runtimes added later are seen.
    """

    def __init__(self, policy: PolicyFn, runtimes: EntriesProvider) -> None:
        self._policy = policy
        self._runtimes = runtimes

    async def pre_execute(self, ctx: ExecuteContext) -> Action | None:
        """Run the routing script; Route places, Deny refuses (126).

        Args:
            ctx (ExecuteContext): the parsed line's facts.
        """
        verdict: Any
        if isinstance(self._policy, ScriptSource):
            entries = self._runtimes.entries
            verdict = await eval_source(
                self._policy.source, ctx.to_dict(),
                evaluator_of(entries, self._policy.language))
        else:
            verdict = self._policy(ctx)
            if inspect.isawaitable(verdict):
                verdict = await verdict
        return parse_verdict(verdict)
