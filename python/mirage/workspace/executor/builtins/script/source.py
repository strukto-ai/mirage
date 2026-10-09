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

from collections.abc import Callable
from typing import Any

from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.shell.call_stack import CallStack
from mirage.shell.console import JobConsole
from mirage.shell.errors import ExitSignal, ReturnSignal
from mirage.types import PathSpec, word_text
from mirage.workspace.executor.builtins.scope import _scope_path
from mirage.workspace.executor.builtins.script.constants import SOURCE_USAGE
from mirage.workspace.executor.builtins.script.script import (
    read_script_text,
    script_error,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.executor.control import ended, returning
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import (
    positional_params,
    set_positional_params,
)
from mirage.workspace.types import ExecutionNode


async def handle_source(
    dispatch: DispatchFn,
    execute_fn: Callable[..., Any],
    path: str | PathSpec,
    session: SessionState,
    args: list[str] | None = None,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    sink: JobConsole | None = None,
    name: str = "source",
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Read a script file and execute it in the calling shell.

    Unlike a nested shell, a sourced file *is* the caller, so whatever
    it sets stays set: `source f` where f runs `set -x` leaves the
    caller tracing. Only the positional parameters come back, because
    bash restores those and nothing else. It runs in a frame of its own,
    which ``return`` ends, ``FUNCNAME`` names ``source`` and the RETURN
    action runs in as it returns; a ``break`` in it ends a caller's loop.
    An empty name fails as a missing file does, and bash blames a file it
    cannot read on itself, not the builtin.

    Args:
        dispatch (DispatchFn): op dispatcher, used to read the file.
        execute_fn (Callable): runs the script text in this session.
        path (str | PathSpec): the script to source.
        session (SessionState): shell session state.
        args (list[str] | None): positional parameters to expose to the
            script. When given they replace ``$1..$#`` for the duration
            of the source and are restored afterwards, matching bash;
            when omitted the parameters in scope are the script's, and
            a ``shift`` or ``set --`` in it changes them.
        stdin (ByteSource | None): the caller's standard input, which
            the script's statements read in turn.
        call_stack (CallStack | None): the caller's frames, which the
            file runs on: sourced inside a function it sees the
            function's parameters, its locals and its loops.
        sink (JobConsole | None): where the script's statements write as
            they finish, None to return them.
        name (str): the builtin as typed, ``source`` or ``.``.
    """
    raw = _scope_path(path)
    if word_text(path) == "":
        return script_error(
            "bash", ": No such file or directory", 1, command="source "
        )
    try:
        script = await read_script_text(dispatch, raw, session.cwd)
    except IsADirectoryError:
        return script_error(
            f"bash: {name}", f"{raw}: is a directory", 1, f"source {raw}"
        )
    except FS_ERRORS as exc:
        return script_error(
            "bash", f"{raw}: {fs_strerror(exc)}", 1, f"source {raw}"
        )
    cs = call_stack if call_stack is not None else CallStack()
    cs.push(args or list(positional_params(session, cs)), "source", True)
    outer_names = session.function_names
    if outer_names is not None:
        session.function_names = cs.function_names()
    try:
        try:
            io = await execute_fn(
                script,
                session_id=session.session_id,
                stdin=stdin,
                sink=sink,
                call_stack=cs,
            )
        except ReturnSignal as sig:
            io = ended(sig)
        stdout, io = await returning(
            execute_fn, session, stdin, cs, io.stdout, io
        )
    except ExitSignal as sig:
        sig.sourced = True
        raise
    finally:
        frame = cs.pop()
        if session.function_names is not None:
            session.function_names = outer_names
        if not args:
            set_positional_params(session, cs, frame.positional)
    return (
        stdout,
        io,
        ExecutionNode(command=f"source {raw}", exit_code=io.exit_code),
    )


async def source_builtin(call: BuiltinCall) -> Result:
    """The ``source`` / ``.`` arm.

    Positional parameters keep the words as typed, so a path operand
    contributes its spelling, not its resolved mount path.

    Args:
        call (BuiltinCall): the invocation.
    """
    operands = list(call.argv.operands)
    name = str(call.argv.name)
    if not operands:
        return script_error(
            f"bash: {name}", SOURCE_USAGE.format(name=name), 2, name
        )
    return await handle_source(
        call.dispatch,
        call.execute_fn,
        operands[0],
        call.context.session,
        [word_text(o) for o in operands[1:]],
        call.stdin,
        call.call_stack,
        call.sink,
        name,
    )
