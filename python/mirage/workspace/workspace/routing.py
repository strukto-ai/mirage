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
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from mirage.commands.config import Context
from mirage.policy.decisions import op_question
from mirage.policy.policies import agreed, command_route, settled
from mirage.policy.types import (
    Abandoned,
    Ask,
    Claimant,
    CommandContext,
    Deny,
    Occurrence,
    Pending,
    PolicyCaller,
    Route,
    RouteContext,
)
from mirage.runtime.base import Runtime
from mirage.runtime.constants import EXTERNAL_COMMANDS, WHOLE_LINE
from mirage.runtime.routing import RouteError
from mirage.runtime.table import (
    catch_all,
    routed,
    runtime_bindings_for,
    whole_line_runtime,
)
from mirage.runtime.types import RouteDecision, RuntimeIdentity
from mirage.runtime.workspace import WorkspaceRuntime
from mirage.utils.abort import MirageAbortError
from mirage.view.types import FileView, SessionView
from mirage.workspace.lookup.constants import PROGRAM_WRAPPERS
from mirage.workspace.lookup.lookup import (
    mirage_program_at,
    routed_consumer,
    wrapper_runs_outside,
)
from mirage.workspace.lookup.types import Consumer
from mirage.workspace.mount import MountRegistry
from mirage.workspace.node.explain import (
    Judged,
    Walked,
    refused_where_it_stands,
)
from mirage.workspace.node.inner_lines import Word, inner_lines
from mirage.workspace.node.occurrence import argv_frame, whole_occurrence
from mirage.workspace.session import SessionState
from mirage.workspace.workspace.runtimes import Runtimes

logger = logging.getLogger(__name__)


def _machine_of(
    runtime: Runtime[Any], decision: RouteDecision[RuntimeIdentity]
) -> str:
    """The machine a runtime would run a command on under a decision, as
    its id; empty for the workspace's own.

    Args:
        runtime (Runtime): the runtime serving the command.
        decision (RouteDecision): the placement.
    """
    try:
        machine = runtime.machine_for(Context(machine=decision.machine))
    except ValueError as exc:
        logger.debug("%s: no machine to explain: %s", runtime.name, exc)
        return ""
    return "" if machine is None else str(machine)


def _apart(
    decision: RouteDecision[RuntimeIdentity],
) -> RouteDecision[RuntimeIdentity]:
    """A decision as it places each command on its own, its whole-line
    runtime left out.

    Args:
        decision (RouteDecision): the placement.
    """
    return dataclasses.replace(
        decision,
        bindings={
            name: runtime
            for name, runtime in decision.bindings.items()
            if name != WHOLE_LINE
        },
    )


def _wrapped_programs(
    words: Sequence[Word],
    occurrence: Occurrence,
    by_place: Mapping[Occurrence, Judged],
) -> list[Judged]:
    """The judged commands a wrapper's run answers for, as the run walks
    them: a shell line under the wrapper is the machine's to run, so what
    it names places nothing.

    Args:
        words (Sequence[Word]): the wrapper's words, name first.
        occurrence (Occurrence): its place on the line.
        by_place (Mapping[Occurrence, Judged]): the line's judged commands.
    """
    found: list[Judged] = []
    for inner in inner_lines(words[0].value, words[1:]):
        if not inner.argv:
            continue
        place = whole_occurrence(
            argv_frame([w.value for w in inner.argv], occurrence)
        )
        held = by_place.get(place)
        if held is not None:
            found.append(held)
            found.extend(_wrapped_programs(inner.argv, place, by_place))
    return found


def _programs_of(
    one: Judged, by_place: Mapping[Occurrence, Judged]
) -> list[Judged]:
    """The judged commands a wrapper's run answers for; none for any
    other command.

    Args:
        one (Judged): the command.
        by_place (Mapping[Occurrence, Judged]): the line's judged commands.
    """
    command = one.judgment.command
    if command not in PROGRAM_WRAPPERS or one.ctx is None:
        return []
    return _wrapped_programs(
        [Word(w, w) for w in (command, *one.ctx.argv)],
        one.occurrence,
        by_place,
    )


