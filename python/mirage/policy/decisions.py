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
import hashlib
from collections.abc import Awaitable, Callable, Sequence

from mirage.policy.match import Outcome
from mirage.policy.types import (Abandoned, Ask, CommandContext, CommandRule,
                                 Decision, Deny, Pending, Scope,
                                 SessionDecisionsQuery)

# A host that answers an Ask inside the line.
#
# One argument, where the typescript twin takes a second optional
# AbortSignal. The asymmetry is the runtimes', not a divergence: a
# pending javascript promise cannot be interrupted, so a host there has
# to be handed the run's signal to take its own prompt down, while here
# the wait below cancels the handler's task outright and CancelledError
# arrives inside it at the await it is parked on. Python's own idiom is
# the stronger one, and asking every embedder to grow a parameter to be
# told what cancellation already tells them would be the weaker mirror.
AskHandler = Callable[[Decision], Awaitable[Decision | None]]

ABANDONED = Abandoned()


async def answered(
    start: Callable[[], Awaitable[Decision | None]],
    cancel: asyncio.Event | None,
) -> Decision | None | Abandoned:
    """A host's answer, or the abandonment of the question when the run
    waiting on it is killed first.

    The wait is taken as a thunk so a run already over never starts one:
    nothing should be put to a host on behalf of a line that no longer
    exists. An abandoned wait is cancelled, so an answer that would
    otherwise be recorded against a dead run never arrives, and the
    handler learns of the kill the way any parked coroutine does: as
    CancelledError raised at the await it is sitting on, which a host
    holding a prompt open can catch or clean up after.

    Args:
        start (Callable[[], Awaitable[Decision | None]]): begins the
            wait; called at most once.
        cancel (asyncio.Event | None): the run's kill channel; None
            leaves the wait alone.

    Returns:
        The host's answer, or ABANDONED once the run is gone.
    """
    if cancel is None:
        return await start()
    if cancel.is_set():
        return ABANDONED
    wait_task = asyncio.ensure_future(start())
    cancel_task = asyncio.create_task(cancel.wait())
    done, pending = await asyncio.wait(
        {wait_task, cancel_task},
        return_when=asyncio.FIRST_COMPLETED,
    )
    for task in pending:
        task.cancel()
    if wait_task in done:
        return wait_task.result()
    return ABANDONED


def decision_id(session_id: str, cwd: str, argv: tuple[str, ...]) -> str:
    """The id a record is named by: a digest of what was asked, so a
    retry of the same line quotes the same id and a host answers it
    once.

    The id names the record; it does not decide what a retry matches.
    That comparison is made against the recorded fields themselves
    (:func:`covers`), so a line the digest cannot tell apart from
    another still cannot borrow its answer.

    Args:
        session_id (str): the session running the line.
        cwd (str): its working directory.
        argv (tuple[str, ...]): the line as expanded, command name
            first.
    """
    digest = hashlib.sha256()
    for part in (session_id, cwd, *argv):
        digest.update(part.encode())
        digest.update(b"\0")
    return digest.hexdigest()[:12]


def ask_rule(ctx: CommandContext, ask: Ask) -> CommandRule:
    """The rule an Ask is keyed on: the document's, or for a coded Ask
    one synthesized over the program that asked, so a session answer
    reads "stop asking me about this program".

    Args:
        ctx (CommandContext): the asked line.
        ask (Ask): the policy's answer.
    """
    if ask.rule is not None:
        return ask.rule
    program = " ".join(ctx.program or (ctx.command, ))
    return CommandRule(reason=ask.reason, commands=(program, ))


def covers(record: Decision, rule: CommandRule, argv: tuple[str, ...],
           cwd: str) -> bool:
    """Whether an answered record answers this rule of this line.

    A ONCE answer covers the exact line it was given for, compared
    field by field. A SESSION answer covers every line the same rule
    asks about. Both are keyed on the rule as well as the words: an
    answer that outlives a rule change (a persisted store reopened
    under an edited profile) must not answer the new rule's ask, and a
    stale refusal must not speak in its voice.

    Args:
        record (Decision): the answered record.
        rule (CommandRule): the rule to answer.
        argv (tuple[str, ...]): the line's words, name first.
        cwd (str): the session working directory.
    """
    if record.outcome is None or record.rule != rule:
        return False
    if record.scope is Scope.SESSION:
        return record.outcome is Outcome.ALLOW
    return (record.command, *record.argv) == argv and record.cwd == cwd


