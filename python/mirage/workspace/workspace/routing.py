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
import logging
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
from mirage.runtime.constants import WHOLE_LINE
from mirage.runtime.routing import RouteError
from mirage.runtime.table import (
    bind_commands,
    catch_all,
    runtime_bindings_for,
    whole_line_runtime,
)
from mirage.runtime.types import RouteDecision, RuntimeIdentity
from mirage.runtime.workspace import WorkspaceRuntime
from mirage.shell.parse.names import command_words
from mirage.shell.types import TSNodeLike
from mirage.utils.abort import MirageAbortError
from mirage.view.types import FileView, SessionView
from mirage.workspace.executor.command.routing import invocation_routing
from mirage.workspace.lookup.constants import INTERPRETER_NAMES
from mirage.workspace.lookup.lookup import may_run_program
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.explain import Judged, Walked
from mirage.workspace.session import SessionState
from mirage.workspace.workspace.runtimes import Runtimes

logger = logging.getLogger(__name__)


class Router:
    """Decides which runtime a typed line routes to.

    The order is: an inherited decision, then the ``execute()`` runtime
    argument, then the placement stage (``pre_execute``: the configured
    route policy as a built-in, then the coded policies), then each
    command's first capturer, an interpreter a sandbox took kept off it
    where one invocation cannot run there (``RouteDecision.unserved``).
    It reads the runtime entries and the registry's static bindings but
    owns no mutable workspace state, so the volatile parts (the current
    agent, the line's admission) arrive per call and a new step is added
    here rather than in the workspace.

    Args:
        registry (MountRegistry): carries the resolved static bindings.
        runtimes (Runtimes): the ordered runtime entries.
        namespace (Namespace): the links an interpreter's script follows.
    """

    def __init__(
        self,
        registry: MountRegistry,
        runtimes: Runtimes,
        namespace: Namespace,
    ) -> None:
        self._registry = registry
        self._runtimes = runtimes
        self._namespace = namespace

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
        ast: TSNodeLike | None = None,
        deadline: float | None = None,
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
            ast (TSNodeLike | None): the parsed line, whose command heads
                say whether it may run an interpreter (``_learn_programs``);
                None for none.
            deadline (float | None): the loop time the line's budget ends,
                which bounds asking a box for its interpreters; None for
                no bound.

        Raises:
            RouteError: an unknown runtime name or a failing policy.
            MirageAbortError: the run was killed while the host decided.
        """
        if inherited is not None:
            return inherited
        if runtime is None:
            await self._learn_programs(command, ast, deadline)
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

    async def _learn_programs(
        self, command: str, ast: TSNodeLike | None, deadline: float | None
    ) -> None:
        """Ask each box that has not said which interpreters it holds, the
        first time a line may run one, and bind what it holds.

        A typed line decides its own placement after this, so it already
        runs where the answer puts its interpreters. The ask is the probe
        alone: nothing of the line reaches the box, so it comes before the
        line's admission. ``explain`` never asks. The ask stops at the
        line's deadline, which then stops the line, and a box it stopped
        is asked again by the next line.

        Args:
            command (str): the raw command line.
            ast (TSNodeLike | None): the parsed line, whose command
                heads say whether it runs a path; None for none.
            deadline (float | None): the loop time the line's budget
                ends; None for no bound.
        """
        pending = [e for e in self._runtimes.entries if e.programs_pending]
        if not pending:
            return
        heads = command_words(ast) if ast is not None else frozenset()
        if not may_run_program(command, heads):
            return
        try:
            async with asyncio.timeout_at(deadline):
                for entry in pending:
                    await entry.probe_programs()
        except TimeoutError:
            logger.debug("interpreter probe outlasted the line's budget")
        self._runtimes.rebind()

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
        keeps the line in Mirage: no line executor (an ``@line``
        capture) takes it, an interpreter a sandbox took
        (``Runtime.learned``) goes back to the runtime that captures it,
        and each command stays on its first other capturer.
        Any other name places it as the runtime argument does.

        Args:
            entries (list[Runtime]): the workspace's ordered runtimes.
            name (str): the runtime the route names.

        Raises:
            RouteError: no entry has the name.
        """
        if name != WorkspaceRuntime.name:
            return self._placed(entries, name)
        kept = [e for e in entries if WHOLE_LINE not in e.captures]
        bindings: dict[str, Runtime[Any] | None] = {
            command: None
            for entry in entries
            for command in entry.offered_captures
        }
        bindings.update(bind_commands(kept))
        captured = _captured(kept)
        for name, runtime in list(bindings.items()):
            if _learned(runtime, name):
                bindings[name] = captured.get(name)
        return RouteDecision(bindings=bindings, fallback=catch_all(entries))

    def _unplaced(
        self, entries: list[Runtime[Any]]
    ) -> RouteDecision[RuntimeIdentity]:
        """The decision for a line no policy placed: each command on its
        first capturer, kept for the line's nested evals, and each
        interpreter a sandbox took on the first runtime that captures it
        for an invocation that sandbox cannot see (``unserved``).

        Args:
            entries (list[Runtime]): the workspace's ordered runtimes.
        """
        bindings = self._registry.runtime_bindings
        captured = _captured(entries)
        return RouteDecision(
            bindings=dict(bindings),
            fallback=catch_all(entries),
            unserved={
                name: captured[name]
                for name in INTERPRETER_NAMES
                if _learned(bindings.get(name), name) and name in captured
            },
        )

    def runtime_for(
        self, one: Judged, decision: RouteDecision[RuntimeIdentity]
    ) -> str:
        """The runtime entry that serves a command under a decision,
        empty when the workspace runs it itself; judged per invocation
        (``invocation_routing``), as its run will be.

        Args:
            one (Judged): the command's judgment and context.
            decision (RouteDecision): the line's placement.
        """
        whole = whole_line_runtime(decision.bindings)
        if isinstance(whole, Runtime):
            return whole.name
        command = one.judgment.command
        if one.ctx is not None:
            routed = invocation_routing(
                command,
                one.ctx.argv,
                one.ctx.cwd,
                self._registry,
                decision,
                self._namespace,
                one.session,
            )
            assert routed is not None
            decision = routed
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


def _captured(entries: list[Runtime[Any]]) -> dict[str, Runtime[Any]]:
    """Each command on the first entry whose own captures name it, none
    an entry only learned it can run (``Runtime.learned``).

    Args:
        entries (list[Runtime]): ordered runtimes.
    """
    out: dict[str, Runtime[Any]] = {}
    for entry in entries:
        for command in entry.captures:
            out.setdefault(command, entry)
    return out


def _learned(runtime: RuntimeIdentity | None, name: str) -> bool:
    """Whether ``name`` binds to a runtime that learned it can run it
    (``Runtime.learned``), a sandbox holding the interpreter.

    Args:
        runtime (RuntimeIdentity | None): the runtime ``name`` binds to.
        name (str): the command name.
    """
    return isinstance(runtime, Runtime) and runtime.learned(name)