class Router:
    """Decides which runtime a typed line routes to.

    The order is: an inherited decision, then the ``execute()`` runtime
    and machine arguments, then the placement stage (``pre_execute``: the configured
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
        machine: str | None,
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
            machine (str | None): the execute() machine argument, which
                wins over the policy as the runtime does.
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
            RouteError: an unknown runtime or machine name or a failing
                policy.
            MirageAbortError: the run was killed while the host decided.
        """
        if inherited is not None:
            return inherited
        entries = self._runtimes.entries
        policies = self._registry.policies
        placing = await policies.wants_for("pre_execute", session.session_id)
        placed = (
            None
            if runtime is None and machine is None
            else self._placed(entries, runtime, machine)
        )
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
            return self._routed(entries, route)
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
            RouteError: an unknown runtime or machine name or a failing
                policy.
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
            return answers, self._routed(entries, winner)
        return answers, self._unplaced(entries)

    def _routed(
        self, entries: list[Runtime[Any]], route: Route
    ) -> RouteDecision[RuntimeIdentity]:
        """The decision a policy's route places a line on (``routed``).

        Args:
            entries (list[Runtime]): the workspace's ordered runtimes.
            route (Route): the runtime and machine the route names.

        Raises:
            RouteError: no entry or machine has the name.
        """
        self._known_machine(route.machine)
        try:
            return routed(
                entries,
                self._registry.runtime_bindings,
                route.runtime,
                route.machine,
            )
        except ValueError as exc:
            raise RouteError(str(exc)) from exc

    def _known_machine(self, machine: str | None) -> None:
        """Refuse a machine the workspace does not have.

        Args:
            machine (str | None): the machine a placement names.

        Raises:
            RouteError: no machine has the name.
        """
        if machine is None:
            return
        try:
            self._runtimes.machines.get(machine)
        except ValueError as exc:
            raise RouteError(str(exc)) from exc

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

    def placement_for(
        self,
        one: Judged,
        decision: RouteDecision[RuntimeIdentity],
        programs: Sequence[Judged] = (),
    ) -> tuple[str, str]:
        """The runtime entry that serves a command under a decision, as
        its run places it, and the machine it runs there on: the
        ``@external`` runtime for a program no name binds (a path runs
        through the workspace's exec path first); both empty when the
        workspace runs it itself. A ``pre_command`` route of the command
        places it over the line's decision, as its run does, and so does
        the route of a program a wrapper takes along to a runtime.

        Args:
            one (Judged): the command's judgment and the session it was
                judged in.
            decision (RouteDecision): the line's placement.
            programs (Sequence[Judged]): the commands a wrapper's run
                answers for, outermost first.
        """
        whole = whole_line_runtime(decision.bindings)
        if isinstance(whole, Runtime):
            return whole.name, _machine_of(whole, decision)
        decision = self._own_placed(one, decision)
        answer = self._wrapper_answer(one, decision, programs)
        if isinstance(answer, Route):
            decision = routed(
                self._runtimes.entries,
                decision.bindings,
                answer.runtime,
                answer.machine or decision.machine,
            )
        return self._serving(one, decision)

    def _own_placed(
        self, one: Judged, decision: RouteDecision[RuntimeIdentity]
    ) -> RouteDecision[RuntimeIdentity]:
        """A decision with a command's own ``pre_command`` route over it.

        Args:
            one (Judged): the command.
            decision (RouteDecision): the placement it runs under.
        """
        route = command_route(one.judgment.answers)
        if route is None:
            return decision
        return routed(
            self._runtimes.entries,
            decision.bindings,
            route.runtime,
            route.machine or decision.machine,
        )

    def _wrapper_answer(
        self,
        one: Judged,
        decision: RouteDecision[RuntimeIdentity],
        programs: Sequence[Judged],
    ) -> Deny | Route | None:
        """What the routes answering for a wrapper a runtime takes and
        for the programs its run judges come to, as its run settles them;
        None for any other command.

        Args:
            one (Judged): the command.
            decision (RouteDecision): its placement, its own route in it.
            programs (Sequence[Judged]): the commands its run answers for.
        """
        if (
            one.ctx is None
            or one.session is None
            or not wrapper_runs_outside(
                one.judgment.command,
                one.ctx.argv,
                one.session,
                self._registry,
                decision,
            )
        ):
            return None
        routes = [
            command_route(held.judgment.answers) for held in (one, *programs)
        ]
        return agreed([route for route in routes if route is not None])

    def _outer_placed(
        self,
        one: Judged,
        by_place: Mapping[Occurrence, Judged],
        decision: RouteDecision[RuntimeIdentity],
    ) -> RouteDecision[RuntimeIdentity]:
        """The placement a command runs under: its line's, with the route
        of each command running it (``eval``) over that, as its run keeps
        it.

        Args:
            one (Judged): the command.
            by_place (Mapping[Occurrence, Judged]): the line's judged
                commands.
            decision (RouteDecision): the line's placement.
        """
        outer: list[Judged] = []
        at = one.occurrence.parent
        while at is not None:
            held = by_place.get(at)
            if held is not None:
                outer.append(held)
            at = at.parent
        for held in reversed(outer):
            decision = self._own_placed(held, decision)
        return decision

    def refuse_disagreeing(
        self,
        judged: Sequence[Judged],
        decision: RouteDecision[RuntimeIdentity],
    ) -> list[Judged]:
        """A line's judged commands, each wrapper whose routes one run
        cannot honor refused at its own node, as its run refuses it. A
        wrapper or program its gate stops keeps that answer: the run
        stops there before it compares routes.

        Args:
            judged (Sequence[Judged]): the line's judged commands.
            decision (RouteDecision): the line's placement.
        """
        by_place = {one.occurrence: one for one in judged}
        kept: list[Judged] = []
        for one in judged:
            programs = _programs_of(one, by_place)
            answer = (
                self._wrapper_answer(
                    one,
                    self._own_placed(
                        one, self._outer_placed(one, by_place, decision)
                    ),
                    programs,
                )
                if programs
                and not any(
                    held.judgment.exit_code for held in (one, *programs)
                )
                else None
            )
            kept.append(
                refused_where_it_stands(one, answer)
                if isinstance(answer, Deny)
                else one
            )
        return kept

    def placements(
        self,
        judged: Sequence[Judged],
        decision: RouteDecision[RuntimeIdentity],
    ) -> Callable[[Judged], tuple[str, str]]:
        """``placement_for`` for each of a line's judged commands, one a
        line runs in turn (``eval``) under the placement a
        ``pre_command`` route gave the command running it, as its run
        keeps it.

        Args:
            judged (Sequence[Judged]): the line's judged commands.
            decision (RouteDecision): the line's placement.
        """
        by_place = {one.occurrence: one for one in judged}

        def placed(one: Judged) -> tuple[str, str]:
            return self.placement_for(
                one,
                self._outer_placed(one, by_place, decision),
                _programs_of(one, by_place),
            )

        return placed

    def off_line(
        self, one: Judged, decision: RouteDecision[RuntimeIdentity]
    ) -> bool:
        """Whether a command's ``pre_command`` route places it off the
        runtime or machine its line runs whole on, which that one run
        cannot honor: a route that leaves the command where it stands
        (a runtime that does not capture it) holds.

        Args:
            one (Judged): the command's judgment and the session it was
                judged in.
            decision (RouteDecision): the line's placement.

        Raises:
            RouteError: the route names no runtime entry.
        """
        route = command_route(one.judgment.answers)
        whole = whole_line_runtime(decision.bindings)
        if route is None or not isinstance(whole, Runtime):
            return False
        try:
            placed = routed(
                self._runtimes.entries,
                decision.bindings,
                route.runtime,
                route.machine or decision.machine,
            )
        except ValueError as exc:
            raise RouteError(str(exc)) from exc
        return (
            whole_line_runtime(placed.bindings) is not whole
            or _machine_of(whole, placed) != _machine_of(whole, decision)
            or self._serving(one, _apart(placed))
            != self._serving(one, _apart(decision))
        )

    def _serving(
        self, one: Judged, decision: RouteDecision[RuntimeIdentity]
    ) -> tuple[str, str]:
        """The runtime entry and machine that serve a command under a
        decision that places each command on its own, as
        ``placement_for`` answers them.

        Args:
            one (Judged): the command's judgment and the session it was
                judged in.
            decision (RouteDecision): the placement.
        """
        command = one.judgment.command
        fallback = decision.fallback
        if one.ctx is not None and one.session is not None:
            if (
                mirage_program_at(
                    command,
                    one.ctx.argv,
                    one.session,
                    self._registry,
                    decision,
                )
                is not None
            ):
                return "", ""
            consumer, rerouted = routed_consumer(
                command, one.ctx.argv, one.session, self._registry, decision
            )
            decision = rerouted or decision
            if consumer is Consumer.EXTERNAL and "/" not in command:
                fallback = decision.bindings.get(EXTERNAL_COMMANDS)
        serving = decision.bindings.get(command, fallback)
        if not isinstance(serving, Runtime) or isinstance(
            serving, WorkspaceRuntime
        ):
            return "", ""
        return serving.name, _machine_of(serving, decision)

    def _placed(
        self,
        entries: list[Runtime[Any]],
        name: str | None,
        machine: str | None,
    ) -> RouteDecision[RuntimeIdentity]:
        """The decision that serves a line on one named runtime, its
        captures over the static bindings, on one named machine.

        Args:
            entries (list[Runtime]): the workspace's ordered runtimes.
            name (str | None): the runtime entry the line is placed on;
                None leaves each command on its first capturer.
            machine (str | None): the machine it runs on.

        Raises:
            RouteError: no entry or machine has the name, or the runtime
                cannot be selected.
        """
        self._known_machine(machine)
        try:
            overlay = (
                {} if name is None else runtime_bindings_for(entries, name)
            )
        except ValueError as exc:
            raise RouteError(str(exc)) from exc
        return RouteDecision(
            bindings={**self._registry.runtime_bindings, **overlay},
            fallback=catch_all(entries),
            machine=machine,
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
