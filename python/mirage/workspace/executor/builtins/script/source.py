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

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec, word_text
from mirage.utils.errors import FS_ERRORS, fs_strerror
from mirage.workspace.executor.builtins.scope import _scope_path
from mirage.workspace.executor.builtins.script.constants import SOURCE_USAGE
from mirage.workspace.executor.builtins.script.script import (read_script_text,
                                                              script_error)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


async def handle_source(
    dispatch: DispatchFn,
    execute_fn: Callable[..., Any],
    path: str | PathSpec,
    session: SessionState,
    args: list[str] | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Read a script file and execute it in the calling shell.

    Unlike a nested shell, a sourced file *is* the caller, so whatever
    it sets stays set: `source f` where f runs `set -x` leaves the
    caller tracing. Only the positional parameters come back, because
    bash restores those and nothing else.

    Args:
        dispatch (DispatchFn): op dispatcher, used to read the file.
        execute_fn (Callable): runs the script text in this session.
        path (str | PathSpec): the script to source.
        session (SessionState): shell session state.
        args (list[str] | None): positional parameters to expose to the
            script. When given they replace ``$1..$#`` for the duration
            of the source and are restored afterwards, matching bash;
            when omitted the parent's positional parameters are kept.
    """
    raw = _scope_path(path)
    if not raw:
        return script_error("source", SOURCE_USAGE, 2)
    try:
        script = await read_script_text(dispatch, raw, session.cwd)
    except FS_ERRORS as exc:
        return script_error("source",
                            f"{raw}: {fs_strerror(exc)}",
                            1,
                            command=f"source {raw}")
    saved_positional: list[str] | None = None
    if args:
        saved_positional = session.positional_args
        session.positional_args = args
    session.source_depth += 1
    try:
        io = await execute_fn(script, session_id=session.session_id)
    finally:
        session.source_depth -= 1
        if saved_positional is not None:
            session.positional_args = saved_positional
    return io.stdout, io, ExecutionNode(command=f"source {raw}",
                                        exit_code=io.exit_code)


async def source_builtin(call: BuiltinCall) -> Result:
    """The ``source`` / ``.`` arm.

    Positional parameters keep the words as typed, so a path operand
    contributes its spelling, not its resolved mount path.

    Args:
        call (BuiltinCall): the invocation.
    """
    operands = list(call.argv.operands)
    path = operands[0] if operands else ""
    return await handle_source(call.dispatch, call.execute_fn, path,
                               call.session,
                               [word_text(o) for o in operands[1:]])
