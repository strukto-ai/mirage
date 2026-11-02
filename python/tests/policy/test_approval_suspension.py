import asyncio
import dataclasses

import pytest

from mirage.policy.decisions import Decisions
from mirage.policy.match import Outcome
from mirage.policy.types import (
    Ask,
    Claimant,
    CommandContext,
    CommandRule,
    Decision,
    HandOff,
    Occurrence,
    Pending,
    Scope,
)


class PausedSessions:
    def __init__(self) -> None:
        self.records: tuple[Decision, ...] = ()
        self.saving = (asyncio.Event(), asyncio.Event())
        self.resume = (asyncio.Event(), asyncio.Event())
        self.flushes = 0

    def decision_sessions(self) -> tuple[str, ...]:
        return ("s",)

    def decisions_of(self, session_id: str) -> tuple[Decision, ...]:
        assert session_id == "s"
        return self.records

    def set_decisions(
        self, session_id: str, records: tuple[Decision, ...]
    ) -> None:
        assert session_id == "s"
        self.records = records

    async def flush(self) -> None:
        index = self.flushes
        self.flushes += 1
        if index < len(self.saving):
            self.saving[index].set()
            await self.resume[index].wait()


@pytest.mark.asyncio
async def test_approval_state_is_visible_at_each_suspension() -> None:
    sessions = PausedSessions()
    prompting = asyncio.Event()
    answer: asyncio.Future[Decision] = asyncio.get_running_loop().create_future()

    async def prompt(record: Decision) -> Decision:
        prompting.set()
        return await answer

    ledger = Decisions(sessions, prompt)
    ctx = CommandContext(
        command="git", argv=("push",), paths=(), cwd="/repo", session_id="s"
    )
    ask = Ask("first", rule=CommandRule(reason="first", commands=("git push",)))
    occurrence = Occurrence(None, "git push", 0, 8)
    first, other = Claimant(HandOff(), occurrence), Claimant(HandOff(), occurrence)
    running = asyncio.create_task(ledger.resolve(ctx, ask, claimant=first))
    try:
        await asyncio.wait_for(sessions.saving[0].wait(), 5)
        assert len(ledger.pending("s")) == 1
        assert not prompting.is_set()
        pending = ledger.held(ctx, ask, other)
        assert isinstance(pending, Pending)
        assert pending.id == ledger.pending("s")[0].id

        sessions.resume[0].set()
        await asyncio.wait_for(prompting.wait(), 5)
        assert isinstance(ledger.held(ctx, ask, other), Pending)
        assert sessions.flushes == 1

        answer.set_result(
            dataclasses.replace(
                ledger.pending("s")[0],
                outcome=Outcome.ALLOW,
                scope=Scope.ONCE,
            )
        )
        await asyncio.wait_for(sessions.saving[1].wait(), 5)
        assert ledger.held(ctx, ask, first) is None
        assert isinstance(ledger.held(ctx, ask, other), Pending)
        assert ledger.pending("s") == ()

        sessions.resume[1].set()
        assert await asyncio.wait_for(running, 5) is None
        await ledger.revoke("s", first.line)
        assert ledger.list("s") == ()
        assert sessions.flushes == 3
    finally:
        for resume in sessions.resume:
            resume.set()
        if not running.done():
            running.cancel()
        await asyncio.gather(running, return_exceptions=True)
