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
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


async def handle_xargs(
    execute_fn: Callable,
    args: list[str],
    session: Session,
    stdin: ByteSource | None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run a command with words read from stdin appended (GNU xargs).

    GNU xargs execs the command directly, so every input word must
    reach it as exactly one argv token. The inner line is built with
    shlex.join: a plain join would be re-parsed by the shell, splitting
    words with whitespace and executing $(...) found in input.

    Args:
        execute_fn (Callable): shell evaluator for the inner line.
        args (list[str]): command name and initial arguments; defaults
            to ["echo"] like GNU when absent.
        session (Session): shell session state.
        stdin (ByteSource | None): input whose words become arguments.
    """
    data = await materialize(stdin)
    if data is None:
        data = b""
    input_args = data.decode(errors="replace").split()
    inner = shlex.join([*(args or ["echo"]), *input_args])
    io = await execute_fn(inner, session_id=session.session_id)
    return io.stdout, io, ExecutionNode(command="xargs",
                                        exit_code=io.exit_code)
