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
import builtins
import dataclasses
import hashlib
import json
import logging
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, TypeVar
from weakref import WeakKeyDictionary, WeakSet

from mirage.context.session_context import (
    Caller,
    CallerToken,
    bind_caller,
    current_caller,
    reset_caller,
)
from mirage.policy.errors import ApprovalUnavailable, PolicyDenied
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
    Occurrence,
    Pending,
    RouteContext,
    Scope,
    SessionContext,
    SessionDecisionsQuery,
    VfsContext,
)
from mirage.rs.policy import from_units, rule_wire, units
from mirage.rs.stream import close_stream, open_stream
from mirage.types import PathSpec, Refusal
from mirage.utils.ids import authority_id

logger = logging.getLogger(__name__)

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
    | SessionContext,
    ask: Ask,
) -> CommandRule:
    """The rule an Ask is keyed on: the document's, or for a coded Ask
    one synthesized over what was asked about (the program, the path,
    the line, the variable), so a session answer reads "stop asking me
    about this".

    Args:
        ctx (CommandContext | RouteContext | VfsContext |
            ExecuteResultContext | SessionContext): what the method saw.
        ask (Ask): the policy's answer.
    """
    if ask.rule is not None:
        return ask.rule
    if isinstance(ctx, CommandContext):
        program = " ".join(ctx.program or (ctx.command,))
        return CommandRule(reason=ask.reason, commands=(program,))
    if isinstance(ctx, VfsContext):
        return CommandRule(reason=ask.reason, paths=(ctx.path.virtual,))
    if isinstance(ctx, SessionContext):
        return CommandRule(reason=ask.reason, commands=(ctx.key,))
    return CommandRule(reason=ask.reason, commands=(ctx.line,))


def covers(
    record: Decision, rule: CommandRule, argv: tuple[str, ...], cwd: str
) -> bool:
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
    question = dataclasses.replace(
        record, command=argv[0], argv=argv[1:], cwd=cwd
    )
    result = inspect_approval(
        empty_ledger("inspection"),
        {
            "op": "inspect",
            "query": {
                "kind": "covers",
                "record": decision_wire(record),
                "rule": rule_wire(rule),
                "question": decision_wire(question),
            },
        },
    )
    if result["kind"] != "matches":
        raise RuntimeError("invalid approval comparison")
    return bool(result["matched"])


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
    result = inspect_approval(
        empty_ledger("inspection"),
        {
            "op": "inspect",
            "query": {
                "kind": "encloses",
                "scope": occurrence_wire(scope),
                "occurrence": occurrence_wire(occurrence),
            },
        },
    )
    if result["kind"] != "matches":
        raise RuntimeError("invalid approval comparison")
    return bool(result["matched"])


def is_pending(refusal: Refusal | None) -> bool:
    """Whether a refusal record is a question the host has not answered
    yet, which holds the line for its retry rather than ending it.

    Args:
        refusal (Refusal | None): the record a result carries.
    """
    return refusal is not None and refusal.kind == "pending"


def op_question(
    ctx: VfsContext | SessionContext | RouteContext | ExecuteResultContext,
    ask: Ask,
) -> tuple[CommandContext, Ask]:
    """A question about no command as the ledger keys it: no command,
    and the words of its record are what was asked about: the path of a
    VFS call, the variable a session write sets with the value it
    writes, the line.

    Args:
        ctx (VfsContext | SessionContext | RouteContext |
            ExecuteResultContext): what the method saw.
        ask (Ask): the chain's answer.
    """
    rules = ask.rules or (ask_rule(ctx, ask),)
    keyed = dataclasses.replace(ask, rule=ask.rule or rules[0], rules=rules)
    paths: tuple[PathSpec, ...] = ()
    cwd = ""
    if isinstance(ctx, VfsContext):
        words: tuple[str, ...] = (ctx.path.virtual,)
        paths = (ctx.path,)
    elif isinstance(ctx, SessionContext):
        words = (ctx.key,) if ctx.value is None else (ctx.key, ctx.value)
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


