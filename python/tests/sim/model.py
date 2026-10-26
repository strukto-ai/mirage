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

from dataclasses import dataclass, field

from tests.sim.trace import (
    ABSENT,
    Change,
    Intent,
    Served,
    State,
    StepRef,
    Trace,
    show,
    state_of,
)


def stamped(seen: bytes | None, step: StepRef, observed: bool) -> bytes:
    """The body ``step`` writes: what it saw plus one stamp line.

    The stamp names the writing line and the state it wrote on, so the
    stored bytes say who wrote them, and no two writes store equal bytes.

    Args:
        seen (bytes | None): the content the actor last saw, None when
            it saw no object.
        step (StepRef): the writing line.
        observed (bool): whether the actor saw the key at all.
    """
    claim = show(state_of(seen)) if observed else "unobserved"
    return (seen or b"") + f"{step}@{claim}\n".encode()


@dataclass(frozen=True, slots=True)
class LostUpdate:
    """A committed write or remove that replaced a state its line never
    observed."""

    step: StepRef
    key: str
    basis: State
    replaced: Change

    def __str__(self) -> str:
        return (
            f"{self.step} committed {self.key} over "
            f"{show(self.replaced.before)}, its basis was {show(self.basis)}"
        )


@dataclass(slots=True)
class Verdict:
    """What ``no_lost_update`` found in one trace."""

    lost: list[LostUpdate] = field(default_factory=list)
    blind: int = 0
    unjudged: list[Served] = field(default_factory=list)


def _judge(
    verdict: Verdict, step: StepRef, basis: State | None, first: Change
) -> None:
    if basis is None:
        verdict.blind += 1
    elif first.before != basis:
        verdict.lost.append(LostUpdate(step, first.key, basis, first))


def no_lost_update(trace: Trace) -> Verdict:
    """Judge every modeled write and remove against its actor's basis.

    The basis per (actor, key) follows #432's rules, derived from the
    trace alone:

    - a read moves it to the state it returned; a failed read, a false
      ``test -e`` or an ``rm -f`` that found nothing moves it to ABSENT;
    - a true ``test -e`` reads no content, so it leaves the basis alone;
    - an own write or remove that commits moves it to the state it left,
      so overwriting one's own write is never a loss;
    - a refused write or remove keeps it;
    - a key never observed has none, and a write to it is blind: legal,
      and counted.

    A commit is lost when the state it replaced is not its basis. A
    line that commits in two requests is judged on its first. States
    are content digests; modeled writes are stamped, so no two of them
    store equal bytes. A commit no modeled line on its key accounts for
    is listed as unjudged, so a gap in attribution cannot hide a loss.

    Args:
        trace (Trace): the run.
    """
    verdict = Verdict()
    basis: dict[tuple[str, str], State] = {}
    commits: dict[tuple[StepRef | None, str], list[Change]] = {}
    for served in trace.served():
        for change in served.changes:
            commits.setdefault((served.step, change.key), []).append(change)
    judged: set[tuple[StepRef, str]] = set()
    for line in trace.lines():
        if line.key is None or line.intent is Intent.RAW:
            continue
        slot = (line.step.actor, line.key)
        if line.intent is Intent.READS:
            basis[slot] = (
                state_of(line.stdout) if line.exit_code == 0 else ABSENT
            )
            continue
        if line.intent is Intent.TESTS:
            if line.exit_code == 1:
                basis[slot] = ABSENT
            continue
        made = commits.get((line.step, line.key), [])
        judged.add((line.step, line.key))
        if made:
            _judge(verdict, line.step, basis.get(slot), made[0])
            basis[slot] = made[-1].after
        elif line.intent is Intent.REMOVES and line.exit_code == 0:
            basis[slot] = ABSENT
    verdict.unjudged = [
        served
        for served in trace.served()
        if any((served.step, c.key) not in judged for c in served.changes)
    ]
    return verdict
