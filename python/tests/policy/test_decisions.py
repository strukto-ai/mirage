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

import pytest

from mirage.policy.decisions import (Decisions, ask_rule, covers, decision_id,
                                     encloses)
from mirage.policy.match import Outcome
from mirage.policy.types import (Abandoned, Ask, Claimant, CommandContext,
                                 CommandRule, Decision, Deny, HandOff,
                                 Occurrence, Pending, Scope)

RULE = CommandRule(reason="sign-off", commands=("git push", ))


class _Registry:

    def is_mount_root(self, path: str) -> bool:
        return False


def _ctx(command: str = "git",
         argv: tuple[str, ...] = ("push", ),
         cwd: str = "/repo",
         session_id: str = "s") -> CommandContext:
    return CommandContext(command=command,
                          paths=(),
                          operands=(),
                          argv=argv,
                          cwd=cwd,
                          session_id=session_id,
                          registry=_Registry(),
                          tokens=(command, *argv))


def _at(handed: HandOff, index: int = 0) -> Claimant:
    """The reader for one spelling of a command on a line.

    Args:
        handed (HandOff): the line's hand-off.
        index (int): which spelling, each its own occurrence.
    """
    return Claimant(handed, Occurrence(None, "line", index, index + 1))


def _record(**over: object) -> Decision:
    base = Decision(id="d1",
                    session_id="s",
                    agent_id="",
                    command="git",
                    argv=("push", ),
                    cwd="/repo",
                    paths=(),
                    reason="sign-off",
                    rule=RULE)
    return dataclasses.replace(base, **over)  # type: ignore[arg-type]


def test_decision_id_is_stable_for_the_same_line_and_session():
    same = decision_id("s", "/repo", ("git", "push"))
    assert same == decision_id("s", "/repo", ("git", "push"))
    assert same != decision_id("other", "/repo", ("git", "push"))
    assert same != decision_id("s", "/elsewhere", ("git", "push"))
    assert len(same) == 12


def test_ask_rule_synthesizes_one_over_the_program_for_a_coded_ask():
    assert ask_rule(_ctx(), Ask("sign-off", rule=RULE)) is RULE
    coded = ask_rule(_ctx(), Ask("sign-off"))
    assert coded.commands == ("git", )
    assert coded.reason == "sign-off"


def test_covers_reads_scope_and_never_answers_a_waiting_record():
    argv = ("git", "push")
    assert not covers(_record(), RULE, argv, "/repo")
    once = _record(outcome=Outcome.ALLOW, scope=Scope.ONCE)
    assert covers(once, RULE, argv, "/repo")
    # A ONCE answer is for the exact line, so a different line or a
    # different directory is not it.
    assert not covers(once, RULE, ("git", "push", "-f"), "/repo")
    assert not covers(once, RULE, argv, "/elsewhere")
    # A SESSION answer covers any line the same rule asks about.
    forever = _record(outcome=Outcome.ALLOW, scope=Scope.SESSION)
    assert covers(forever, RULE, ("git", "push", "-f"), "/elsewhere")
    # An answer never answers a rule it was not given for: a persisted
    # record reopened under an edited profile must not speak for the
    # new rule.
    other = CommandRule(reason="different", commands=("git push", ))
    assert not covers(forever, other, argv, "/repo")


@pytest.mark.asyncio
async def test_a_question_is_recorded_once_and_answered_once():
    ledger = Decisions()
    ctx, ask = _ctx(), Ask("sign-off", rule=RULE)
    first = await ledger.resolve(ctx, ask)
    assert isinstance(first, Pending)
    # A retry reuses the record rather than filing a second one, so the
    # agent keeps quoting one id.
    again = await ledger.resolve(ctx, ask)
    assert isinstance(again, Pending) and again.id == first.id
    assert len(ledger.pending()) == 1
    await ledger.answer(first.id, Outcome.ALLOW, Scope.ONCE)
    assert ledger.pending() == ()
    assert len(ledger.list()) == 1
    assert await ledger.resolve(ctx, ask) is None
    # ONCE is consumed by the line it answered, so the next asks again.
    assert isinstance(await ledger.resolve(ctx, ask), Pending)


