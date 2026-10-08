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

from collections.abc import Awaitable, Callable
from typing import Any

from mirage.policy.policies import settled
from mirage.policy.types import Deny, Route
from mirage.runtime.base import Runtime
from mirage.runtime.resolver import MountResolver
from mirage.runtime.routing import (
    ParsedCommand,
    RouteContext,
    RouteDecision,
    RouteError,
    decide_line,
    evaluate_script,
    parsed_commands,
)
from mirage.runtime.table import catch_all, runtime_bindings_for
from mirage.runtime.workspace import WorkspaceRuntime
from mirage.workspace.lookup import Consumer, lookup
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState, env_snapshot
from mirage.workspace.workspace.runtimes import Runtimes


class Router:
    """Decides which runtime a typed line routes to.

    The order is: an inherited decision, then the ``execute()`` runtime
    argument, then the placement stage (``pre_execute``: the configured
    route policy as a built-in, then the coded policies), then the
    entry scripts. A runtime a policy names is then validated against
    the runtime itself: its own ``script:`` must take the line, or the
    two conflict and the line is refused; the caller's argument forces
    its runtime. It reads the runtime entries and the registry's
    static bindings but owns no mutable workspace state, so the
    volatile parts (the current agent, the line's admission) arrive per
    call and a new step is added here rather than in the workspace.

    Args:
        registry (MountRegistry): carries the resolved static bindings.
        runtimes (Runtimes): the ordered runtime entries.
        resolver (MountResolver): mount prefixes for the policy context.
    """

    def __init__(
        self,
        registry: MountRegistry,
        runtimes: Runtimes,
        resolver: MountResolver,
    ) -> None:
        self._registry = registry
        self._runtimes = runtimes
        self._resolver = resolver

    async def decide(
        self,
        ast: Any,
        command: str,
        runtime: str | None,
        session: SessionState,
        session_id: str,
        agent_id: str,
        inherited: RouteDecision | None,
        held: Callable[[], Awaitable[bool]] | None = None,
    ) -> RouteDecision | Deny | None:
        """Resolve the routing decision for one typed line.

        Returns None when nothing decides (no runtime argument, nothing
        to consult) so dispatch falls to the static bindings, and the
        stage's Deny when a placing policy refuses the line. A nested
        eval passes its typed line's decision as ``inherited`` and keeps
        it: nested lines never re-route. The runtime argument is the
        caller's own placement, so a Route is not asked for and the
        runtime's own ``script:`` is not consulted (the caller forces
        it), but a coded policy's Deny still refuses the line. A runtime
        a policy names must take the line itself (``_validated``).
        Admission comes first: a
        line ``held`` reports refused or waiting on a question is left
        on the static bindings, unplaced, for the gate to answer.

        Args:
            ast: the parsed tree-sitter root node.
            command (str): the raw command line.
            runtime (str | None): the execute() runtime argument, which
                wins over the policy.
            session (SessionState): the effective session (cwd, env).
            session_id (str): session hosting the line.
            agent_id (str): agent the line runs as.
            inherited (RouteDecision | None): the calling line's
                decision, for nested evals.
            held (Callable[[], Awaitable[bool]] | None): the line's
                admission, whether some command of it is refused or
                waits on the host; awaited only when there is a
                placement to consult.

        Raises:
            RouteError: an unknown runtime name or a failing policy.
        """
        if inherited is not None:
            return inherited
        entries = self._runtimes.entries
        policies = self._registry.policies
        placing = policies.wants("pre_execute")
        if runtime is not None:
            placed = self._placed(entries, runtime)
            if not placing or (held is not None and await held()):
                return placed
            said = await policies.pre_execute(
                self._context(ast, command, session, session_id, agent_id),
                placed=True,
            )
            return said if isinstance(said, Deny) else placed
        if not placing and not any(e.script is not None for e in entries):
            return None
        if held is not None and await held():
            return None
        ctx = self._context(ast, command, session, session_id, agent_id)
        said = await policies.pre_execute(ctx)
        if isinstance(said, Deny):
            return said
        if isinstance(said, Route):
            return await self._validated(entries, said.runtime, ctx, session)
        return await self._scripted(entries, ctx, session)

    async def placement(
        self,
        ast: Any,
        command: str,
        session: SessionState,
        session_id: str,
        agent_id: str,
    ) -> tuple[tuple[Deny | Route, ...], RouteDecision | Deny | None]:
        """Every placement answer for a line and what they decide,
        without running it: what ``explain`` shows.

        Args:
            ast: the parsed tree-sitter root node.
            command (str): the raw command line.
            session (SessionState): the effective session.
            session_id (str): session hosting the line.
            agent_id (str): agent the line runs as.

        Raises:
            RouteError: an unknown runtime name or a failing policy.
        """
        entries = self._runtimes.entries
        policies = self._registry.policies
        if not policies.wants("pre_execute") and not any(
            e.script is not None for e in entries
        ):
            return (), None
        ctx = self._context(ast, command, session, session_id, agent_id)
        said = await policies.answers("pre_execute", ctx)
        answers = tuple(a for a in said if isinstance(a, (Deny, Route)))
        winner = settled(answers)
        if isinstance(winner, Deny):
            return answers, winner
        if isinstance(winner, Route):
            checked = await self._validated(
                entries, winner.runtime, ctx, session
            )
            if isinstance(checked, Deny):
                return (*answers, checked), checked
            return answers, checked
        return answers, await self._scripted(entries, ctx, session)

    async def _scripted(
        self, entries: list[Runtime], ctx: RouteContext, session: SessionState
    ) -> RouteDecision:
        """The entry scripts' decision, for a line no policy placed: each
        runtime's ``script:`` says whether it takes the line.

        Args:
            entries (list[Runtime]): the workspace's ordered runtimes.
            ctx (RouteContext): the placement stage's payload.
            session (SessionState): the effective session.

        Raises:
            RouteError: a script that fails or answers a verdict shape.
        """
        try:
            return await decide_line(
                entries,
                None,
                ctx,
                self._registry.runtime_bindings,
                self._external(ctx.commands, session),
            )
        except RouteError:
            raise
        except (ValueError, ImportError) as exc:
            raise RouteError(str(exc)) from exc

    async def _validated(
        self,
        entries: list[Runtime],
        name: str,
        ctx: RouteContext,
        session: SessionState,
    ) -> RouteDecision | Deny:
        """The decision placing a line on the runtime ``name``, once the
        runtime agrees: its own ``script:``, when it has one, must take
        the line, or the placement and the runtime conflict and the line
        is refused, as two policies placing it apart refuse it.

        Args:
            entries (list[Runtime]): the workspace's ordered runtimes.
            name (str): the runtime entry the line is placed on.
            ctx (RouteContext): the placement stage's payload.
            session (SessionState): the effective session.

        Raises:
            RouteError: no entry has the name, or its script fails or
                answers a verdict shape.
        """
        placed = self._placed(entries, name)
        entry = next((e for e in entries if e.name == name), None)
        if entry is None or entry.script is None:
            return placed
        try:
            willing = await evaluate_script(
                entry.script,
                ctx,
                entry,
                entries,
                self._external(ctx.commands, session),
            )
        except RouteError:
            raise
        except (ValueError, ImportError) as exc:
            raise RouteError(str(exc)) from exc
        if willing:
            return placed
        return Deny(
            f"runtime {name} declines this line", policy=f"runtimes.{name}"
        )

    def runtime_for(self, command: str, decision: RouteDecision | None) -> str:
        """The runtime entry that serves a command under a decision (the
        static bindings when there is none), empty when the workspace
        runs it itself.

        Args:
            command (str): the command name.
            decision (RouteDecision | None): the line's placement.
        """
        bindings = (
            decision.bindings
            if decision is not None
            else self._registry.runtime_bindings
        )
        serving = (
            bindings[command]
            if command in bindings
            else (decision.fallback if decision is not None else None)
        )
        if serving is None or isinstance(serving, WorkspaceRuntime):
            return ""
        return serving.name

    def _placed(self, entries: list[Runtime], name: str) -> RouteDecision:
        """The decision that serves a line on one named runtime: its
        captures over the static bindings.

        Args:
            entries (list[Runtime]): the workspace's ordered runtimes.
            name (str): the runtime entry the line is placed on.

        Raises:
            RouteError: no entry has the name, or it cannot be selected.
        """
        try:
            overlay = runtime_bindings_for(entries, name)
        except ValueError as exc:
            raise RouteError(str(exc)) from exc
        return RouteDecision(
            bindings={**self._registry.runtime_bindings, **overlay},
            fallback=catch_all(entries),
        )

    def _external(
        self, commands: tuple[ParsedCommand, ...], session: SessionState
    ) -> list[str]:
        """The stages workspace lookup leaves to the external fallback.

        Args:
            commands (tuple[ParsedCommand, ...]): the line's commands.
            session (SessionState): the effective session.
        """
        return [
            parsed.command
            for parsed in commands
            if "/" not in parsed.command
            and parsed.command not in self._registry.runtime_bindings
            and lookup(parsed.command, session, self._registry)
            is Consumer.EXTERNAL
        ]

    def _context(
        self,
        ast: Any,
        command: str,
        session: SessionState,
        session_id: str,
        agent_id: str,
    ) -> RouteContext:
        """The placement stage's payload for one line, the one a route
        policy has always read.

        Args:
            ast: the parsed tree-sitter root node.
            command (str): the raw command line.
            session (SessionState): the effective session (cwd, env).
            session_id (str): session hosting the line.
            agent_id (str): agent the line runs as.
        """
        commands = parsed_commands(
            ast,
            self._registry.clis.names(),
            self._registry.match_command_prefix,
        )
        return RouteContext(
            line=command,
            commands=commands,
            command=commands[0].command if commands else "",
            builtin=commands[0].builtin if commands else False,
            cwd=session.cwd,
            env=env_snapshot(session),
            session_id=session_id,
            agent_id=agent_id,
            mounts=tuple(self._resolver.prefixes()),
        )
