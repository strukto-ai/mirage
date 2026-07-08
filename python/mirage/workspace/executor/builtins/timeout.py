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

import shlex
from collections.abc import Callable

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


async def handle_timeout(
    execute_fn: Callable,
    args: list[str],
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run `timeout DURATION COMMAND [ARG...]`.

    The inner line is built with shlex.join so already-expanded words
    survive re-parsing as one token each (GNU timeout execs the command
    without a shell). The duration is not yet enforced; enforcement
    lands with the shell-builtin specs work.

    Args:
        execute_fn (Callable): shell evaluator for the inner line.
        args (list[str]): duration operand followed by the command.
        session (Session): shell session state.
    """
    if len(args) >= 2:
        inner = shlex.join(args[1:])
        io = await execute_fn(inner, session_id=session.session_id)
        return io.stdout, io, ExecutionNode(command="timeout",
                                            exit_code=io.exit_code)
    return None, IOResult(), ExecutionNode(command="timeout", exit_code=0)