@pytest.mark.asyncio
async def test_a_session_answer_is_not_consumed_and_a_deny_refuses():
    ledger = Decisions()
    ctx, ask = _ctx(), Ask("sign-off", rule=RULE)
    pending = await ledger.resolve(ctx, ask)
    assert isinstance(pending, Pending)
    await ledger.answer(pending.id, Outcome.ALLOW, Scope.SESSION)
    for _ in range(3):
        assert await ledger.resolve(ctx, ask) is None

    refused = Decisions()
    asked = await refused.resolve(ctx, ask)
    assert isinstance(asked, Pending)
    await refused.answer(asked.id, Outcome.DENY, note="not this one")
    action = await refused.resolve(ctx, ask)
    assert isinstance(action, Deny) and action.reason == "sign-off"


@pytest.mark.asyncio
async def test_held_reads_without_recording_or_spending():
    ledger = Decisions()
    ctx, ask = _ctx(), Ask("sign-off", rule=RULE)
    # Nothing is on file, so held reports waiting and files nothing.
    for _ in range(3):
        assert isinstance(ledger.held(ctx, ask), Pending)
    assert ledger.list() == ()
    pending = await ledger.resolve(ctx, ask)
    assert isinstance(pending, Pending)
    await ledger.answer(pending.id, Outcome.ALLOW, Scope.ONCE)
    # Reading it does not spend it: the run that follows still passes.
    assert ledger.held(ctx, ask) is None
    assert ledger.held(ctx, ask) is None
    assert await ledger.resolve(ctx, ask) is None


@pytest.mark.asyncio
async def test_answering_rejects_ask_and_an_unknown_id():
    ledger = Decisions()
    pending = await ledger.resolve(_ctx(), Ask("sign-off", rule=RULE))
    assert isinstance(pending, Pending)
    with pytest.raises(ValueError):
        await ledger.answer(pending.id, Outcome.ASK)
    with pytest.raises(KeyError):
        await ledger.answer("nosuchid", Outcome.ALLOW)
    # Answering twice is answering an id nothing is waiting on.
    await ledger.answer(pending.id, Outcome.ALLOW)
    with pytest.raises(KeyError):
        await ledger.answer(pending.id, Outcome.DENY)


@pytest.mark.asyncio
async def test_a_host_that_answers_inside_the_line_leaves_nothing_waiting():

    async def allow(record: Decision) -> Decision:
        return dataclasses.replace(record,
                                   outcome=Outcome.ALLOW,
                                   scope=Scope.SESSION)

    ledger = Decisions(on_ask=allow)
    assert await ledger.resolve(_ctx(), Ask("sign-off", rule=RULE)) is None
    assert ledger.pending() == ()
    assert len(ledger.list()) == 1

    async def undecided(record: Decision) -> Decision | None:
        return None

    waiting = Decisions(on_ask=undecided)
    action = await waiting.resolve(_ctx(), Ask("sign-off", rule=RULE))
    assert isinstance(action, Pending)
    assert len(waiting.pending()) == 1


@pytest.mark.asyncio
async def test_an_inline_grant_is_spent_by_the_line_that_asked():
    """The host answers while the line waits, so the grant belongs to
    that line: allowing once must not let the next identical line
    through unasked."""
    asked = []

    async def allow(record: Decision) -> Decision:
        asked.append(record.id)
        return dataclasses.replace(record,
                                   outcome=Outcome.ALLOW,
                                   scope=Scope.ONCE)

    ledger = Decisions(on_ask=allow)
    assert await ledger.resolve(_ctx(), Ask("sign-off", rule=RULE)) is None
    assert await ledger.resolve(_ctx(), Ask("sign-off", rule=RULE)) is None
    assert len(asked) == 2

    # A refusal is the other way round, by design: the human who said no
    # is not asked about the agent's immediate retry. The record stands
    # to refuse that retry, is spent by it, and the run after is a new
    # question.
    refusals = []

    async def deny(record: Decision) -> Decision:
        refusals.append(record.id)
        return dataclasses.replace(record,
                                   outcome=Outcome.DENY,
                                   scope=Scope.ONCE)

    refused = Decisions(on_ask=deny)
    for expected in (1, 1, 2):
        action = await refused.resolve(_ctx(), Ask("sign-off", rule=RULE))
        assert isinstance(action, Deny)
        assert len(refusals) == expected


