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

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Literal, TypeAlias, Union

from mirage.workspace.lookup.types import (
    CliTarget,
    Consumer,
    ExternalTarget,
    FunctionTarget,
)

if TYPE_CHECKING:
    from mirage.execution.job import JobTable
    from mirage.view.types import SessionView
    from mirage.workspace.executor.builtins.types import BuiltinFn, Result
    from mirage.workspace.expand.argv import Argv
    from mirage.workspace.session import SessionState


class NamespaceProgram(StrEnum):
    LN = "ln"
    READLINK = "readlink"
    GETFATTR = "getfattr"
    SETFATTR = "setfattr"
    CHMOD = "chmod"
    CHOWN = "chown"
    CHGRP = "chgrp"
    TOUCH = "touch"
    DF = "df"
    MOUNT = "mount"


NAMESPACE_PROGRAMS = {program.value: program for program in NamespaceProgram}

CommandWorker: TypeAlias = Callable[
    ["JobTable", list[str], "SessionState", "SessionView"], Awaitable["Result"]
]


@dataclass(frozen=True, slots=True)
class PathTarget:
    """The loader may delegate an absent absolute path to this runtime."""

    fallback: ExternalTarget | None


@dataclass(frozen=True, slots=True)
class WorkerTarget:
    """A job or machine-view builtin that reads the process table."""

    handler: CommandWorker


@dataclass(frozen=True, slots=True)
class MountTarget:
    """Mount selection stays with its operands, including a wrapper's option."""

    wrapper: tuple[str, str] | None = None


HandlerTarget: TypeAlias = (
    WorkerTarget
    | FunctionTarget
    | CliTarget
    | MountTarget
    | Literal[Consumer.UNKNOWN]
)
ExecutionTarget: TypeAlias = Union[
    HandlerTarget,
    ExternalTarget,
    PathTarget,
    NamespaceProgram,
    "BuiltinFn",
    Literal["wrapper", "unsupported"],
    "Result",
]


@dataclass(frozen=True, slots=True)
class ResolvedCommand[T: ExecutionTarget]:
    """An admitted argv and its next action under the command's placement."""

    argv: Argv
    target: T
