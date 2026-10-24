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

import asyncio
import dataclasses
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from mirage.policy.decisions import op_question
from mirage.policy.policies import agreed, settled
from mirage.policy.types import (
    Abandoned,
    Ask,
    Claimant,
    CommandContext,
    Deny,
    Pending,
    PolicyCaller,
    Route,
    RouteContext,
)
from mirage.runtime.base import Runtime
from mirage.runtime.routing import RouteError
from mirage.runtime.table import bind_commands, catch_all, runtime_bindings_for
from mirage.runtime.types import RouteDecision, RuntimeIdentity
from mirage.runtime.workspace import WorkspaceRuntime
from mirage.utils.abort import MirageAbortError
from mirage.view.types import FileView, SessionView
from mirage.workspace.mount import MountRegistry
from mirage.workspace.node.explain import Judged, Walked
from mirage.workspace.session import SessionState
from mirage.workspace.workspace.runtimes import Runtimes


class Router:
    """Decides which runtime a typed line routes to.

    The order is: an inherited decision, then the ``execute()`` runtime
    argument, then the placement stage (``pre_execute``: the configured
    route policy as a built-in, then the coded policies), then each
    command's first capturer. It reads the runtime entries and the
    registry's static bindings but owns no mutable workspace state, so
    the volatile parts (the current agent, the line's admission) arrive
    per call and a new step is added here rather than in the workspace.

    Args:
        registry (MountRegistry): carries the resolved static bindings.
        runtimes (Runtimes): the ordered runtime entries.
    """

    def __init__(
        self,
        registry: MountRegistry,
        runtimes: Runtimes,
    ) -> None:
        self._registry = registry
        self._runtimes = runtimes

    async def decide(
        self,
        command: str,
        runtime: str | None,
        session: SessionState,
        inherited: RouteDecision[RuntimeIdentity] | None,
        judged: Callable[[], Awaitable[Sequence[tuple[Walked, list[Judged]]]]],
        held: Callable[[], Awaitable[bool]] | None = None,
        claimant: Claimant | None = None,
        cancel: asyncio.Event | None = None,
    ) -> RouteDecision[RuntimeIdentity] | Deny | Pending:
        """Resolve the routing decision for one typed line.

        Returns the static bindings as the decision when nothing decides
        (no runtime argument, nothing to consult), the stage's Deny when
        a policy refuses the line, and the ledger's answer to its Ask
        when the host refuses the line or has not answered yet. A nested
        eval passes its typed line's decision as ``inherited`` and keeps
        it: nested lines never re-route. The runtime argument is the
        caller's own placement, so a Route is not asked for, but a coded
        policy's Deny or Ask still holds the line. Admission comes
        first: a line ``held`` reports refused or waiting on a question
        is left unplaced, for the gate to answer.

        Args:
            command (str): the raw command line.
            runtime (str | None): the execute() runtime argument, which
                wins over the policy.
            session (SessionState): the effective session (cwd, env).
            inherited (RouteDecision | None): the calling line's
                decision, for nested evals.
            judged (Callable[[], Awaitable[Sequence[tuple[Walked,
                list[Judged]]]]]): the line pass's reading of the line
                (``line_judgments``), which gives ``pre_execute`` its
                commands; awaited only when there is a placement to
                consult.
            held (Callable[[], Awaitable[bool]] | None): the line's
                admission, whether some command of it is refused or
                waits on the host; awaited only when there is a
                placement to consult.
            claimant (Claimant | None): the line as a whole on its
                hand-off, so an approval of the line is claimed there
                like a command's: kept for the retry of a line still
                waiting on another question, spent when the line ends.
            cancel (asyncio.Event | None): the run's kill channel.

        Raises:
            RouteError: an unknown runtime name or a failing policy.
            MirageAbortError: the run was killed while the host decided.
        """
        if inherited is not None:
            return inherited
        entries = self._runtimes.entries
        policies = self._registry.policies
        placing = await policies.wants_for("pre_execute", session.session_id)
        placed = None if runtime is None else self._placed(entries, runtime)
        if not placing or (held is not None and await held()):
            return placed if placed is not None else self._unplaced(entries)
        ctx = self.context(command, session, await judged())
        said, route = await policies.pre_execute(
            ctx, placed=placed is not None
        )
        action = (
            await self._registry.decisions.resolve(
                *op_question(ctx, said), cancel, claimant
            )
            if isinstance(said, Ask)
            else said
        )
        if isinstance(action, Abandoned):
            raise MirageAbortError()
        if action is not None:
            return action
        if placed is not None:
            return placed
        if route is not None:
            return self._routed(entries, route.runtime)
        return self._unplaced(entries)

    async def placement(
        self,
        command: str,
        session: SessionState,
        judged: Callable[[], Awaitable[Sequence[tuple[Walked, list[Judged]]]]],
    ) -> tuple[
        tuple[Deny | Ask | Route, ...],
        RouteDecision[RuntimeIdentity] | Deny | Pending,
    ]:
        """Every ``pre_execute`` answer for a line and what they decide,
        without running it: what ``explain`` shows. An Ask reads the
        ledger's settled records alone and records nothing.

        Args:
            command (str): the raw command line.
            session (SessionState): the effective session.
            judged (Callable[[], Awaitable[Sequence[tuple[Walked,
                list[Judged]]]]]): the line pass's reading of the line,
                as ``decide`` takes it.

        Raises:
            RouteError: an unknown runtime name or a failing policy.
        """
        entries = self._runtimes.entries
        policies = self._registry.policies
        placing = await policies.wants_for("pre_execute", session.session_id)
        if not placing:
            return (), self._unplaced(entries)
        ctx = self.context(command, session, await judged())
        answers = await policies.answers("pre_execute", ctx)
        winner = settled(answers)
        if isinstance(winner, Ask):
            standing = self._registry.decisions.held(*op_question(ctx, winner))
            if standing is not None:
                return answers, standing
            winner = agreed([a for a in answers if isinstance(a, Route)])
        if isinstance(winner, Deny):
            return answers, winner
        if isinstance(winner, Route):
            return answers, self._routed(entries, winner.runtime)
        return answers, self._unplaced(entries)

    def _routed(
        self, entries: list[Runtime[Any]], name: str
    ) -> RouteDecision[RuntimeIdentity]:
        """The decision a policy's route places a line on. ``workspace``
        keeps the line in Mirage: no line executor (a ``*`` capture)
        takes it, and each command stays on its first other capturer.
        Any other name places it as the runtime argument does.

        Args:
            entries (list[Runtime]): the workspace's ordered runtimes.
            name (str): the runtime the route names.

        Raises:
            RouteError: no entry has the name.
        """
        if name != WorkspaceRuntime.name:
            return self._placed(entries, name)
        kept = [e for e in entries if "*" not in e.captures]
        bindings: dict[str, Runtime[Any] | None] = {
            command: None for entry in entries for command in entry.captures
        }
        bindings.update(bind_commands(kept))
        return RouteDecision(bindings=bindings, fallback=catch_all(entries))

    def _unplaced(
        self, entries: list[Runtime[Any]]
    ) -> RouteDecision[RuntimeIdentity]:
        """The decision for a line no policy placed: each command on its
        first capturer, kept for the line's nested evals.

        Args:
            entries (list[Runtime]): the workspace's ordered runtimes.
        """
        return RouteDecision(
            bindings=dict(self._registry.runtime_bindings),
            fallback=catch_all(entries),
        )

    def runtime_for(
        self, command: str, decision: RouteDecision[RuntimeIdentity]
    ) -> str:
        """The runtime entry that serves a command under a decision,
        empty when the workspace runs it itself.

        Args:
            command (str): the command name.
            decision (RouteDecision): the line's placement.
        """
        serving = decision.bindings.get(command, decision.fallback)
        if serving is None or isinstance(serving, WorkspaceRuntime):
            return ""
        return serving.name

    def _placed(
        self, entries: list[Runtime[Any]], name: str
    ) -> RouteDecision[RuntimeIdentity]:
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

    def context(
        self,
        line: str,
        session: SessionState,
        judged: Sequence[tuple[Walked, list[Judged]]],
    ) -> RouteContext:
        """What ``pre_execute`` sees of one line, and ``post_execute``
        before what came back: the line, every command in it as the gate
        that runs it will read it, each with the session it would be
        judged in, and the session, its namespace and its files, which a
        script reads as plain data too.

        Args:
            line (str): the raw command line.
            session (SessionState): the effective session.
            judged (Sequence[tuple[Walked, list[Judged]]]): the line pass's
                reading of the line (``line_judgments``).
        """
        views = self._registry.policies.views

        def handles(
            walked: SessionState,
        ) -> tuple[SessionView | None, FileView | None, PolicyCaller | None]:
            found = views(walked.session_id, walked) if views else None
            return found or (None, None, None)

        commands: list[CommandContext] = []
        for item, explained in judged:
            for one in explained:
                if one.ctx is None:
                    continue
                view, vfs, caller = handles(one.session or item.session)
                commands.append(
                    dataclasses.replace(
                        one.ctx, session=view, vfs=vfs, caller=caller
                    )
                )
        view, vfs, caller = handles(session)
        return RouteContext(
            line=line,
            commands=tuple(commands),
            session_id=session.session_id,
            session=view,
            vfs=vfs,
            caller=caller,
        )