@pytest.mark.asyncio
async def test_a_hand_off_spends_nothing_for_the_pass_that_follows():
    """The pass that judges a line on the gate's behalf asks and leaves
    the answer standing; the gate runs the line on it and the line's end
    spends it. One question per run, and a grant already on file when
    the hand-off began is left exactly as untouched as the one the host
    gives during it."""
    asked = []

    async def allow(record: Decision) -> Decision:
        asked.append(record.id)
        return dataclasses.replace(record,
                                   outcome=Outcome.ALLOW,
                                   scope=Scope.ONCE)

    ledger = Decisions(on_ask=allow)
    ask = Ask("sign-off", rule=RULE)
    line = HandOff()
    assert await ledger.resolve(_ctx(), ask, None, _at(line)) is None
    assert await ledger.resolve(_ctx(), ask, None, _at(line)) is None
    assert len(asked) == 1
    # Claimed by a live line, the grant is not on offer off the line.
    assert await ledger.resolve(_ctx(), ask) is None
    assert len(asked) == 2
    await ledger.revoke("s", line)
    assert ledger.list("s") == ()

    other = CommandRule(reason="twice over", commands=("git push", ))
    both = Ask("sign-off", rules=(RULE, other))
    # The first rule is granted to a line that was then held, which
    # releases its claim; the second during this line's own pass.
    earlier = HandOff()
    assert await ledger.resolve(_ctx(), ask, None, _at(earlier)) is None
    ledger.release("s", earlier)
    line = HandOff()
    assert await ledger.resolve(_ctx(), both, None, _at(line)) is None
    assert len(asked) == 4
    # The gate finds both standing and asks nothing; the line's end
    # spends them.
    assert await ledger.resolve(_ctx(), both, None, _at(line)) is None
    assert len(asked) == 4
    assert len(ledger.list("s")) == 2
    await ledger.revoke("s", line)
    assert ledger.list("s") == ()


@pytest.mark.asyncio
async def test_a_revoked_hand_off_is_asked_again():
    """A grant handed off to a line that was then refused is handed
    back, and the next identical line is a question again."""
    asked = []

    async def allow(record: Decision) -> Decision:
        asked.append(record.id)
        return dataclasses.replace(record,
                                   outcome=Outcome.ALLOW,
                                   scope=Scope.ONCE)

    ledger = Decisions(on_ask=allow)
    ask = Ask("sign-off", rule=RULE)
    handed = HandOff()
    assert await ledger.resolve(_ctx(), ask, None, _at(handed)) is None
    assert len(ledger.list("s")) == 1
    assert [c.decision for c in handed.claimed] == list(ledger.list("s"))
    await ledger.revoke("s", handed)
    assert ledger.list("s") == ()
    assert handed.claimed == []
    assert await ledger.resolve(_ctx(), ask) is None
    assert len(asked) == 2


@pytest.mark.asyncio
async def test_a_hand_off_claims_a_grant_for_one_occurrence():
    """A command spelled twice on one line is two questions: the grant
    the first spelling claimed is not standing for the second, and the
    line's end spends one per spelling."""
    asked = []

    async def allow(record: Decision) -> Decision:
        asked.append(record.id)
        return dataclasses.replace(record,
                                   outcome=Outcome.ALLOW,
                                   scope=Scope.ONCE)

    ledger = Decisions(on_ask=allow)
    ask = Ask("sign-off", rule=RULE)
    handed = HandOff()
    assert await ledger.resolve(_ctx(), ask, None, _at(handed, 0)) is None
    assert await ledger.resolve(_ctx(), ask, None, _at(handed, 1)) is None
    assert len(asked) == 2
    assert len(handed.claimed) == 2
    assert len(ledger.list("s")) == 2
    # The pass reading either spelling again finds it answered.
    assert await ledger.resolve(_ctx(), ask, None, _at(handed, 1)) is None
    assert len(asked) == 2
    assert await ledger.resolve(_ctx(), ask, None, _at(handed, 0)) is None
    assert await ledger.resolve(_ctx(), ask, None, _at(handed, 1)) is None
    assert len(asked) == 2
    assert len(ledger.list("s")) == 2
    await ledger.revoke("s", handed)
    assert ledger.list("s") == ()


