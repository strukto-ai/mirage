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
from mirage.types import Refusal
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
    # True when the right side was quoted: `[[ x == "a*" ]]` compares
    # literally while the unquoted form pattern-matches.
    right_literal: bool = False


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


class CondError(Exception):
    """A test/[/[[ usage error: bash prints the message and returns 2.

    A ``[[`` grammar error is a parse error that kills the line; an
    arithmetic error inside a numeric operand (``[[ 0 -eq 1/0 ]]``) is
    not: bash prints it and the test answers 1, the line going on, so it
    carries its own status and is never fatal.

    Args:
        message (str): diagnostic without trailing newline.
        exit_code (int): the status the test answers with.
        fatal (bool): whether a ``[[`` reports it as a parse error that
            ends the line.
    """

    def __init__(
        self, message: str, exit_code: int = 2, fatal: bool = True
    ) -> None:
        super().__init__(message)
        self.message = message
        self.exit_code = exit_code
        self.fatal = fatal


class CondRefused(Exception):
    """The gate refused a ``[ ]`` or a ``[[ ]]`` leaf: it answers that
    refusal, as ``test`` refused whole does.

    Args:
        stderr (bytes): the refusal's message, newline-terminated.
        exit_code (int): the status it answers with.
        refusal (Refusal | None): the record the result carries.
    """

    def __init__(
        self, stderr: bytes, exit_code: int, refusal: Refusal | None
    ) -> None:
        super().__init__(stderr)
        self.stderr = stderr
        self.exit_code = exit_code
        self.refusal = refusal


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