class Decisions:
    """The workspace's decision ledger: turns an Ask into run, refuse or
    pending, and is the host's handle on every question raised and every
    answer given.

    One record type, one store. A :class:`Decision` with no outcome is a
    question waiting; one with an outcome is a question settled, and how
    far the answer reaches is its ``scope``. Keeping both in one place is
    the point: they used to be two stores, a pending dict that vanished
    on restart and a per-session answer list that did not, so a host
    could see a question that no longer existed or miss one that did.

    Reached by the executor through the mount registry like the policy
    chain, and by the host as ``ws.decisions``. Records are consulted
    only after the policy chain returned an Ask, which is after every
    Deny had its say, so an answer never re-opens a deny rule. They are
    read and written through the session manager by id, so a line
    running in a fork (``execute(cwd=)``, a background job) consumes and
    earns the same answers as the session it forked from.

    Args:
        sessions (SessionDecisionsQuery | None): where records live: the
            session manager, or None to hold them in memory (a bare
            policy chain outside a workspace).
        on_ask (AskHandler | None): a host that answers inside the line,
            returning the record with an outcome set, or None to leave
            it pending. Omit it and every question is simply recorded,
            which is what a host polling ``list`` wants.
    """

    def __init__(self,
                 sessions: SessionDecisionsQuery | None = None,
                 on_ask: AskHandler | None = None) -> None:
        self._sessions = sessions
        self._on_ask = on_ask
        self._memory: dict[str, tuple[Decision, ...]] = {}

    def list(self, session_id: str = "") -> tuple[Decision, ...]:
        """Every record, oldest first: questions waiting and questions
        settled.

        Args:
            session_id (str): one session, or "" for all of them.
        """
        if session_id:
            return self._records(session_id)
        out: list[Decision] = []
        for key in self._keys():
            out.extend(self._records(key))
        return tuple(out)

    def pending(self, session_id: str = "") -> tuple[Decision, ...]:
        """The records nobody has answered, oldest first.

        Args:
            session_id (str): one session, or "" for all of them.
        """
        return tuple(r for r in self.list(session_id) if r.outcome is None)

    async def answer(self,
                     decision_id: str,
                     outcome: Outcome,
                     scope: Scope = Scope.ONCE,
                     note: str = "") -> None:
        """Answer a waiting record, yes or no.

        ALLOW at ONCE passes the retry of the exact line and is consumed
        by it; at SESSION it passes every line the rule covers for the
        rest of the session. DENY refuses the retry in the deny voice,
        once, and asking again raises a new record.

        Args:
            decision_id (str): the id the agent was told to quote.
            outcome (Outcome): ALLOW or DENY. ASK is the question, not
                an answer.
            scope (Scope): how far the answer reaches.
            note (str): what to record alongside it.

        Raises:
            KeyError: no waiting record has that id.
            ValueError: the outcome is ASK.
        """
        if outcome is Outcome.ASK:
            raise ValueError("ASK is the question, not an answer")
        for key in self._keys():
            records = self._records(key)
            for index, record in enumerate(records):
                if record.id != decision_id or record.outcome is not None:
                    continue
                answered = dataclasses.replace(record,
                                               outcome=outcome,
                                               scope=scope,
                                               note=note)
                self._set(key,
                          (*records[:index], answered, *records[index + 1:]))
                await self._flush()
                return
        raise KeyError(decision_id)

    async def resolve(
        self,
        ctx: CommandContext,
        ask: Ask,
        cancel: asyncio.Event | None = None,
        hand_off: bool = False,
    ) -> Deny | Pending | Abandoned | None:
        """The executor's branch for an Ask: settled records answer it,
        else the question is raised now.

        Every rule the ask names has to be answered, because each won a
        subject of its own and a nod covers the subject it was given
        for. They are asked one at a time, the retry of the line raising
        the next, and a ONCE answer is only spent once the whole line is
        answered: spending one while another is still waiting would make
        the first question come back on every retry. Once the line IS
        answered, every ONCE answer behind it is spent -- the ones
        already on file and the ones a host gave inline moments ago
        alike -- so an answer never outlives the line it was given for.
        The exception is ``hand_off``, for the pass that asks on another
        pass's behalf.

        Args:
            ctx (CommandContext): the asked line.
            ask (Ask): the chain's answer.
            cancel (asyncio.Event | None): the run's kill channel, so a
                question outlives neither its run's deadline nor a
                caller's kill.
            hand_off (bool): True when a later pass on this same line
                will read the ledger after this one -- the env pre-pass
                raises the question and the gate behind it consumes the
                answer -- so an answer given inline is left standing for
                that pass instead of being spent here. False for the
                gate itself, which is the pass that runs the line: an
                answer it was given belongs to the line it was given for
                and to no other.

        Returns:
            None to run the line, a Deny to refuse it, a Pending when
            the host has not decided, an Abandoned for a run killed
            mid-question.
        """
        rules = ask.rules or (ask_rule(ctx, ask), )
        argv = (ctx.command, *ctx.argv)
        held = self._records(ctx.session_id)
        answers = [(rule, self._settled(held, rule, argv, ctx.cwd))
                   for rule in rules]
        spent = tuple(r for _rule, r in answers
                      if r is not None and r.scope is Scope.ONCE)
        refused = next((rule for rule, r in answers
                        if r is not None and r.outcome is Outcome.DENY), None)
        if refused is not None:
            await self._spend(ctx.session_id, spent)
            return Deny(refused.reason)
        for rule, record in answers:
            if record is not None:
                continue
            action = await self._raise(ctx, rule, argv, cancel)
            if action is None:
                continue
            # A refusal the host gave while this line waited refused THIS
            # line, so it is spent by it -- unless a later pass on the
            # same line still has to read it, which is the pass that
            # refuses in place. A question left waiting, or a killed run,
            # answered nothing and spends nothing.
            if isinstance(action, Deny) and not hand_off:
                await self._spend(
                    ctx.session_id,
                    self._once_answers(ctx.session_id, rules, argv, ctx.cwd))
            return action
        # Every rule is answered and the line may run. Unless another pass
        # on this same line is still to come, the ledger is read again
        # rather than trusting the entry snapshot, because a host that
        # answered inline settled its record during the loop above:
        # without that, the grant it gave THIS line would still be
        # standing for the next identical one, and whoever allowed once
        # would have allowed twice.
        await self._spend(
            ctx.session_id, spent if hand_off else self._once_answers(
                ctx.session_id, rules, argv, ctx.cwd))
        return None

    def _once_answers(
        self,
        session_id: str,
        rules: Sequence[CommandRule],
        argv: tuple[str, ...],
        cwd: str,
    ) -> tuple[Decision, ...]:
        """Every ONCE answer standing behind this line, as the ledger
        holds it now.

        Args:
            session_id (str): the asking session.
            rules (Sequence[CommandRule]): the rules the ask named.
            argv (tuple[str, ...]): the line, command name first.
            cwd (str): the directory the line was typed in.

        Returns:
            tuple[Decision, ...]: the settled ONCE records.
        """
        held = self._records(session_id)
        found = (self._settled(held, rule, argv, cwd) for rule in rules)
        return tuple(r for r in found
                     if r is not None and r.scope is Scope.ONCE)

    def held(self, ctx: CommandContext, ask: Ask) -> Deny | Pending | None:
        """What the settled records alone say about an asked line.

        The read-only half of :meth:`resolve`, and the only half a dry
        run may take: it consults what the session already holds and
        stops there, spending nothing, recording no question and never
        reaching the host. So ``explain`` can report that a line would
        be refused, or would still be waiting, without a question
        arriving for a line nobody typed.

        Args:
            ctx (CommandContext): the asked line.
            ask (Ask): the chain's answer.

        Returns:
            None when every rule the ask names is already answered, a
            Deny when a record refuses one, a Pending naming the first
            rule nothing answers.
        """
        argv = (ctx.command, *ctx.argv)
        held = self._records(ctx.session_id)
        answers = [(rule, self._settled(held, rule, argv, ctx.cwd))
                   for rule in (ask.rules or (ask_rule(ctx, ask), ))]
        refused = next((rule for rule, r in answers
                        if r is not None and r.outcome is Outcome.DENY), None)
        if refused is not None:
            return Deny(refused.reason)
        unanswered = next((rule for rule, r in answers if r is None), None)
        if unanswered is None:
            return None
        return Pending(decision_id(ctx.session_id, ctx.cwd, argv),
                       unanswered.reason)

    async def _raise(
        self,
        ctx: CommandContext,
        rule: CommandRule,
        argv: tuple[str, ...],
        cancel: asyncio.Event | None = None,
    ) -> Deny | Pending | Abandoned | None:
        """Record one rule of a line as a question and put it to the
        host, None when the host said yes.

        A question already waiting is reused rather than duplicated, so
        a retry keeps quoting one id.

        The host is given the run's kill channel and the wait is bounded
        by it, because a host that asks a person can take an unbounded
        amount of time and the executor's own cooperative abort checks
        cannot reach inside that wait: without this a killed or
        timed-out run would sit here until somebody answered.

        A run killed mid-question is reported as Abandoned and its
        record is left waiting, with whatever the host eventually says
        dropped rather than recorded: an ALLOW banked against a run that
        is already dead would leave a spent-once grant in the ledger for
        the next identical line to take, with nobody asked.

        Args:
            ctx (CommandContext): the asked line.
            rule (CommandRule): the rule nothing answers.
            argv (tuple[str, ...]): the line's words, name first.
            cancel (asyncio.Event | None): the run's kill channel.
        """
        record = self._waiting(ctx, rule, argv)
        if record is None:
            record = Decision(id=decision_id(ctx.session_id, ctx.cwd, argv),
                              session_id=ctx.session_id,
                              agent_id=ctx.agent_id,
                              command=ctx.command,
                              argv=tuple(ctx.argv),
                              cwd=ctx.cwd,
                              paths=tuple(p.virtual for p in ctx.paths),
                              reason=rule.reason,
                              rule=rule)
            self._add(ctx.session_id, record)
            await self._flush()
        on_ask = self._on_ask
        if on_ask is None:
            return Pending(record.id, rule.reason)
        said = await answered(lambda: on_ask(record), cancel)
        if isinstance(said, Abandoned):
            return said
        if said is None or said.outcome is None:
            return Pending(record.id, rule.reason)
        await self.answer(record.id, said.outcome, said.scope, said.note)
        if said.outcome is Outcome.DENY:
            return Deny(rule.reason)
        return None

    def _waiting(self, ctx: CommandContext, rule: CommandRule,
                 argv: tuple[str, ...]) -> Decision | None:
        """The question already recorded for this rule of this line.

        Args:
            ctx (CommandContext): the asked line.
            rule (CommandRule): the rule nothing answers.
            argv (tuple[str, ...]): the line's words, name first.
        """
        for record in self._records(ctx.session_id):
            if (record.outcome is None and record.rule == rule
                    and (record.command, *record.argv) == argv
                    and record.cwd == ctx.cwd):
                return record
        return None

    @staticmethod
    def _settled(held: tuple[Decision, ...], rule: CommandRule,
                 argv: tuple[str, ...], cwd: str) -> Decision | None:
        """The answered record standing behind one rule of a line, None
        when nobody has answered it.

        Args:
            held (tuple[Decision, ...]): the session's records.
            rule (CommandRule): the rule to answer.
            argv (tuple[str, ...]): the line's words, name first.
            cwd (str): the session working directory.
        """
        for record in held:
            if record.scope is Scope.ONCE and covers(record, rule, argv, cwd):
                return record
        for record in held:
            if record.scope is Scope.SESSION and covers(
                    record, rule, argv, cwd):
                return record
        return None

    async def _spend(self, session_id: str, spent: tuple[Decision,
                                                         ...]) -> None:
        """Drop the ONCE answers this line just used up.

        Args:
            session_id (str): the session running the line.
            spent (tuple[Decision, ...]): the records the line consumed.
        """
        if not spent:
            return
        held = self._records(session_id)
        self._set(session_id,
                  tuple(r for r in held if not any(r is s for s in spent)))
        await self._flush()

    def _keys(self) -> tuple[str, ...]:
        if self._sessions is not None:
            return self._sessions.decision_sessions()
        return tuple(self._memory)

    def _records(self, session_id: str) -> tuple[Decision, ...]:
        if self._sessions is not None:
            return self._sessions.decisions_of(session_id)
        return self._memory.get(session_id, ())

    def _set(self, session_id: str, records: tuple[Decision, ...]) -> None:
        if self._sessions is not None:
            self._sessions.set_decisions(session_id, records)
        else:
            self._memory[session_id] = records

    def _add(self, session_id: str, record: Decision) -> None:
        self._set(session_id, (*self._records(session_id), record))

    async def _flush(self) -> None:
        if self._sessions is not None:
            await self._sessions.flush()