@pytest.mark.asyncio
async def test_a_grant_one_line_claimed_is_not_on_offer_to_another():
    """Two lines judged at once cannot both pass on one nod: the
    grant the first line claimed is invisible to the second line's pass
    and to a gate outside any line, and only the first line's own gate
    runs on it."""
    ledger = Decisions()
    ask = Ask("sign-off", rule=RULE)
    waiting = await ledger.resolve(_ctx(), ask)
    assert isinstance(waiting, Pending)
    await ledger.answer(waiting.id, Outcome.ALLOW)
    first, second = HandOff(), HandOff()
    assert await ledger.resolve(_ctx(), ask, None, _at(first)) is None
    assert isinstance(await ledger.resolve(_ctx(), ask, None, _at(second)),
                      Pending)
    assert isinstance(await ledger.resolve(_ctx(), ask), Pending)
    assert await ledger.resolve(_ctx(), ask, None, _at(first)) is None
    assert len(ledger.pending("s")) == 1
    assert len(ledger.list("s")) == 2
    # Released at the line's end, a claim no longer hides anything.
    await ledger.revoke("s", first)
    assert len(ledger.list("s")) == 1
    await ledger.answer(ledger.pending("s")[0].id, Outcome.ALLOW)
    assert await ledger.resolve(_ctx(), ask, None, _at(second)) is None


def test_encloses_reads_a_span_and_the_lines_evaluated_inside_it():
    line = "sleep 1 && cat s & ls"
    scope = Occurrence(None, line, 0, 18)
    inside = Occurrence(None, line, 11, 16)
    assert encloses(scope, inside)
    assert encloses(scope, Occurrence(inside, "cat s", 0, 5))
    assert not encloses(scope, Occurrence(None, line, 19, 21))
    assert not encloses(scope, Occurrence(None, "cat s", 0, 5))


@pytest.mark.asyncio
async def test_a_split_hands_a_jobs_claims_to_a_run_of_its_own():
    """A background job takes a copy of the claims made inside its span
    onto a hand-off of its own, so the line's end, a release for a
    question left waiting included, lets go of the line's claims alone,
    and the job's stay reserved until the job ends."""
    ledger = Decisions()
    ask = Ask("sign-off", rule=RULE)
    handed = HandOff()
    for index in (0, 1):
        waiting = await ledger.resolve(_ctx(), ask)
        assert isinstance(waiting, Pending)
        await ledger.answer(waiting.id, Outcome.ALLOW)
        assert await ledger.resolve(_ctx(), ask, None, _at(handed,
                                                           index)) is None
    job = ledger.split("s", handed, Occurrence(None, "line", 1, 2))
    assert [c.occurrence.start for c in handed.claimed] == [0, 1]
    assert [c.occurrence.start for c in job.claimed] == [1]
    ledger.release("s", handed)
    # The line's grant is on offer again; the job's is not.
    assert await ledger.resolve(_ctx(), ask, None, _at(HandOff(), 0)) is None
    assert isinstance(ledger.held(_ctx(), ask, _at(HandOff(), 1)), Pending)
    assert await ledger.resolve(_ctx(), ask, None, _at(job, 1)) is None
    assert len(ledger.list("s")) == 2
    await ledger.revoke("s", job)
    assert len(ledger.list("s")) == 1


@pytest.mark.asyncio
async def test_a_split_shares_ancestor_claims_with_the_job():
    ledger = Decisions()
    ask = Ask("sign-off", rule=RULE)
    outer = HandOff()
    for index in (0, 1):
        waiting = await ledger.resolve(_ctx(), ask)
        assert isinstance(waiting, Pending)
        await ledger.answer(waiting.id, Outcome.ALLOW)
        assert await ledger.resolve(_ctx(), ask, None, _at(outer,
                                                           index)) is None
    nested = HandOff(parent=outer)
    assert await ledger.resolve(_ctx(), ask, None, _at(nested, 1)) is None
    inner = HandOff(parent=nested)
    job = ledger.split("s", inner, Occurrence(None, "line", 1, 2))
    assert [c.occurrence.start for c in outer.claimed] == [0, 1]
    assert nested.claimed == []
    assert inner.claimed == []
    assert [c.occurrence.start for c in job.claimed] == [1]
    for handed in (inner, nested, outer):
        await ledger.revoke("s", handed)
    assert len(ledger.list("s")) == 1
    assert isinstance(ledger.held(_ctx(), ask), Pending)
    assert ledger.held(_ctx(), ask, _at(job, 1)) is None
    assert await ledger.resolve(_ctx(), ask, None, _at(job, 1)) is None
    await ledger.revoke("s", job)
    assert ledger.list("s") == ()


