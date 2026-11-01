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

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Union

from mirage.policy.types import EntryGate
from mirage.runtime.types import DispatchFn
from mirage.view.types import LinkView, SessionView
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import SessionState

CondNode = Union[
    "CondWord",
    "CondUnary",
    "CondBinary",
    "CondNot",
    "CondAnd",
    "CondOr",
    "CondLazy",
]


@dataclass(frozen=True, slots=True)
class CondLazy:
    expand: Callable[[], Awaitable[CondNode]]


@dataclass(frozen=True, slots=True)
class CondWord:
    value: str


@dataclass(frozen=True, slots=True)
class CondUnary:
    op: str
    operand: str


@dataclass(frozen=True, slots=True)
class CondBinary:
    left: str
    op: str
    right: str


@dataclass(frozen=True, slots=True)
class CondNot:
    inner: CondNode


@dataclass(frozen=True, slots=True)
class CondAnd:
    left: CondNode
    right: CondNode


@dataclass(frozen=True, slots=True)
class CondOr:
    left: CondNode
    right: CondNode


# test's own reading of a flat argv (``flat_shape``): which words each
# operator takes, each named by its place in the argv, and where a
# grammar error stands, so it is raised where test's own parse meets it.
@dataclass(frozen=True, slots=True)
class FlatString:
    """The word at ``at``, true when it is not empty."""

    at: int


@dataclass(frozen=True, slots=True)
class FlatUnary:
    op: str
    at: int


@dataclass(frozen=True, slots=True)
class FlatBinary:
    left: int
    op: str
    right: int


@dataclass(frozen=True, slots=True)
class FlatNot:
    inner: "FlatNode"


@dataclass(frozen=True, slots=True)
class FlatAnd:
    """Terms joined by ``-a``, a chain held flat so its length costs no
    depth."""

    terms: tuple["FlatNode", ...]


@dataclass(frozen=True, slots=True)
class FlatOr:
    """Terms joined by ``-o``, held flat as ``FlatAnd``'s are."""

    terms: tuple["FlatNode", ...]


@dataclass(frozen=True, slots=True)
class FlatFail:
    """A grammar error, the test's whole answer once it is reached."""

    message: str


# None is the empty test, which is false.
FlatNode = Union[
    FlatString, FlatUnary, FlatBinary, FlatNot, FlatAnd, FlatOr, FlatFail, None
]


# Admits the words of a test as its own command, returning the gate its
# own I/O runs under; raises ``CondRefused``.
AdmitTest = Callable[[list[str]], Awaitable[EntryGate]]


@dataclass(frozen=True, slots=True)
class CondContext:
    dispatch: DispatchFn
    namespace: Namespace
    session: SessionState
    name: str
    # The gated session view, which an assignment inside a
    # numeric operand lands through; None outside a workspace.
    view: SessionView | None = None
    # The links as this session sees them: a hidden link is no link.
    links: LinkView | None = None
    # Admits each ``[[ ]]`` leaf as it is evaluated, its
    # branches expanding only then; None where the words were admitted
    # whole before the test ran (``test``, ``[``).
    admit: AdmitTest | None = None
