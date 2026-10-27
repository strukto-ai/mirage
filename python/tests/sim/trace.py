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

import hashlib
from contextvars import ContextVar
from dataclasses import dataclass
from enum import Enum


class Absent(Enum):
    """The state of a key with no object."""

    ABSENT = "absent"


ABSENT = Absent.ABSENT

State = str | Absent


def state_of(content: bytes | None) -> State:
    """The digest of ``content``, or ABSENT for no object.

    Args:
        content (bytes | None): the stored bytes.
    """
    if content is None:
        return ABSENT
    return hashlib.md5(content).hexdigest()


def show(state: State) -> str:
    """``state`` as the trace prints it, the digest cut to 8 digits.

    Args:
        state (State): a digest or ABSENT.
    """
    return state.value if isinstance(state, Absent) else state[:8]


@dataclass(frozen=True, slots=True)
class StepRef:
    """One top-level line of one actor."""

    actor: str
    step: int

    def __str__(self) -> str:
        return f"{self.actor}.{self.step}"


STEP: ContextVar[StepRef | None] = ContextVar("sim_step", default=None)


@dataclass(frozen=True, slots=True)
class Change:
    """One key a request changed, as the store saw it."""

    key: str
    before: State
    after: State
    commit: int


@dataclass(frozen=True, slots=True)
class Requested:
    """A request left its caller."""

    seq: int
    at: float
    step: StepRef | None
    op: str
    key: str
    sent: tuple[tuple[str, str], ...]


@dataclass(frozen=True, slots=True)
class Served:
    """A request took effect on the store, or was refused by it."""

    seq: int
    at: float
    step: StepRef | None
    op: str
    key: str
    sent: tuple[tuple[str, str], ...]
    changes: tuple[Change, ...]
    error: str | None


class Intent(Enum):
    """What a modeled line means, so the model can judge it."""

    RAW = "raw"
    READS = "reads"
    WRITES = "writes"
    TESTS = "tests"
    REMOVES = "removes"


@dataclass(frozen=True, slots=True)
class LineDone:
    """A top-level line finished."""

    at: float
    step: StepRef
    text: str
    intent: Intent
    key: str | None
    exit_code: int
    stdout: bytes


Event = Requested | Served | LineDone


class Trace:
    """The one record of a run; every check reads it, nothing else."""

    def __init__(self) -> None:
        self.events: list[Event] = []

    def append(self, event: Event) -> None:
        """Record ``event``.

        Args:
            event (Event): what happened.
        """
        self.events.append(event)

    def served(self) -> list[Served]:
        """Every request that reached the store, in order."""
        return [e for e in self.events if isinstance(e, Served)]

    def lines(self) -> list[LineDone]:
        """Every finished line, in order."""
        return [e for e in self.events if isinstance(e, LineDone)]

    def render(self, key: str | None = None) -> str:
        """The trace as text, narrowed to ``key`` when given.

        Args:
            key (str | None): one key, or None for every event.
        """
        rows = []
        for event in self.events:
            if isinstance(event, LineDone):
                if key is None or event.key == key:
                    rows.append(
                        f"{event.at:.6f}  {event.step}  line exit="
                        f"{event.exit_code}  {event.text!r}"
                    )
                continue
            if key is not None and event.key != key:
                continue
            sent = " ".join(f"{k}={v}" for k, v in event.sent)
            head = (
                f"{event.at:.6f}  {event.step}  {event.op} {event.key} {sent}"
            )
            if isinstance(event, Requested):
                rows.append(f"{head}  sent")
            elif event.error is not None:
                rows.append(f"{head}  refused {event.error}")
            else:
                moved = ", ".join(
                    f"{c.key}: {show(c.before)} -> {show(c.after)} #{c.commit}"
                    for c in event.changes
                )
                rows.append(f"{head}  served {moved}".rstrip())
        return "\n".join(rows)