@pytest.mark.asyncio
async def test_a_jobs_unspent_grant_is_spent_when_the_job_ends():
    ledger = Decisions()
    ask = Ask("sign-off", rule=RULE)
    waiting = await ledger.resolve(_ctx(), ask)
    assert isinstance(waiting, Pending)
    await ledger.answer(waiting.id, Outcome.ALLOW)
    handed = HandOff()
    assert await ledger.resolve(_ctx(), ask, None, _at(handed)) is None
    job = ledger.split("s", handed, Occurrence(None, "line", 0, 1))
    await ledger.revoke("s", handed)
    assert len(ledger.list("s")) == 1
    await ledger.revoke("s", job)
    assert ledger.list("s") == ()


@pytest.mark.asyncio
async def test_held_reads_through_a_live_lines_claim():
    """A dry run reports what a run would find: a grant one line has
    claimed reads as waiting to everyone else, and as answered to that
    line."""
    ledger = Decisions()
    ask = Ask("sign-off", rule=RULE)
    waiting = await ledger.resolve(_ctx(), ask)
    assert isinstance(waiting, Pending)
    await ledger.answer(waiting.id, Outcome.ALLOW)
    assert ledger.held(_ctx(), ask) is None
    handed = HandOff()
    assert await ledger.resolve(_ctx(), ask, None, _at(handed)) is None
    assert isinstance(ledger.held(_ctx(), ask), Pending)
    assert isinstance(ledger.held(_ctx(), ask, _at(HandOff())), Pending)
    ledger.release("s", handed)
    assert ledger.held(_ctx(), ask) is None


@pytest.mark.asyncio
async def test_revoke_hands_back_a_grant_given_before_the_pass():
    """A grant answered out of band is claimed by the pass that reads
    it exactly as an inline one is, so a refusal hands it back too and
    the next identical line is a question again."""
    ledger = Decisions()
    ask = Ask("sign-off", rule=RULE)
    waiting = await ledger.resolve(_ctx(), ask)
    assert isinstance(waiting, Pending)
    await ledger.answer(waiting.id, Outcome.ALLOW)
    handed = HandOff()
    assert await ledger.resolve(_ctx(), ask, None, _at(handed)) is None
    assert len(handed.claimed) == 1
    await ledger.revoke("s", handed)
    assert ledger.list("s") == ()
    assert isinstance(await ledger.resolve(_ctx(), ask), Pending)


@pytest.mark.asyncio
async def test_a_host_takes_one_argument():
    # The handler is a plain `async def h(record)`, as it was before the
    # wait was bounded. The typescript twin grows an optional signal
    # parameter because a pending promise cannot be interrupted; here
    # the kill reaches the host as cancellation, so nothing is threaded
    # and no embedder has to change shape to keep working.
    async def allow(record: Decision) -> Decision:
        return dataclasses.replace(record,
                                   outcome=Outcome.ALLOW,
                                   scope=Scope.ONCE)

    ledger = Decisions(on_ask=allow)
    assert await ledger.resolve(_ctx(), Ask("sign-off", rule=RULE),
                                asyncio.Event()) is None
    assert ledger.pending() == ()


@pytest.mark.asyncio
async def test_a_killed_run_cancels_the_host_waiting_on_it():
    cancel = asyncio.Event()
    started = asyncio.Event()
    torn_down = asyncio.Event()

    async def prompting(record: Decision) -> Decision:
        # What a host holding a prompt open looks like: it is told the
        # run is gone the way any parked coroutine is, and can take the
        # prompt down in its own `finally`.
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            torn_down.set()
            raise
        raise AssertionError("unreachable")

    ledger = Decisions(on_ask=prompting)
    asked = asyncio.ensure_future(
        ledger.resolve(_ctx(), Ask("sign-off", rule=RULE), cancel))
    await started.wait()
    cancel.set()
    assert isinstance(await asked, Abandoned)
    await asyncio.wait_for(torn_down.wait(), timeout=1)


