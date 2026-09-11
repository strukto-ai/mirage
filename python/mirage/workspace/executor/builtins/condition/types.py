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

from dataclasses import dataclass
from typing import Union

from mirage.ops.types import SessionView
from mirage.runtime.types import DispatchFn
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import Session

CondNode = Union["CondWord", "CondUnary", "CondBinary", "CondNot", "CondAnd",
                 "CondOr"]


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

    def __init__(self,
                 message: str,
                 exit_code: int = 2,
                 fatal: bool = True) -> None:
        super().__init__(message)
        self.message = message
        self.exit_code = exit_code
        self.fatal = fatal


@dataclass(frozen=True, slots=True)
class CondContext:
    dispatch: DispatchFn
    namespace: Namespace
    session: Session
    name: str
    # The session plane's gated door, which an assignment inside a
    # numeric operand lands through; None outside a workspace.
    view: SessionView | None = None
