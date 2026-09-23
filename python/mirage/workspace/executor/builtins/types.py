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
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.shell.call_stack import CallStack
from mirage.workspace.expand.argv import Argv
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode

Result = tuple[ByteSource | None, IOResult, ExecutionNode]


@dataclass(frozen=True, slots=True)
class BuiltinCall:
    """One shell-builtin invocation, as the dispatcher hands it to the table.

    Every executor-run builtin takes exactly this and nothing else, so
    the table maps a name to a function of one argument and the
    dispatcher does one lookup instead of one arm per word. A builtin
    reads the fields it needs and ignores the rest.

    Args:
        argv (Argv): the expanded line: name, text args, classified
            operands, and the words as typed.
        session (SessionState): the shell session the builtin acts on.
        stdin (ByteSource | None): the line's standard input, if piped.
        call_stack (CallStack | None): the function-call stack, which
            holds the positional parameters.
        cancel (asyncio.Event | None): set when the run is being
            cancelled; ``sleep`` watches it.
        row (int): the command's line within its parse; only ``alias``
            reads it, so a definition is invisible to a use on the same
            line, as bash's line reader has it.
        dispatch (DispatchFn): the op dispatcher door.
        registry (MountRegistry): the mount registry.
        namespace (Namespace): the name plane (links, node table).
        execute_fn (Callable[..., Any]): runs a text line in this
            session (``eval``, ``source``, ``xargs``, ...).
    """
    argv: Argv
    session: SessionState
    stdin: ByteSource | None
    call_stack: CallStack | None
    cancel: asyncio.Event | None
    row: int
    dispatch: DispatchFn
    registry: MountRegistry
    namespace: Namespace
    execute_fn: Callable[..., Any]


BuiltinFn = Callable[[BuiltinCall], Awaitable[Result]]