@pytest.mark.asyncio
async def test_the_ledger_stops_waiting_when_the_run_is_killed():
    cancel = asyncio.Event()
    started = asyncio.Event()

    async def never(record: Decision) -> Decision:
        # A host that never answers: without the bound, the run waiting
        # on this would outlive its own deadline entirely.
        started.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    ledger = Decisions(on_ask=never)
    asked = asyncio.ensure_future(
        ledger.resolve(_ctx(), Ask("sign-off", rule=RULE), cancel))
    await started.wait()
    cancel.set()
    assert isinstance(await asked, Abandoned)
    # Nobody answered, so the question is still open for whoever asks next.
    assert len(ledger.pending()) == 1


@pytest.mark.asyncio
async def test_nothing_is_put_to_a_host_for_a_run_already_over():
    cancel = asyncio.Event()
    cancel.set()
    asked = False

    async def allow(record: Decision) -> Decision:
        nonlocal asked
        asked = True
        return dataclasses.replace(record, outcome=Outcome.ALLOW)

    ledger = Decisions(on_ask=allow)
    action = await ledger.resolve(_ctx(), Ask("sign-off", rule=RULE), cancel)
    assert isinstance(action, Abandoned)
    assert asked is False
    assert len(ledger.pending()) == 1


@pytest.mark.asyncio
async def test_an_answer_after_the_kill_is_dropped_not_recorded():
    cancel = asyncio.Event()
    started = asyncio.Event()

    async def slow_yes(record: Decision) -> Decision:
        started.set()
        await asyncio.sleep(0.2)
        return dataclasses.replace(record,
                                   outcome=Outcome.ALLOW,
                                   scope=Scope.ONCE)

    ledger = Decisions(on_ask=slow_yes)
    asked = asyncio.ensure_future(
        ledger.resolve(_ctx(), Ask("sign-off", rule=RULE), cancel))
    await started.wait()
    cancel.set()
    assert isinstance(await asked, Abandoned)
    await asyncio.sleep(0.3)
    # Recording it would leave a spent-once grant behind, and the next
    # identical line would take it without anybody being asked.
    assert len(ledger.pending()) == 1
    assert ledger.list()[0].outcome is None


@pytest.mark.asyncio
async def test_records_are_listed_per_session_and_across_them():
    ledger = Decisions()
    ask = Ask("sign-off", rule=RULE)
    await ledger.resolve(_ctx(session_id="a"), ask)
    await ledger.resolve(_ctx(session_id="b"), ask)
    assert len(ledger.list()) == 2
    assert len(ledger.list("a")) == 1
    assert ledger.list("a")[0].session_id == "a"
    assert ledger.list("nobody") == ()


@pytest.mark.asyncio
async def test_a_nested_line_runs_on_what_its_parents_pass_claimed():
    """A line evaluated from inside another reads the outer line's
    claims as its own: its pass finds the occurrence answered instead
    of asking again, its gate runs on it, and only what it claims itself
    is hidden from its own pass. Every other line still sees none of
    it."""
    asked = []

    async def allow(record: Decision) -> Decision:
        asked.append(record.id)
        return dataclasses.replace(record,
                                   outcome=Outcome.ALLOW,
                                   scope=Scope.ONCE)

    ledger = Decisions(on_ask=allow)
    ask = Ask("sign-off", rule=RULE)
    outer = HandOff()
    assert await ledger.resolve(_ctx(), ask, None, _at(outer)) is None
    assert len(asked) == 1
    inner = HandOff(parent=outer)
    # The inner pass finds the outer claim standing for this occurrence.
    assert await ledger.resolve(_ctx(), ask, None, _at(inner, 0)) is None
    assert len(asked) == 1
    # A second spelling on the inner line is a question of its own.
    assert await ledger.resolve(_ctx(), ask, None, _at(inner, 1)) is None
    assert len(asked) == 2
    # A line outside the lineage sees neither claim.
    stranger = HandOff()
    assert await ledger.resolve(_ctx(), ask, None, _at(stranger)) is None
    assert len(asked) == 3
    # The inner gates run on both without asking.
    assert await ledger.resolve(_ctx(), ask, None, _at(inner, 0)) is None
    assert await ledger.resolve(_ctx(), ask, None, _at(inner, 1)) is None
    assert len(asked) == 3
    await ledger.revoke("s", inner)
    await ledger.revoke("s", outer)
    await ledger.revoke("s", stranger)
    assert ledger.list("s") == ()


