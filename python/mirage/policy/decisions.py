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
from mirage.policy.types import (Abandoned, Ask, Claim, Claimant,
                                 CommandContext, CommandRule, Decision, Deny,
                                 HandOff, Occurrence, Pending, Scope,
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


def lineage(handed: HandOff | None) -> tuple[HandOff, ...]:
    """A hand-off and every line it was evaluated from, innermost
    first; empty outside a line.

    Args:
        handed (HandOff | None): the reading line's hand-off.
    """
    out: list[HandOff] = []
    while handed is not None:
        out.append(handed)
        handed = handed.parent
    return tuple(out)


def encloses(scope: Occurrence, occurrence: Occurrence) -> bool:
    """Whether a command stands inside a scope: within the scope's span
    of the same text, or on a line evaluated from a node that does.

    Args:
        scope (Occurrence): the enclosing node, a background job's.
        occurrence (Occurrence): the command's place.
    """
    within: Occurrence | None = occurrence
    while within is not None:
        if within.parent == scope.parent and within.source == scope.source:
            return scope.start <= within.start and within.end <= scope.end
        within = within.parent
    return False


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
        # The hand-offs holding a claim, per session: a reservation is
        # a fact about a line running in this process, so it lives here
        # and not in the store the records persist to.
        self._live: dict[str, list[HandOff]] = {}

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

        ALLOW at ONCE passes the one line it was given for and is
        consumed by it -- the line that asked, when the host answers
        while it waits, or that line's retry when the answer comes
        later; at SESSION it passes every line the rule covers for the
        rest of the session. DENY refuses the retry of the line in the
        deny voice, once, whether the host answered inline or later,
        and asking again raises a new record.

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
        self._write_answer(decision_id, outcome, scope, note)
        await self._flush()

    def _write_answer(self, decision_id: str, outcome: Outcome, scope: Scope,
                      note: str) -> Decision:
        """Settle a waiting record in the session's records, leaving the
        store to be flushed by the caller.

        Synchronous on purpose: the records change and nothing yields,
        so a line that answered inline can claim the grant in the same
        step (:meth:`_raise`), and a line judged while the flush then
        waits on the store finds it claimed rather than standing.

        Args:
            decision_id (str): the id the agent was told to quote.
            outcome (Outcome): ALLOW or DENY.
            scope (Scope): how far the answer reaches.
            note (str): what to record alongside it.

        Returns:
            The settled record.

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
                return answered
        raise KeyError(decision_id)

    async def resolve(
        self,
        ctx: CommandContext,
        ask: Ask,
        cancel: asyncio.Event | None = None,
        claimant: Claimant | None = None,
    ) -> Deny | Pending | Abandoned | None:
        """The executor's branch for an Ask: settled records answer it,
        else the question is raised now.

        Every rule the ask names has to be answered, because each won a
        subject of its own and a nod covers the subject it was given
        for. They are asked one at a time, the retry of the line raising
        the next, and a ONCE grant is only spent once the whole line is
        answered: spending one while another is still waiting would make
        the first question come back on every retry. Once the line IS
        answered, every ONCE grant behind it, the ones already on file
        and the one a host gave inline moments ago alike, is the line's.
        Off a line it is spent here, so a nod never outlives the line it
        was given for. On a line it is claimed on the line's hand-off for
        the reader's occurrence instead, whether the reader is a pass
        that judges the line before it runs or the gate that runs it,
        and spent when the line ends (:meth:`revoke`): the pass and the
        gate then read one claim, so a compound line costs one question
        per run rather than one per reader, and a gate the run reaches
        again at the same place (a loop body, the next batch ``xargs``
        hands on) runs on the same nod rather than asking after the
        rest of the body already ran once more.

        A refusal is deliberately not spent by the line it was given
        for. The record stands to refuse the agent's immediate retry of
        the same line from the ledger, and is spent by that retry, so a
        human who said no is not asked twice about it; the run after
        that is an open question again.

        Args:
            ctx (CommandContext): the asked line.
            ask (Ask): the chain's answer.
            cancel (asyncio.Event | None): the run's kill channel, so a
                question outlives neither its run's deadline nor a
                caller's kill.
            claimant (Claimant | None): the reading command and its
                line, None outside a line (a bare chain). A claimed
                grant is on offer to a reader at the occurrence it was
                claimed for, on the same line or one evaluated from it,
                and to nobody else: not to another spelling of the
                command on the line, and not to another line judged at
                the same time.

        Returns:
            None to run the line, a Deny to refuse it, a Pending when
            the host has not decided, an Abandoned for a run killed
            mid-question.
        """
        rules = ask.rules or (ask_rule(ctx, ask), )
        argv = (ctx.command, *ctx.argv)
        held = self._standing(ctx.session_id, claimant)
        answers = [(rule, self._settled(held, rule, argv, ctx.cwd))
                   for rule in rules]
        refused = next((rule for rule, r in answers
                        if r is not None and r.outcome is Outcome.DENY), None)
        if refused is not None:
            # A standing refusal refuses this line in place, whichever
            # pass reads it: a line that does not run has no later pass
            # to hand anything to.
            await self._spend(
                ctx.session_id,
                tuple(r for _rule, r in answers
                      if r is not None and r.scope is Scope.ONCE))
            return Deny(refused.reason)
        for rule, record in answers:
            if record is not None:
                continue
            action = await self._raise(ctx, rule, argv, cancel, claimant)
            if action is not None:
                return action
        # Every rule is answered and the line may run. The ledger is read
        # again rather than trusting the entry snapshot, because a host
        # that answered inline settled its record during the loop above
        # (and, on a line, _raise has already claimed it): without the
        # re-read, the grant it gave THIS line would still be standing
        # for the next identical one, and whoever allowed once would have
        # allowed twice.
        once = self._once_answers(ctx.session_id, rules, argv, ctx.cwd,
                                  claimant)
        if claimant is None:
            await self._spend(ctx.session_id, once)
            return None
        self._claim(ctx.session_id, claimant, once)
        return None

    def _claim(self, session_id: str, claimant: Claimant,
               once: tuple[Decision, ...]) -> None:
        """Bind the grants behind a command to its place on the line,
        for the line's end to spend.

        A grant the line already holds for this place, claimed by its
        pass or by an earlier visit of the same gate, is left as it is:
        the reader found it through that claim, and a second claim would
        say nothing new. What is new is claimed on the reader's own
        hand-off, which goes live with it, so every other line of the
        session stops seeing the grant until this one ends.

        Args:
            session_id (str): the asking session.
            claimant (Claimant): the reading command and its line.
            once (tuple[Decision, ...]): the settled ONCE records
                standing behind the command as this reader sees them.
        """
        handed = claimant.line
        held = [c.decision for h in lineage(handed) for c in h.claimed]
        fresh = [r for r in once if not any(r is h for h in held)]
        if not fresh:
            return
        handed.claimed.extend(Claim(claimant.occurrence, r) for r in fresh)
        live = self._live.setdefault(session_id, [])
        if not any(h is handed for h in live):
            live.append(handed)

    def split(self, session_id: str, handed: HandOff,
              scope: Occurrence) -> HandOff:
        """Share the claims made for one part of a line with a run of
        its own: a background job, whose gates run after the line has
        returned and which ends on its own clock.

        Every claim standing inside the scope, on the line or a line it
        was evaluated from, is copied onto the new hand-off, and the
        line keeps its own: a grant is spent when the last hand-off
        holding it ends (:meth:`revoke`), so the line's end, a release
        for a question still waiting included, leaves the job's copy
        standing and hidden from every other line, and a loop that
        launches the same job again hands the next job a copy of the
        same grant. Moving the claim instead left the second job with
        nothing, and it asked again after it had already been launched;
        sharing one hand-off between line and job let a release for a
        pending foreground gate let go of the job's grants with the
        rest, and a line judged while the job slept could take them.

        Args:
            session_id (str): the session the line was judged in.
            handed (HandOff): the line's hand-off.
            scope (Occurrence): the job's node on the line.

        Returns:
            The job's hand-off, live while it holds a claim.
        """
        job = HandOff(parent=handed.parent, origin=handed.origin)
        for owner in lineage(handed):
            for claim in owner.claimed:
                if encloses(scope, claim.occurrence) and not any(
                        c.decision is claim.decision for c in job.claimed):
                    job.claimed.append(claim)
        if job.claimed:
            self._live.setdefault(session_id, []).append(job)
        return job

    def hand_up(self, session_id: str, handed: HandOff) -> None:
        """Leave a nested line's claims with the line it was evaluated
        from, at the line's end.

        A line the executor evaluates from inside another (``$( )``,
        ``eval``, a batch ``xargs`` hands on, the line an alias
        rewrites to) ends before the outer line does, and what its
        gates claimed is the outer line's: the next evaluation from the
        same node (the next batch, the next iteration of a loop around
        the ``eval``) stands at the same occurrence and runs on it, and
        the typed line's end spends it. Spending here instead asked
        again for every batch.

        Args:
            session_id (str): the session the line was judged in.
            handed (HandOff): the nested line's hand-off, whose
                ``parent`` is the line it was evaluated from.

        Raises:
            ValueError: the hand-off is a typed line's, whose claims are
                spent (:meth:`revoke`), not handed up.
        """
        parent = handed.parent
        if parent is None:
            raise ValueError("a typed line's claims are spent, not handed up")
        known = [c.decision for c in parent.claimed]
        parent.claimed.extend(c for c in handed.claimed
                              if not any(c.decision is k for k in known))
        live = self._live.setdefault(session_id, [])
        if parent.claimed and not any(h is parent for h in live):
            live.append(parent)
        self.release(session_id, handed)

    async def revoke(self, session_id: str, handed: HandOff) -> None:
        """Spend every grant claimed on a hand-off that no other live
        hand-off still holds: the line's end.

        The claims in :meth:`resolve` leave the grants behind a line's
        commands standing while the line runs, each bound to the place
        it was given for, and this is where they are spent, however the
        line ended: run to completion, refused by the pass on a later
        command, failed on a fetch before the run, killed, or
        short-circuited past the command. Left standing, a grant would
        pass the next line spelling that command on a nod given to this
        one, so the executor calls this whichever way a typed line or a
        job ends, except when a line is held on a question still
        waiting (:meth:`release`); a nested evaluation hands its claims
        up instead (:meth:`hand_up`). A grant a job launched from the
        line still holds a copy of (:meth:`split`) is left standing for
        the job's own end to spend. A grant already gone from the ledger
        is passed over; the hand-off is emptied so a second call is a
        no-op.

        Args:
            session_id (str): the session the line was judged in.
            handed (HandOff): the line's hand-off.
        """
        elsewhere = [
            c.decision for other in self._live.get(session_id, ())
            if other is not handed for c in other.claimed
        ]
        await self._spend(
            session_id,
            tuple(c.decision for c in handed.claimed
                  if not any(c.decision is e for e in elsewhere)))
        self.release(session_id, handed)

    def release(self, session_id: str, handed: HandOff) -> None:
        """Let go of a hand-off's claims without spending them.

        For a line held on a question still waiting: its retry is a new
        line with a hand-off of its own, and it has to find the grants
        this one claimed standing, or the human is asked again for what
        they already allowed. Left live, the held line would hide them
        from every line after it.

        Args:
            session_id (str): the session the line was judged in.
            handed (HandOff): the line's hand-off.
        """
        handed.claimed.clear()
        live = self._live.get(session_id, [])
        self._live[session_id] = [h for h in live if h is not handed]

    def _standing(self, session_id: str,
                  claimant: Claimant | None) -> tuple[Decision, ...]:
        """The session's records as one reader may see them.

        A claimed grant is on offer to exactly one place: the command it
        was claimed for, read on the line that claimed it, a line
        evaluated from that line, or a job launched from it holding a
        copy of the claim, whether the pass or the gate is reading.
        Every other claim is hidden. A grant claimed by another line is
        that line's to run on, and reading it here would let two lines
        judged at once both pass on one nod, the second of them running
        its earlier commands before its gate found the grant gone. A
        grant claimed for another occurrence on this line is that
        occurrence's: reading it would let a word that expands at run
        time into the same command run on the nod a literal spelling
        was given, and would let one nod answer two spellings. A pass
        re-reading an occurrence its outer line's pass already claimed
        finds it answered, which is how a nested line runs on the outer
        line's questions rather than asking them again.

        Args:
            session_id (str): the asking session.
            claimant (Claimant | None): the reading command and its
                line, None outside a line.
        """
        held = self._records(session_id)
        live = self._live.get(session_id, ())
        if not live:
            return held
        offered: list[Decision] = []
        if claimant is not None:
            offered = [
                c.decision for h in lineage(claimant.line) for c in h.claimed
                if c.occurrence == claimant.occurrence
            ]
        taken = [
            c.decision for other in live for c in other.claimed
            if not any(c.decision is o for o in offered)
        ]
        if not taken:
            return held
        return tuple(r for r in held if not any(r is t for t in taken))

    def _once_answers(
        self,
        session_id: str,
        rules: Sequence[CommandRule],
        argv: tuple[str, ...],
        cwd: str,
        claimant: Claimant | None,
    ) -> tuple[Decision, ...]:
        """Every ONCE answer standing behind this line, as the ledger
        holds it now.

        Args:
            session_id (str): the asking session.
            rules (Sequence[CommandRule]): the rules the ask named.
            argv (tuple[str, ...]): the line, command name first.
            cwd (str): the directory the line was typed in.
            claimant (Claimant | None): the reading command and its
                line.

        Returns:
            tuple[Decision, ...]: the settled ONCE records.
        """
        held = self._standing(session_id, claimant)
        found = (self._settled(held, rule, argv, cwd) for rule in rules)
        return tuple(r for r in found
                     if r is not None and r.scope is Scope.ONCE)

    def held(self,
             ctx: CommandContext,
             ask: Ask,
             claimant: Claimant | None = None) -> Deny | Pending | None:
        """What the settled records alone say about an asked line.

        The read-only half of :meth:`resolve`, and the only half a dry
        run may take: it consults what the session already holds and
        stops there, spending nothing, recording no question and never
        reaching the host. So ``explain`` can report that a line would
        be refused, or would still be waiting, without a question
        arriving for a line nobody typed. It reads through the same
        reservations a run does, so a grant a live line has claimed
        reads as waiting here exactly as a run would find it.

        Args:
            ctx (CommandContext): the asked line.
            ask (Ask): the chain's answer.
            claimant (Claimant | None): the reading command and its
                line, None for a dry run outside any line.

        Returns:
            None when every rule the ask names is already answered, a
            Deny when a record refuses one, a Pending naming the first
            rule nothing answers.
        """
        argv = (ctx.command, *ctx.argv)
        held = self._standing(ctx.session_id, claimant)
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
        claimant: Claimant | None = None,
    ) -> Deny | Pending | Abandoned | None:
        """Record one rule of a line as a question and put it to the
        host, None when the host said yes.

        A question already waiting is reused rather than duplicated, so
        a retry keeps quoting one id.

        A ONCE grant the host gives is claimed for the asking command in
        the same step that records it, before the store is flushed. The
        write to the records is synchronous and the flush is not, and
        a line judged while the flush waited on a persistent store found
        the grant standing, claimed it and ran on it, while this line,
        resuming to find its own nod claimed by another, ran on nothing:
        one nod, two runs. Claimed first, the grant is hidden from the
        other line, which asks for itself.

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
            claimant (Claimant | None): the asking command and its line,
                None outside a line.
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
        settled = self._write_answer(record.id, said.outcome, said.scope,
                                     said.note)
        if (claimant is not None and settled.outcome is Outcome.ALLOW
                and settled.scope is Scope.ONCE):
            self._claim(ctx.session_id, claimant, (settled, ))
        await self._flush()
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