def empty_ledger(incarnation: str) -> dict[str, Any]:
    return {
        "version": 1,
        "incarnation": incarnation,
        "revision": 0,
        "records": [],
        "claims": [],
        "holders": [],
        "receipts": [],
        "retired": [],
    }


def decision_wire(record: Decision) -> dict[str, Any]:
    return {
        "id": record.id,
        "session_id": record.session_id,
        "command": units(record.command),
        "argv": [units(word) for word in record.argv],
        "cwd": units(record.cwd),
        "paths": [units(path) for path in record.paths],
        "reason": units(record.reason),
        "rule": rule_wire(record.rule),
        "outcome": None if record.outcome is None else record.outcome.value,
        "scope": record.scope.value,
        "note": units(record.note),
    }


def decision_from_wire(record: Mapping[str, Any]) -> Decision:
    rule = record["rule"]
    return Decision(
        id=record["id"],
        session_id=record["session_id"],
        command=from_units(record["command"]),
        argv=tuple(from_units(word) for word in record["argv"]),
        cwd=from_units(record["cwd"]),
        paths=tuple(from_units(path) for path in record["paths"]),
        reason=from_units(record["reason"]),
        rule=CommandRule(
            reason=from_units(rule["reason"]),
            commands=tuple(from_units(word) for word in rule["commands"]),
            paths=tuple(from_units(path) for path in rule["paths"]),
            mount=from_units(rule["mount"] or []),
        ),
        outcome=None
        if record["outcome"] is None
        else Outcome(record["outcome"]),
        scope=Scope(record["scope"]),
        note=from_units(record["note"]),
    )


def occurrence_wire(occurrence: Occurrence) -> dict[str, Any]:
    return {
        "parent": None
        if occurrence.parent is None
        else occurrence_wire(occurrence.parent),
        "source": units(occurrence.source),
        "start": occurrence.start,
        "end": occurrence.end,
    }


def occurrence_from_wire(occurrence: Mapping[str, Any]) -> Occurrence:
    parent = occurrence["parent"]
    return Occurrence(
        None if parent is None else occurrence_from_wire(parent),
        from_units(occurrence["source"]),
        occurrence["start"],
        occurrence["end"],
    )


def resolve_wire(
    ctx: CommandContext,
    rules: tuple[CommandRule, ...],
    claimant: dict[str, Any] | None,
) -> dict[str, Any]:
    record = Decision(
        authority_id(),
        ctx.session_id,
        ctx.command,
        tuple(ctx.argv),
        ctx.cwd,
        tuple(path.virtual for path in ctx.paths),
        rules[0].reason,
        rules[0],
    )
    return {
        "op": "resolve",
        "question": decision_wire(record),
        "rules": [rule_wire(rule) for rule in rules],
        "claimant": claimant,
    }


def inspect_approval(
    ledger: dict[str, Any], event: dict[str, Any]
) -> dict[str, Any]:
    stream = open_stream("policy_decisions", {})
    try:
        identity = authority_id()
        stream.feed(
            json.dumps(
                {
                    "evaluation": identity,
                    "transition": identity,
                    "ledger": ledger,
                    "event": event,
                }
            ).encode()
        )
        stream.finish()
        if stream.request() is not None:
            raise RuntimeError("approval inspection requested a write")
        result: dict[str, Any] = json.loads(stream.finish())
        return result
    finally:
        stream.cancel()