@pytest.mark.asyncio
async def test_a_claim_is_on_offer_to_its_occurrence_alone():
    """A grant the pass claimed for one spelling is not on offer to
    another spelling of the same command on the same line, whether a
    pass or a gate reads it: a word that expands at run time into the
    command cannot run on the nod a literal spelling was given."""
    ledger = Decisions()
    ask = Ask("sign-off", rule=RULE)
    waiting = await ledger.resolve(_ctx(), ask)
    assert isinstance(waiting, Pending)
    await ledger.answer(waiting.id, Outcome.ALLOW)
    handed = HandOff()
    assert await ledger.resolve(_ctx(), ask, None, _at(handed, 0)) is None
    assert isinstance(await ledger.resolve(_ctx(), ask, None, _at(handed, 1)),
                      Pending)
    assert isinstance(ledger.held(_ctx(), ask, _at(handed, 1)), Pending)
    assert ledger.held(_ctx(), ask, _at(handed, 0)) is None
    assert await ledger.resolve(_ctx(), ask, None, _at(handed, 0)) is None
    assert len(ledger.pending("s")) == 1


@pytest.mark.asyncio
async def test_a_claim_stands_for_every_visit_until_the_line_ends():
    """A grant bound to one place on the line is spent when the line
    ends, not by the first gate to read it: a loop body revisits the
    place, and the second visit runs on the same nod rather than asking
    again after the rest of the body already ran once more."""
    asked = []

    async def allow(record: Decision) -> Decision:
        asked.append(record.id)
        return dataclasses.replace(record,
                                   outcome=Outcome.ALLOW,
                                   scope=Scope.ONCE)

    ledger = Decisions(on_ask=allow)
    ask = Ask("sign-off", rule=RULE)
    line = HandOff()
    assert await ledger.resolve(_ctx(), ask, None, _at(line)) is None
    assert len(asked) == 1
    for _ in range(2):
        assert await ledger.resolve(_ctx(), ask, None, _at(line)) is None
    assert len(asked) == 1
    assert len(line.claimed) == 1
    assert len(ledger.list("s")) == 1
    await ledger.revoke("s", line)
    assert ledger.list("s") == ()
    assert await ledger.resolve(_ctx(), ask) is None
    assert len(asked) == 2


@pytest.mark.asyncio
async def test_a_gates_own_answer_is_bound_to_its_place():
    """A question a gate raises itself, on a line no pass read for it,
    is answered for the line the same way: the grant is claimed for the
    gate's place, a second visit runs on it, another place on the line
    is a question of its own, and the line's end spends them all. Off a
    line, a reader spends what it matched at once."""
    asked = []

    async def allow(record: Decision) -> Decision:
        asked.append(record.id)
        return dataclasses.replace(record,
                                   outcome=Outcome.ALLOW,
                                   scope=Scope.ONCE)

    ledger = Decisions(on_ask=allow)
    ask = Ask("sign-off", rule=RULE)
    line = HandOff()
    assert await ledger.resolve(_ctx(), ask, None, _at(line, 0)) is None
    assert len(asked) == 1
    assert len(line.claimed) == 1
    assert await ledger.resolve(_ctx(), ask, None, _at(line, 0)) is None
    assert len(asked) == 1
    assert await ledger.resolve(_ctx(), ask, None, _at(line, 1)) is None
    assert len(asked) == 2
    assert len(line.claimed) == 2
    assert isinstance(ledger.held(_ctx(), ask), Pending)
    await ledger.revoke("s", line)
    assert ledger.list("s") == ()
    assert await ledger.resolve(_ctx(), ask) is None
    assert len(asked) == 3
    assert ledger.list("s") == ()


