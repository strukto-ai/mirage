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
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from mirage.context.session_context import (
    Caller,
    CallerToken,
    bind_caller,
    current_caller,
    reset_caller,
)
from mirage.policy.errors import PolicyDenied
from mirage.policy.match import Outcome
from mirage.policy.types import (
    Abandoned,
    Ask,
    Claim,
    Claimant,
    CommandContext,
    CommandRule,
    Decision,
    DecisionOwner,
    Deny,
    DryRun,
    ExecuteResultContext,
    HandOff,
    NetworkContext,
    Occurrence,
    Pending,
    RouteContext,
    Scope,
    SessionDecisionsQuery,
    VfsContext,
)
from mirage.rs.approvals import (
    ApprovalSnapshot,
    approval_query,
    record_wire,
)
from mirage.rs.document import units
from mirage.types import PathSpec, PolicyDecision

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

T = TypeVar("T")


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
    try:
        done, _ = await asyncio.wait(
            {wait_task, cancel_task}, return_when=asyncio.FIRST_COMPLETED
        )
        return wait_task.result() if wait_task in done else ABANDONED
    finally:
        for task in (wait_task, cancel_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(wait_task, cancel_task, return_exceptions=True)


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


def ask_rule(
    ctx: CommandContext
    | RouteContext
    | VfsContext
    | ExecuteResultContext
    | NetworkContext,
    ask: Ask,
) -> CommandRule:
    """The rule an Ask is keyed on: the document's, or for a coded Ask
    one synthesized over what was asked about (the program, the path,
    the line, the host), so a session answer reads "stop asking me
    about this".

    Args:
        ctx (CommandContext | RouteContext | VfsContext |
            ExecuteResultContext | NetworkContext): what the method saw.
        ask (Ask): the policy's answer.
    """
    if ask.rule is not None:
        return ask.rule
    if isinstance(ctx, CommandContext):
        program = " ".join(ctx.program or (ctx.command,))
        return CommandRule(reason=ask.reason, commands=(program,))
    if isinstance(ctx, VfsContext):
        return CommandRule(reason=ask.reason, paths=(ctx.path.virtual,))
    if isinstance(ctx, NetworkContext):
        return CommandRule(
            reason=ask.reason, commands=(ctx.host or ctx.address,)
        )
    return CommandRule(reason=ask.reason, commands=(ctx.line,))


def covers(
    record: Decision, rule: CommandRule, argv: tuple[str, ...], cwd: str
) -> bool:
    return (
        approval_query(
            "covers",
            record=record_wire(
                record, 0, 0 if record.rule == rule else None, argv, cwd
            ),
            rule=0,
        )
        is True
    )


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


def is_pending(decision: PolicyDecision | None) -> bool:
    """Whether a decision record is a question the host has not answered
    yet, which holds the line for its retry rather than ending it.

    Args:
        decision (PolicyDecision | None): the record a result carries.
    """
    return decision is not None and decision.kind == "pending"


def op_question(
    ctx: VfsContext | RouteContext | ExecuteResultContext,
    ask: Ask,
) -> tuple[CommandContext, Ask]:
    """A question about no command as the ledger keys it: no command,
    and the words of its record are what was asked about: the path of a
    VFS call, the line.

    Args:
        ctx (VfsContext | RouteContext | ExecuteResultContext): what the
            method saw.
        ask (Ask): the chain's answer.
    """
    rules = ask.rules or (ask_rule(ctx, ask),)
    keyed = dataclasses.replace(ask, rule=ask.rule or rules[0], rules=rules)
    paths: tuple[PathSpec, ...] = ()
    cwd = ""
    if isinstance(ctx, VfsContext):
        words: tuple[str, ...] = (ctx.path.virtual,)
        paths = (ctx.path,)
    else:
        words = (ctx.line,)
        cwd = ctx.session.cwd() if ctx.session is not None else ""
    asked = CommandContext(
        command="",
        paths=paths,
        argv=words,
        cwd=cwd,
        session_id=ctx.session_id,
    )
    return asked, keyed


class Decisions(DecisionOwner):
    """Drive shared approval decisions over the existing session store.

    Args:
        sessions (SessionDecisionsQuery | None): the session records.
        on_ask (AskHandler | None): the host's optional inline answerer.
    """

    def __init__(
        self,
        sessions: SessionDecisionsQuery | None = None,
        on_ask: AskHandler | None = None,
    ) -> None:
        self._sessions = sessions
        self._on_ask = on_ask
        self._memory: dict[str, tuple[Decision, ...]] = {}
        self._live: dict[str, list[HandOff]] = {}

    def list(self, session_id: str = "") -> tuple[Decision, ...]:
        if session_id:
            return self._records(session_id)
        return tuple(r for key in self._keys() for r in self._records(key))

    def pending(self, session_id: str = "") -> tuple[Decision, ...]:
        return tuple(
            record
            for record in self.list(session_id)
            if record.outcome is None
        )

    async def answer(
        self,
        decision_id: str,
        outcome: Outcome,
        scope: Scope = Scope.ONCE,
        note: str = "",
    ) -> None:
        self._write_answer(decision_id, outcome, scope, note)
        await self._flush()

    def _write_answer(
        self, decision_id: str, outcome: Outcome, scope: Scope, note: str
    ) -> Decision:
        if outcome is Outcome.ASK:
            raise ValueError("ASK is the question, not an answer")
        for session_id in self._keys():
            records = self._records(session_id)
            candidates = tuple(
                record for record in records if record.id == decision_id
            )
            if not candidates:
                continue
            snapshot = ApprovalSnapshot(candidates)
            key: int | None = approval_query(
                "answer",
                records=[
                    {
                        "key": snapshot.record_key(record),
                        "id": units(record.id),
                        "outcome": None
                        if record.outcome is None
                        else record.outcome.value,
                    }
                    for record in candidates
                ],
                id=units(decision_id),
                outcome=outcome.value,
            )
            if key is None:
                continue
            record = snapshot.record_objects[key]
            index = next(i for i, item in enumerate(records) if item is record)
            settled = dataclasses.replace(
                record, outcome=outcome, scope=scope, note=note
            )
            self._set(
                session_id, (*records[:index], settled, *records[index + 1 :])
            )
            return settled
        raise KeyError(decision_id)

    def _plan(
        self, ctx: CommandContext, ask: Ask, claimant: Claimant | None = None
    ) -> tuple[tuple[CommandRule, ...], ApprovalSnapshot, dict[str, Any]]:
        rules = ask.rules or (ask_rule(ctx, ask),)
        argv = (ctx.command, *ctx.argv)
        rule_keys = {rule: index for index, rule in enumerate(rules)}
        known_rules: dict[int, int | None] = {
            id(rule): key for rule, key in rule_keys.items()
        }
        records: list[Decision] = []
        record_rules: list[int] = []
        for record in self._records(ctx.session_id):
            identity = id(record.rule)
            if identity not in known_rules:
                known_rules[identity] = rule_keys.get(record.rule)
            rule_key = known_rules[identity]
            if rule_key is None:
                continue
            records.append(record)
            record_rules.append(rule_key)
        snapshot = ApprovalSnapshot(
            records,
            self._live.get(ctx.session_id, ()),
            None if claimant is None else claimant.line,
        )
        snapshot.wire["records"] = snapshot.records_wire(
            record_rules, argv, ctx.cwd
        )
        caller = (
            None
            if claimant is None
            else {
                "holder": snapshot.holder_key(claimant.line),
                "occurrence": snapshot.occurrence_key(claimant.occurrence),
            }
        )
        plan = snapshot.query(
            "plan",
            rules=[rule_keys[rule] for rule in rules],
            claimant=caller,
        )
        return rules, snapshot, plan

    async def resolve(
        self,
        ctx: CommandContext,
        ask: Ask,
        cancel: asyncio.Event | None = None,
        claimant: Claimant | None = None,
    ) -> Deny | Pending | Abandoned | None:
        rules, snapshot, plan = self._plan(ctx, ask, claimant)
        if plan["denied"] is not None:
            await self._spend(
                ctx.session_id,
                tuple(snapshot.record_objects[key] for key in plan["once"]),
            )
            return Deny(rules[plan["denied"]].reason)
        for position, index in enumerate(plan["missing"]):
            if position == 0:
                key = plan["waiting"][index]
                record = None if key is None else snapshot.record_objects[key]
            else:
                record = self._waiting(
                    ctx, rules[index], (ctx.command, *ctx.argv)
                )
            action = await self._raise(
                ctx,
                rules[index],
                (ctx.command, *ctx.argv),
                cancel,
                claimant,
                record=record,
            )
            if action is not None:
                return action
        if plan["missing"]:
            _, snapshot, plan = self._plan(ctx, ask, claimant)
        if claimant is None:
            await self._spend(
                ctx.session_id,
                tuple(snapshot.record_objects[key] for key in plan["once"]),
            )
        elif plan["claim"] is not None:
            self._apply_claim(
                ctx.session_id, snapshot, claimant, plan["claim"]
            )
        return None

    async def resolve_op(
        self,
        ctx: VfsContext,
        ask: Ask,
        caller: Caller | None = None,
    ) -> Deny | Pending | None:
        if caller is None:
            caller = current_caller()
        if caller.explaining is DryRun.DECIDING:
            return self.held_op(ctx, ask)
        asked, keyed = op_question(ctx, ask)
        call = call_of(caller, self, ctx.session_id)
        claimant = (
            None
            if call is None
            else Claimant(call, Occurrence(None, asked.argv[0], 0, 0))
        )
        said = await self.resolve(asked, keyed, claimant=claimant)
        return Deny(ask.reason) if isinstance(said, Abandoned) else said

    def held_op(self, ctx: VfsContext, ask: Ask) -> Deny | Pending | None:
        return self.held(*op_question(ctx, ask))

    async def within_call(
        self, session_id: str, run: Callable[[HandOff], Awaitable[T]]
    ) -> T:
        outer = get_op_call(self, session_id)
        if outer is not None:
            return await run(outer)
        handed = HandOff()
        token = set_op_call(self, handed, session_id)
        try:
            return await run(handed)
        except PolicyDenied as exc:
            if is_pending(exc.decision):
                self.release(session_id, handed)
            raise
        finally:
            reset_op_call(token)
            await self.revoke(session_id, handed)

    def _claim(
        self, session_id: str, claimant: Claimant, once: tuple[Decision, ...]
    ) -> None:
        if not once:
            return
        snapshot = ApprovalSnapshot(
            (), self._live.get(session_id, ()), claimant.line
        )
        reply = snapshot.query(
            "claim",
            holder=snapshot.holder_key(claimant.line),
            records=[snapshot.record_key(record) for record in once],
        )
        self._apply_claim(session_id, snapshot, claimant, reply)

    def split(
        self, session_id: str, handed: HandOff, scope: Occurrence
    ) -> HandOff:
        job = HandOff(parent=handed.parent, origin=handed.origin)
        snapshot = ApprovalSnapshot((), self._live.get(session_id, ()), handed)
        if not snapshot.claim_objects:
            return job
        keys = snapshot.query(
            "split",
            holder=snapshot.holder_key(handed),
            scope=snapshot.occurrence_key(scope),
        )
        job.claimed.extend(snapshot.claim_objects[key] for key in keys)
        if job.claimed:
            self._live.setdefault(session_id, []).append(job)
        return job

    def hand_up(self, session_id: str, handed: HandOff) -> None:
        parent = handed.parent
        if parent is None:
            raise ValueError("a typed line's claims are spent, not handed up")
        if not handed.claimed and not parent.claimed:
            self.release(session_id, handed)
            return
        snapshot = ApprovalSnapshot((), self._live.get(session_id, ()), handed)
        reply = snapshot.query("hand_up", holder=snapshot.holder_key(handed))
        parent.claimed.extend(
            snapshot.claim_objects[key] for key in reply["claims"]
        )
        handed.claimed.clear()
        self._live[session_id] = [
            snapshot.holder_objects[key] for key in reply["live"]
        ]

    async def revoke(self, session_id: str, handed: HandOff) -> None:
        if not handed.claimed:
            self.release(session_id, handed)
            return
        snapshot = ApprovalSnapshot((), self._live.get(session_id, ()), handed)
        keys = snapshot.query("revoke", holder=snapshot.holder_key(handed))
        await self._spend(
            session_id, tuple(snapshot.record_objects[key] for key in keys)
        )
        self.release(session_id, handed)

    def release(self, session_id: str, handed: HandOff) -> None:
        handed.claimed.clear()
        live = self._live.get(session_id)
        if live is not None:
            self._live[session_id] = [
                holder for holder in live if holder is not handed
            ]

    def held(
        self, ctx: CommandContext, ask: Ask, claimant: Claimant | None = None
    ) -> Deny | Pending | None:
        rules, _, plan = self._plan(ctx, ask, claimant)
        if plan["denied"] is not None:
            return Deny(rules[plan["denied"]].reason)
        if not plan["missing"]:
            return None
        return Pending(
            decision_id(ctx.session_id, ctx.cwd, (ctx.command, *ctx.argv)),
            rules[plan["missing"][0]].reason,
        )

    async def _raise(
        self,
        ctx: CommandContext,
        rule: CommandRule,
        argv: tuple[str, ...],
        cancel: asyncio.Event | None = None,
        claimant: Claimant | None = None,
        record: Decision | None = None,
    ) -> Deny | Pending | Abandoned | None:
        if record is None:
            record = Decision(
                id=decision_id(ctx.session_id, ctx.cwd, argv),
                session_id=ctx.session_id,
                command=ctx.command,
                argv=tuple(ctx.argv),
                cwd=ctx.cwd,
                paths=tuple(path.virtual for path in ctx.paths),
                reason=rule.reason,
                rule=rule,
            )
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
        settled = self._write_answer(
            record.id, said.outcome, said.scope, said.note
        )
        if (
            claimant is not None
            and settled.outcome is Outcome.ALLOW
            and settled.scope is Scope.ONCE
        ):
            self._claim(ctx.session_id, claimant, (settled,))
        await self._flush()
        return Deny(rule.reason) if said.outcome is Outcome.DENY else None

    async def _spend(
        self, session_id: str, spent: tuple[Decision, ...]
    ) -> None:
        if not spent:
            return
        self._set(
            session_id,
            tuple(
                record
                for record in self._records(session_id)
                if not any(record is consumed for consumed in spent)
            ),
        )
        await self._flush()

    def _apply_claim(
        self,
        session_id: str,
        snapshot: ApprovalSnapshot,
        claimant: Claimant,
        reply: dict[str, Any],
    ) -> None:
        if not reply["records"]:
            return
        claimant.line.claimed.extend(
            Claim(claimant.occurrence, snapshot.record_objects[key])
            for key in reply["records"]
        )
        self._live[session_id] = [
            snapshot.holder_objects[key] for key in reply["live"]
        ]

    def _waiting(
        self, ctx: CommandContext, rule: CommandRule, argv: tuple[str, ...]
    ) -> Decision | None:
        records = tuple(
            record
            for record in self._records(ctx.session_id)
            if record.rule == rule
        )
        snapshot = ApprovalSnapshot(records)
        key: int | None = approval_query(
            "waiting",
            records=snapshot.records_wire([0] * len(records), argv, ctx.cwd),
            rule=0,
        )
        return None if key is None else snapshot.record_objects[key]

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


def set_op_call(
    owner: Decisions, handed: HandOff, session_id: str
) -> CallerToken:
    """Bind one call, the unit an op-level answer covers: a file
    tool's, or a line's or a job's, whose session writes are its ops. A
    grant one of its ops is answered by is claimed on ``handed`` for the
    call's other ops on that subject.

    Args:
        owner (Decisions): the ledger the call runs under, the only one
            that claims on ``handed`` and spends it.
        handed (HandOff): the call's hand-off, spent when it ends.
        session_id (str): the session the call runs as.
    """
    return bind_caller(
        current_caller().changed({"call": (owner, handed, session_id)})
    )


def reset_op_call(token: CallerToken) -> None:
    """Restore the previous call binding."""
    reset_caller(token)


def get_op_call(owner: Decisions, session_id: str) -> HandOff | None:
    """The call running in this context under ``owner``'s ledger for
    ``session_id``, None for a bare op, for a call another ledger runs
    (a host callback reaching a second workspace mid-call) or for
    another session's call.

    Args:
        owner (Decisions): the ledger asking.
        session_id (str): the session asking.
    """
    return call_of(current_caller(), owner, session_id)


def call_of(
    caller: Caller, owner: Decisions, session_id: str
) -> HandOff | None:
    """The call ``caller`` runs in under ``owner``'s ledger for
    ``session_id``, None for a bare op, for a call another ledger runs
    or for another session's call.

    Args:
        caller (Caller): who is calling.
        owner (Decisions): the ledger asking.
        session_id (str): the session asking.
    """
    call = caller.call
    if call is None or call[0] is not owner or call[2] != session_id:
        return None
    return call[1]
