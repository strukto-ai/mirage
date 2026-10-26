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

from tests.sim.model import no_lost_update, stamped
from tests.sim.trace import (
    ABSENT,
    Change,
    Intent,
    LineDone,
    Served,
    State,
    StepRef,
    Trace,
    state_of,
)

S0, S1, S2 = b"s0\n", b"s1\n", b"s2\n"


class _Script:
    def __init__(self) -> None:
        self.trace = Trace()
        self._steps: dict[str, int] = {}

    def _step(self, actor: str) -> StepRef:
        n = self._steps.get(actor, 0)
        self._steps[actor] = n + 1
        return StepRef(actor, n)

    def _line(
        self, actor: str, intent: Intent, exit_code: int, stdout: bytes = b""
    ) -> StepRef:
        step = self._step(actor)
        self.trace.append(
            LineDone(0.0, step, "", intent, "k", exit_code, stdout)
        )
        return step

    def read(self, actor: str, content: bytes | None) -> None:
        self._line(
            actor, Intent.READS, 1 if content is None else 0, content or b""
        )

    def test(self, actor: str, exists: bool) -> None:
        self._line(actor, Intent.TESTS, 0 if exists else 1)

    def remove_nothing(self, actor: str) -> None:
        self._line(actor, Intent.REMOVES, 0)

    def commit(
        self,
        actor: str,
        intent: Intent,
        *moves: tuple[State, State],
        step: StepRef | None = None,
    ) -> None:
        if step is None:
            step = StepRef(actor, self._steps.get(actor, 0))
        changes = tuple(Change("k", b, a, i) for i, (b, a) in enumerate(moves))
        for change in changes:
            self.trace.append(
                Served(0, 0.0, step, "put_object", "k", (), (change,), None)
            )
        self._line(actor, intent, 0)

    def refused(self, actor: str) -> None:
        step = StepRef(actor, self._steps.get(actor, 0))
        self.trace.append(
            Served(
                0, 0.0, step, "put_object", "k", (), (), "PreconditionFailed"
            )
        )
        self._line(actor, Intent.WRITES, 1)

    def lost(self) -> list[str]:
        return [str(lost.step) for lost in no_lost_update(self.trace).lost]


def test_a_write_over_the_state_it_read_is_kept():
    s = _Script()
    s.read("a", S0)
    s.commit("a", Intent.WRITES, (state_of(S0), state_of(S1)))
    assert s.lost() == []


def test_a_write_over_a_newer_state_is_lost():
    s = _Script()
    s.read("a", S0)
    s.commit("b", Intent.WRITES, (state_of(S0), state_of(S1)))
    s.commit("a", Intent.WRITES, (state_of(S1), state_of(S2)))
    assert s.lost() == ["a.1"]


def test_a_failed_read_or_a_false_test_observes_absence():
    for observe in ("read", "test"):
        s = _Script()
        if observe == "read":
            s.read("a", None)
        else:
            s.test("a", exists=False)
        s.commit("b", Intent.WRITES, (ABSENT, state_of(S1)))
        s.commit("a", Intent.WRITES, (state_of(S1), state_of(S2)))
        assert s.lost() == ["a.1"], observe


def test_a_true_test_reads_no_content_so_the_basis_stays():
    s = _Script()
    s.read("a", S0)
    s.commit("b", Intent.WRITES, (state_of(S0), state_of(S1)))
    s.test("a", exists=True)
    s.commit("a", Intent.WRITES, (state_of(S1), state_of(S2)))
    assert s.lost() == ["a.2"]


def test_a_remove_that_found_nothing_observes_absence():
    s = _Script()
    s.remove_nothing("a")
    s.commit("b", Intent.WRITES, (ABSENT, state_of(S1)))
    s.commit("a", Intent.WRITES, (state_of(S1), state_of(S2)))
    assert s.lost() == ["a.1"]


def test_a_refusal_keeps_the_basis():
    s = _Script()
    s.read("a", S0)
    s.commit("b", Intent.REMOVES, (state_of(S0), ABSENT))
    s.refused("a")
    s.commit("c", Intent.WRITES, (ABSENT, state_of(S1)))
    s.commit("a", Intent.WRITES, (state_of(S1), state_of(S2)))
    assert s.lost() == ["a.2"]


def test_a_line_that_commits_twice_is_judged_on_its_first():
    s = _Script()
    s.read("a", S0)
    s.commit(
        "a",
        Intent.WRITES,
        (state_of(S0), state_of(b"")),
        (state_of(b""), state_of(S1)),
    )
    assert s.lost() == []


def test_a_commit_no_modeled_line_accounts_for_is_unjudged():
    s = _Script()
    s.commit("a", Intent.WRITES, (ABSENT, state_of(S1)), step=StepRef("x", 9))
    verdict = no_lost_update(s.trace)
    assert [served.step for served in verdict.unjudged] == [StepRef("x", 9)]


def test_a_stamp_names_its_line_and_basis():
    step = StepRef("a", 3)
    assert stamped(S0, step, True) == S0 + f"a.3@{state_of(S0)}\n".encode()
    assert stamped(None, step, True) == b"a.3@absent\n"
    assert stamped(None, step, False) == b"a.3@unobserved\n"