class _YieldingStore:
    """A session store whose flush waits on I/O, as a persistent one
    does; the in-memory ledger never yields, which is what hid the
    window below."""

    def __init__(self) -> None:
        self.records: dict[str, tuple[Decision, ...]] = {}
        self.flushes = 0

    def decision_sessions(self) -> tuple[str, ...]:
        return tuple(self.records)

    def decisions_of(self, session_id: str) -> tuple[Decision, ...]:
        return self.records.get(session_id, ())

    def set_decisions(self, session_id: str, records: tuple[Decision,
                                                            ...]) -> None:
        self.records[session_id] = records

    async def flush(self) -> None:
        self.flushes += 1
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_an_inline_grant_is_claimed_before_the_ledger_yields():
    """A host's inline nod is claimed for the asking line in the same
    step that records it, before the flush waits on the store. A line
    judged during that wait finds the grant claimed, not standing, and
    asks for itself; it used to take the nod, and the first line,
    resuming to find its nod gone, ran on nothing at all."""
    asked = []

    async def allow(record: Decision) -> Decision:
        asked.append(record.id)
        return dataclasses.replace(record,
                                   outcome=Outcome.ALLOW,
                                   scope=Scope.ONCE)

    store = _YieldingStore()
    ledger = Decisions(store, on_ask=allow)
    ask = Ask("sign-off", rule=RULE)
    first, second = HandOff(), HandOff()
    running = asyncio.ensure_future(
        ledger.resolve(_ctx(), ask, None, _at(first)))
    # Two flushes in, the question has been recorded and then answered,
    # and the first line is parked in the flush of its answer.
    for _ in range(8):
        if store.flushes >= 2:
            break
        await asyncio.sleep(0)
    assert store.flushes == 2
    assert not running.done()
    assert [r.outcome for r in ledger.list("s")] == [Outcome.ALLOW]
    assert len(asked) == 1
    assert await ledger.resolve(_ctx(), ask, None, _at(second)) is None
    assert len(asked) == 2
    assert await running is None
    assert len(first.claimed) == 1
    assert len(second.claimed) == 1
    assert len(ledger.list("s")) == 2
    await ledger.revoke("s", first)
    await ledger.revoke("s", second)
    assert ledger.list("s") == ()


@pytest.mark.asyncio
async def test_every_job_launched_from_one_place_runs_on_its_grant():
    """A loop launching the same job twice hands each job a copy of the
    grant claimed for the one place they share; the grant stays hidden
    from every other line while any holder lives and is spent when the
    last of them ends."""
    ledger = Decisions()
    ask = Ask("sign-off", rule=RULE)
    waiting = await ledger.resolve(_ctx(), ask)
    assert isinstance(waiting, Pending)
    await ledger.answer(waiting.id, Outcome.ALLOW)
    line = HandOff()
    assert await ledger.resolve(_ctx(), ask, None, _at(line)) is None
    scope = Occurrence(None, "line", 0, 1)
    first = ledger.split("s", line, scope)
    second = ledger.split("s", line, scope)
    assert len(first.claimed) == 1
    assert len(second.claimed) == 1
    await ledger.revoke("s", line)
    assert len(ledger.list("s")) == 1
    assert isinstance(ledger.held(_ctx(), ask), Pending)
    assert await ledger.resolve(_ctx(), ask, None, _at(first)) is None
    await ledger.revoke("s", first)
    assert len(ledger.list("s")) == 1
    assert await ledger.resolve(_ctx(), ask, None, _at(second)) is None
    await ledger.revoke("s", second)
    assert ledger.list("s") == ()


@pytest.mark.asyncio
async def test_a_nested_lines_claims_are_handed_to_the_line_it_ran_from():
    """What a nested line's gate claims goes to the outer line when the
    nested line ends, so the next evaluation from the same node runs
    on it, and the typed line's end spends it; a typed line's own
    hand-off is spent, never handed up."""
    asked = []

    async def allow(record: Decision) -> Decision:
        asked.append(record.id)
        return dataclasses.replace(record,
                                   outcome=Outcome.ALLOW,
                                   scope=Scope.ONCE)

    ledger = Decisions(on_ask=allow)
    ask = Ask("sign-off", rule=RULE)
    outer = HandOff()
    first = HandOff(parent=outer)
    assert await ledger.resolve(_ctx(), ask, None, _at(first)) is None
    assert len(asked) == 1
    assert len(first.claimed) == 1
    ledger.hand_up("s", first)
    assert first.claimed == []
    assert len(outer.claimed) == 1
    assert isinstance(ledger.held(_ctx(), ask), Pending)
    second = HandOff(parent=outer)
    assert await ledger.resolve(_ctx(), ask, None, _at(second)) is None
    assert len(asked) == 1
    ledger.hand_up("s", second)
    assert len(outer.claimed) == 1
    await ledger.revoke("s", outer)
    assert ledger.list("s") == ()
    with pytest.raises(ValueError):
        ledger.hand_up("s", HandOff())