class Decisions(DecisionOwner):
    """Host prompts and execution scopes over the shared approval model."""

    def __init__(
        self,
        sessions: SessionDecisionsQuery | None = None,
        on_ask: AskHandler | None = None,
        version: Callable[[], int] | None = None,
    ) -> None:
        self._sessions = sessions
        self._on_ask = on_ask
        self._version = version
        self._versions: dict[str, int] = {}
        self._owner = authority_id()
        self._memory: dict[str, dict[str, Any]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._holders: WeakKeyDictionary[HandOff, str] = WeakKeyDictionary()
        self._bindings: WeakKeyDictionary[HandOff, tuple[str, str, int]] = (
            WeakKeyDictionary()
        )
        self._terminal: WeakSet[HandOff] = WeakSet()
        self._pending_scopes: WeakSet[HandOff] = WeakSet()
        self._readers: set[HandOff] = set()

    def _id(self, handed: HandOff) -> str:
        found = self._holders.get(handed)
        if found is None:
            found = authority_id()
            self._holders[handed] = found
        return found

    def _binding(
        self, session_id: str, handed: HandOff
    ) -> tuple[str, str, int] | None:
        family = lineage(handed)
        if any(reader in self._terminal for reader in family):
            raise ApprovalUnavailable("stale_holder")
        bound = self._bindings.get(family[-1])
        if bound is not None and bound[0] != session_id:
            raise ApprovalUnavailable("session_mismatch")
        return bound

    async def begin(self, session_id: str, handed: HandOff) -> str:
        """Bind a new caller to a confirmed session incarnation.

        Args:
            session_id (str): the caller's registered session.
            handed (HandOff): the new line or direct operation.
        """
        bound = self._binding(session_id, handed)
        revision = 0 if self._version is None else self._version()
        if bound is not None and bound[2] != revision:
            await self._event(session_id, {"op": "invalidate"}, bound[1])
            self._versions[session_id] = revision
            raise ApprovalUnavailable("policy_changed")
        if bound is None:
            if self._sessions is not None:
                epoch = await self._sessions.activate(session_id)
            else:
                state = self._memory.setdefault(
                    session_id, empty_ledger(authority_id())
                )
                epoch = state["incarnation"]
            bound = (session_id, epoch, revision)
            self._bindings[lineage(handed)[-1]] = bound
        self._readers.add(handed)
        self._id(handed)
        self._versions.setdefault(session_id, revision)
        return bound[1]

    def _state(self, session_id: str) -> dict[str, Any]:
        if self._sessions is not None:
            state = self._sessions.approval_state_of(session_id)
            return (
                state
                if state is not None
                else empty_ledger(
                    self._sessions.incarnation_of(session_id) or "unbound"
                )
            )
        return self._memory.get(session_id, empty_ledger("unbound"))

    def _keys(self) -> tuple[str, ...]:
        return (
            self._sessions.approval_sessions()
            if self._sessions is not None
            else tuple(self._memory)
        )

    def list(self, session_id: str = "") -> tuple[Decision, ...]:
        keys = (session_id,) if session_id else self._keys()
        return tuple(
            decision_from_wire(record)
            for key in keys
            for record in self._state(key)["records"]
        )

    def pending(self, session_id: str = "") -> tuple[Decision, ...]:
        return tuple(
            record
            for record in self.list(session_id)
            if record.outcome is None
        )

    def _project(self, session_id: str) -> None:
        state = self._state(session_id)
        records = {
            record["id"]: decision_from_wire(record)
            for record in state["records"]
        }
        for reader in self._readers:
            bound = self._bindings.get(lineage(reader)[-1])
            if bound is None or bound[0] != session_id:
                continue
            holder = self._id(reader)
            reader.claimed[:] = [
                Claim(
                    occurrence_from_wire(claim["occurrence"]),
                    records[claim["decision"]],
                )
                for claim in state["claims"]
                if claim["owner"] == self._owner and claim["holder"] == holder
            ]

    def _claimant(self, claimant: Claimant | None) -> dict[str, Any] | None:
        if claimant is None:
            return None
        return {
            "owner": self._owner,
            "holder": self._id(claimant.line),
            "lineage": [
                self._id(parent) for parent in lineage(claimant.line.parent)
            ],
            "occurrence": occurrence_wire(claimant.occurrence),
        }

    async def _event(
        self, session_id: str, event: dict[str, Any], epoch: str
    ) -> dict[str, Any]:
        revision = 0 if self._version is None else self._version()
        if self._sessions is not None:
            result = await self._sessions.approval_event(
                session_id, event, epoch
            )
        else:
            lock = self._locks.setdefault(session_id, asyncio.Lock())
            async with lock:
                stream = open_stream("policy_decisions", {})
                identity = authority_id()
                try:
                    stream.feed(
                        json.dumps(
                            {
                                "evaluation": identity,
                                "transition": identity,
                                "ledger": self._state(session_id),
                                "event": event,
                                "expected_incarnation": epoch,
                            }
                        ).encode()
                    )
                    stream.finish()
                    taken = stream.request()
                    if taken is not None:
                        effect, data = taken
                        if data or effect["op"] != "persist_approvals":
                            raise RuntimeError(
                                "invalid approval storage effect"
                            )
                        ledger = effect["ledger"]
                        if not isinstance(ledger, dict):
                            raise RuntimeError("invalid approval ledger")
                        self._memory[session_id] = ledger
                        stream.respond(
                            {
                                "evaluation": identity,
                                "transition": identity,
                                "effect": 1,
                                "status": "committed",
                                "revision": ledger["revision"],
                            },
                            b"",
                        )
                    result = json.loads(stream.finish())
                finally:
                    await close_stream(stream)
        if revision != (
            0 if self._version is None else self._version()
        ) and event["op"] in {
            "resolve",
            "answer",
            "validate",
            "session_grants",
        }:
            await self._event(session_id, {"op": "invalidate"}, epoch)
            self._versions[session_id] = (
                0 if self._version is None else self._version()
            )
            raise ApprovalUnavailable("policy_changed")
        if result["kind"] == "blocked":
            raise ApprovalUnavailable(result["status"])
        self._project(session_id)
        return result

    async def _check_version(self, session_id: str, epoch: str) -> bool:
        current = 0 if self._version is None else self._version()
        previous = self._versions.get(session_id)
        if previous is not None and previous != current:
            await self._event(session_id, {"op": "invalidate"}, epoch)
            self._versions[session_id] = current
            return True
        self._versions[session_id] = current
        return False

    def facts(self, session_id: str) -> dict[str, Any]:
        facts = (
            self._sessions.approval_facts_of(session_id)
            if self._sessions is not None
            else {
                "incarnation": self._state(session_id)["incarnation"],
                "fields": {},
            }
        )
        return {
            **facts,
            "revision": 0 if self._version is None else self._version(),
        }

    async def assert_current(
        self, session_id: str, handed: HandOff | None, before: dict[str, Any]
    ) -> None:
        if handed is not None:
            await self.validate(session_id, handed)
        elif self._sessions is not None and before["incarnation"] is not None:
            await self._sessions.refresh_approval(
                session_id, before["incarnation"]
            )
        result = inspect_approval(
            empty_ledger("inspection"),
            {
                "op": "inspect",
                "query": {
                    "kind": "facts_equal",
                    "left": before,
                    "right": self.facts(session_id),
                },
            },
        )
        if result["kind"] != "matches":
            raise RuntimeError("invalid approval comparison")
        if not result["matched"]:
            raise ApprovalUnavailable("policy_changed")

    async def validate(self, session_id: str, handed: HandOff) -> None:
        """Confirm an existing caller before its next dynamic gate.

        Args:
            session_id (str): the registered session.
            handed (HandOff): the caller whose identity was captured before execution.
        """
        epoch = await self.begin(session_id, handed)
        if self._sessions is not None:
            await self._sessions.refresh_approval(session_id, epoch)
        await self._check_version(session_id, epoch)
        await self._event(
            session_id,
            {
                "op": "validate",
                "owner": self._owner,
                "holders": [self._id(reader) for reader in lineage(handed)],
            },
            epoch,
        )

    async def answer(
        self,
        decision_id: str,
        outcome: Outcome,
        scope: Scope = Scope.ONCE,
        note: str = "",
    ) -> None:
        if outcome is Outcome.ASK:
            raise ValueError("ASK is not an answer")
        if self._sessions is not None:
            await self._sessions.ensure_loaded()
        record = next(
            (item for item in self.pending() if item.id == decision_id), None
        )
        if record is None:
            raise KeyError(decision_id)
        epoch = (
            self._sessions.incarnation_of(record.session_id)
            if self._sessions is not None
            else self._state(record.session_id)["incarnation"]
        )
        if epoch is None:
            raise ApprovalUnavailable("session_invalid")
        if self._sessions is not None:
            await self._sessions.refresh_approval(record.session_id, epoch)
        await self._check_version(record.session_id, epoch)
        if not any(
            item.id == decision_id for item in self.pending(record.session_id)
        ):
            raise KeyError(decision_id)
        result = await self._event(
            record.session_id,
            {
                "op": "answer",
                "id": decision_id,
                "outcome": outcome.value,
                "scope": scope.value,
                "note": units(note),
                "claimant": None,
            },
            epoch,
        )
        if result["kind"] == "missing":
            raise KeyError(decision_id)

    async def resolve(
        self,
        ctx: CommandContext,
        ask: Ask,
        cancel: asyncio.Event | None = None,
        claimant: Claimant | None = None,
        recheck: Callable[[], Awaitable[Deny | Ask | None]] | None = None,
    ) -> Deny | Pending | Abandoned | None:
        if cancel is not None and cancel.is_set():
            return ABANDONED
        if claimant is None:
            handed = HandOff()
            pending = False
            try:
                resolved = await self.resolve(
                    ctx,
                    ask,
                    cancel,
                    Claimant(
                        handed,
                        Occurrence(None, ctx.command, 0, len(ctx.command)),
                    ),
                    recheck,
                )
                pending = isinstance(resolved, Pending)
                return resolved
            finally:
                if pending:
                    await self.release(ctx.session_id, handed)
                else:
                    await self.revoke(ctx.session_id, handed)
        try:
            epoch = await self.begin(ctx.session_id, claimant.line)
            await self._check_version(ctx.session_id, epoch)
            while True:
                rules = ask.rules or (ask_rule(ctx, ask),)
                result = await self._event(
                    ctx.session_id,
                    resolve_wire(ctx, rules, self._claimant(claimant)),
                    epoch,
                )
                if await self._check_version(ctx.session_id, epoch):
                    raise ApprovalUnavailable("policy_changed")
                if result["kind"] == "allow":
                    return None
                if result["kind"] == "deny":
                    return Deny(from_units(result["reason"]))
                if result["kind"] != "pending":
                    raise RuntimeError("invalid approval resolution")
                record = decision_from_wire(result["record"])
                on_ask = self._on_ask
                if on_ask is None:
                    self._pending_scopes.add(claimant.line)
                    return Pending(record.id, record.reason)
                said = await answered(lambda: on_ask(record), cancel)
                if isinstance(said, Abandoned):
                    return said
                if said is None or said.outcome is None:
                    self._pending_scopes.add(claimant.line)
                    return Pending(record.id, record.reason)
                if said.id != record.id:
                    raise ApprovalUnavailable("stale_reply")
                if said.outcome is Outcome.ASK:
                    raise ValueError("ASK is not an answer")
                if cancel is not None and cancel.is_set():
                    return ABANDONED
                if self._sessions is not None:
                    await self._sessions.refresh_approval(
                        ctx.session_id, epoch
                    )
                if await self._check_version(ctx.session_id, epoch):
                    raise ApprovalUnavailable("policy_changed")
                if recheck is not None:
                    current = await recheck()
                    if not isinstance(current, Ask):
                        if current is None:
                            await self.validate(ctx.session_id, claimant.line)
                        return current
                    ask = current
                    checked = await self._event(
                        ctx.session_id,
                        resolve_wire(
                            ctx,
                            ask.rules or (ask_rule(ctx, ask),),
                            self._claimant(claimant),
                        ),
                        epoch,
                    )
                    if checked["kind"] == "allow":
                        return None
                    if checked["kind"] == "deny":
                        return Deny(from_units(checked["reason"]))
                    if checked["kind"] != "pending":
                        raise RuntimeError("invalid approval recheck")
                    if checked["record"]["id"] != record.id:
                        continue
                settled = await self._event(
                    ctx.session_id,
                    {
                        "op": "answer",
                        "id": record.id,
                        "outcome": said.outcome.value,
                        "scope": said.scope.value,
                        "note": units(said.note),
                        "claimant": self._claimant(claimant),
                    },
                    epoch,
                )
                if settled["kind"] == "missing":
                    raise ApprovalUnavailable("stale_reply")
                if said.outcome is Outcome.DENY:
                    return Deny(record.reason)
        except ApprovalUnavailable as exc:
            logger.debug("approval admission refused: %s", exc.status)
            return Deny(str(exc), failed=True)

    async def session_grants(
        self, ctx: CommandContext, claimant: Claimant | None = None
    ) -> builtins.list[CommandRule]:
        call = (
            claimant.line
            if claimant is not None
            else get_op_call(self, ctx.session_id)
        )
        if claimant is None and call is not None:
            claimant = Claimant(
                call, Occurrence(call.origin, ctx.command, 0, len(ctx.command))
            )
        if claimant is not None:
            epoch = await self.begin(ctx.session_id, claimant.line)
        elif self._sessions is not None:
            epoch = await self._sessions.activate(ctx.session_id)
        else:
            state = self._memory.setdefault(
                ctx.session_id, empty_ledger(authority_id())
            )
            epoch = state["incarnation"]
        if self._sessions is not None:
            await self._sessions.refresh_approval(ctx.session_id, epoch)
        await self._check_version(ctx.session_id, epoch)
        reader = (
            None
            if claimant is None
            else Claimant(claimant.line, Occurrence(None, "", 0, 0))
        )
        result = await self._event(
            ctx.session_id,
            {"op": "session_grants", "claimant": self._claimant(reader)},
            epoch,
        )
        if result["kind"] != "grants":
            raise RuntimeError("invalid session approval grants")
        return [
            CommandRule(
                reason=from_units(rule["reason"]),
                commands=tuple(from_units(word) for word in rule["commands"]),
                paths=tuple(from_units(path) for path in rule["paths"]),
                mount=from_units(rule["mount"] or []),
            )
            for rule in result["rules"]
        ]

    def held(
        self, ctx: CommandContext, ask: Ask, claimant: Claimant | None = None
    ) -> Deny | Pending | None:
        rules = ask.rules or (ask_rule(ctx, ask),)
        event = resolve_wire(ctx, rules, self._claimant(claimant))
        event["explain"] = True
        result = inspect_approval(self._state(ctx.session_id), event)
        if result["kind"] == "allow":
            return None
        if result["kind"] == "deny":
            return Deny(from_units(result["reason"]))
        if result["kind"] == "blocked":
            return Deny(
                f"approval unavailable: {result['status']}", failed=True
            )
        record = decision_from_wire(result["record"])
        return Pending(record.id, record.reason)

    async def resolve_op(
        self,
        ctx: VfsContext | SessionContext,
        ask: Ask,
        caller: Caller | None = None,
        recheck: Callable[[], Awaitable[Deny | Ask | None]] | None = None,
    ) -> Deny | Pending | None:
        caller = current_caller() if caller is None else caller
        if caller.explaining is DryRun.DECIDING:
            return self.held_op(ctx, ask)
        asked, keyed = op_question(ctx, ask)
        call = call_of(caller, self, ctx.session_id)
        claimant = (
            Claimant(call, Occurrence(None, asked.argv[0], 0, 0))
            if call is not None
            else None
        )

        async def checked() -> Deny | Ask | None:
            if recheck is None:
                return keyed
            current = await recheck()
            return (
                op_question(ctx, current)[1]
                if isinstance(current, Ask)
                else current
            )

        said = await self.resolve(
            asked,
            keyed,
            claimant=claimant,
            recheck=None if recheck is None else checked,
        )
        return Deny(ask.reason) if isinstance(said, Abandoned) else said

    def held_op(
        self, ctx: VfsContext | SessionContext, ask: Ask
    ) -> Deny | Pending | None:
        return self.held(*op_question(ctx, ask))

    async def within_call(
        self, session_id: str, run: Callable[[HandOff], Awaitable[T]]
    ) -> T:
        outer = get_op_call(self, session_id)
        if outer is not None:
            return await run(outer)
        handed = HandOff()
        await self.begin(session_id, handed)
        token = set_op_call(self, handed, session_id)
        try:
            return await run(handed)
        except PolicyDenied as exc:
            if is_pending(exc.refusal):
                self._pending_scopes.add(handed)
            raise
        finally:
            reset_op_call(token)
            if handed in self._pending_scopes:
                await self.release(session_id, handed)
            else:
                await self.revoke(session_id, handed)

    async def split(
        self, session_id: str, handed: HandOff, scope: Occurrence
    ) -> HandOff:
        epoch = await self.begin(session_id, handed)
        job = HandOff(origin=handed.origin)
        self._bindings[job] = (
            session_id,
            epoch,
            0 if self._version is None else self._version(),
        )
        self._readers.add(job)
        try:
            await self._event(
                session_id,
                {
                    "op": "split",
                    "owner": self._owner,
                    "lineage": [
                        self._id(reader) for reader in lineage(handed)
                    ],
                    "job": self._id(job),
                    "scope": occurrence_wire(scope),
                },
                epoch,
            )
        except BaseException:
            self._terminal.add(job)
            try:
                await self._event(
                    session_id,
                    {
                        "op": "revoke",
                        "owner": self._owner,
                        "holder": self._id(job),
                    },
                    epoch,
                )
            except Exception:
                logger.debug("unconfirmed job approval cleanup", exc_info=True)
            finally:
                self._readers.discard(job)
            raise
        return job

    async def hand_up(self, session_id: str, handed: HandOff) -> None:
        if handed.parent is None:
            raise ValueError("a top-level caller has no parent")
        bound = self._bindings.get(lineage(handed)[-1])
        if bound is None:
            return
        self._readers.add(handed.parent)
        self._terminal.add(handed)
        try:
            await self._event(
                session_id,
                {
                    "op": "hand_up",
                    "owner": self._owner,
                    "holder": self._id(handed),
                    "parent": self._id(handed.parent),
                },
                bound[1],
            )
        except ApprovalUnavailable as exc:
            if exc.status not in {
                "session_replaced",
                "session_closed",
                "stale_incarnation",
            }:
                raise
            logger.debug("approval cleanup fenced: %s", exc.status)
        finally:
            self._readers.discard(handed)

    async def _end(self, op: str, session_id: str, handed: HandOff) -> None:
        bound = self._bindings.get(lineage(handed)[-1])
        if bound is None:
            return
        self._terminal.add(handed)
        try:
            await self._event(
                session_id,
                {"op": op, "owner": self._owner, "holder": self._id(handed)},
                bound[1],
            )
        except ApprovalUnavailable as exc:
            if exc.status not in {
                "session_replaced",
                "session_closed",
                "stale_incarnation",
            }:
                raise
            logger.debug("approval cleanup fenced: %s", exc.status)
        finally:
            self._readers.discard(handed)

    async def revoke(self, session_id: str, handed: HandOff) -> None:
        await self._end("revoke", session_id, handed)

    async def release(self, session_id: str, handed: HandOff) -> None:
        await self._end("release", session_id, handed)


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
