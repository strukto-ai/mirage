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

from collections.abc import Callable
from typing import Any

from mirage.runtime.policy import (PolicyContext, PolicyDecision, PolicyError,
                                   PolicyFn, decide_line, parsed_commands)
from mirage.runtime.table import catch_all, runtime_bindings_for
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import Session
from mirage.workspace.workspace.runtimes import Runtimes

PrefixFn = Callable[[], list[str]]


class PolicyRouter:
    """Decides which runtime a typed line routes to.

    The order is: an inherited decision, then the ``execute()`` runtime
    argument, then the configured policy and any entry scripts. It
    reads the runtime entries and the registry's static bindings but
    owns no mutable workspace state, so the volatile parts (the policy
    callable, the current agent) arrive per call and a new step is
    added here rather than in the workspace.

    Args:
        registry (MountRegistry): carries the resolved static bindings.
        runtimes (Runtimes): the ordered runtime entries.
        mount_prefixes (PrefixFn): mount prefixes for the policy context.
    """

    def __init__(self, registry: MountRegistry, runtimes: Runtimes,
                 mount_prefixes: PrefixFn) -> None:
        self._registry = registry
        self._runtimes = runtimes
        self._mount_prefixes = mount_prefixes

    async def decide(
        self,
        ast: Any,
        command: str,
        runtime: str | None,
        provision: bool,
        session: Session,
        session_id: str,
        agent_id: str,
        policy: PolicyFn | None,
        inherited: PolicyDecision | None,
    ) -> PolicyDecision | None:
        """Resolve the routing decision for one typed line.

        Returns None when nothing decides (no runtime argument, no
        policy configured) so dispatch falls to the static bindings. A
        nested eval passes its typed line's decision as ``inherited``
        and keeps it: nested lines never re-route. Provision never
        routes.

        Args:
            ast: the parsed tree-sitter root node.
            command (str): the raw command line.
            runtime (str | None): the execute() runtime argument, which
                wins over the policy.
            provision (bool): whether this is a provision run.
            session (Session): the effective session (cwd, env).
            session_id (str): session hosting the line.
            agent_id (str): agent the line runs as.
            policy (PolicyFn | None): the workspace policy, if any.
            inherited (PolicyDecision | None): the calling line's
                decision, for nested evals.

        Raises:
            PolicyError: an unknown runtime name or a failing policy.
        """
        if inherited is not None:
            return inherited
        entries = self._runtimes.entries
        if runtime is not None:
            try:
                overlay = runtime_bindings_for(entries, runtime)
            except ValueError as exc:
                raise PolicyError(str(exc)) from exc
            return PolicyDecision(bindings={
                **self._registry.runtime_bindings,
                **overlay
            },
                                  fallback=catch_all(entries))
        if provision:
            return None
        has_scripts = any(entry.script is not None for entry in entries)
        if policy is None and not has_scripts:
            return None
        commands = parsed_commands(ast, self._registry.clis.names())
        ctx = PolicyContext(
            line=command,
            commands=commands,
            command=commands[0].command if commands else "",
            builtin=commands[0].builtin if commands else False,
            cwd=session.cwd,
            env=dict(session.env),
            session_id=session_id,
            agent_id=agent_id,
            mounts=tuple(self._mount_prefixes()),
        )
        try:
            return await decide_line(entries, policy, ctx,
                                     self._registry.runtime_bindings)
        except PolicyError:
            raise
        except (ValueError, ImportError) as exc:
            raise PolicyError(str(exc)) from exc
