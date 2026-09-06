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

from typing import Any

from mirage.io import IOResult
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource
from mirage.shell.call_stack import CallStack
from mirage.shell.constants import ERREXIT_EXEMPT_TYPES
from mirage.shell.variable import ShellVar
from mirage.types import PathSpec, word_text
from mirage.workspace.executor.command.types import ExecuteNodeFn
from mirage.workspace.executor.control import ReturnSignal
from mirage.workspace.executor.statement import finish_statement
from mirage.workspace.session import Session
from mirage.workspace.session.state import restore_locals
from mirage.workspace.types import ExecutionNode


async def run_shell_function(
    execute_node: ExecuteNodeFn,
    cmd_name: str,
    parts: list[str | PathSpec],
    session: Session,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run a user-defined shell function's body statement by statement.

    Locals declared with ``local``/``declare`` shadow and restore on
    exit, ``return`` stops the body via :class:`ReturnSignal`, ``$?``
    tracks each inner statement, and ``set -e`` aborts the body on the
    first failing statement exactly as it does at top level.

    Args:
        execute_node (ExecuteNodeFn): the executor's statement runner.
        cmd_name (str): the function's name (already resolved).
        parts (list[str | PathSpec]): classified command words; the
            tail becomes the function's positional arguments as typed.
        session (Session): session whose env/arrays host the locals.
        stdin (ByteSource | None): stdin forwarded to each statement.
        call_stack (CallStack | None): the caller's stack, or a fresh
            one for a top-level call.
    """
    func_body = session.functions[cmd_name]
    cs = call_stack if call_stack is not None else CallStack()
    # Positional args carry the word as typed ($1 stays sub/a.txt).
    text_args = [word_text(p) for p in parts[1:]]
    cs.push(text_args, function_name=cmd_name)
    # One stack: a local shadows the whole record, so the caller's
    # value and attributes are saved and put back together.
    saved_locals: dict[str, ShellVar | None] = {}
    # The caller's frame is kept and put back: a function that calls
    # another and then declares a `local` is still inside a function,
    # and its own shadows must keep being recorded on its own frame.
    outer_locals = session._local_vars
    session._local_vars = saved_locals
    session._local_frames.append(saved_locals)
    try:
        all_stdout: list[Any] = []
        merged_io = IOResult()
        last_exec = ExecutionNode(command=cmd_name, exit_code=0)
        for cmd in func_body:
            try:
                stdout, io, last_exec = await execute_node(
                    cmd, session, stdin, cs)
            except ReturnSignal as sig:
                if sig.stderr:
                    merged_io = await merged_io.merge(
                        IOResult(stderr=sig.stderr))
                merged_io.exit_code = sig.exit_code
                break
            # $? tracks each statement inside the body, so a bare
            # `return` (and mid-function $?) sees the last command.
            stdout = await finish_statement(stdout, io, session, cmd)
            if stdout is not None:
                all_stdout.append(stdout)
            merged_io = await merged_io.merge(io)
            if (io.exit_code != 0 and session.shell_options.get("errexit")
                    and cmd.type not in ERREXIT_EXEMPT_TYPES
                    and not session.errexit_immune):
                merged_io.exit_code = io.exit_code
                break
        combined = async_chain(*all_stdout) if all_stdout else None
        last_exec.exit_code = merged_io.exit_code
        return combined, merged_io, last_exec
    finally:
        cs.pop()
        restore_locals(session, saved_locals)
        session._local_frames.pop()
        session._local_vars = outer_locals
