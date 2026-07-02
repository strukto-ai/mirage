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

import tree_sitter

from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.shell.barrier import BarrierPolicy, apply_barrier
from mirage.shell.call_stack import CallStack
from mirage.shell.helpers import _is_last_cmd_redirect, get_list_parts
from mirage.shell.types import Redirect, RedirectKind
from mirage.types import PathSpec
from mirage.workspace.executor.builtins import _to_scope
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


async def handle_redirect(
    execute_node,
    dispatch,
    command: tree_sitter.Node,
    redirects: list[Redirect],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Handle all redirect patterns: >, >>, <, 2>, 2>&1, &>, >&2, <<<."""
    cmd_stdin = stdin
    for r in redirects:
        if r.kind == RedirectKind.STDIN:
            scope = _ensure_scope(r.target)
            file_data, _ = await dispatch("read", scope)
            cmd_stdin = file_data
        elif r.kind == RedirectKind.HEREDOC:
            cmd_stdin = r.target.encode() if isinstance(r.target,
                                                        str) else r.target
        elif r.kind == RedirectKind.HERESTRING:
            text = r.target
            if isinstance(text, str):
                if text.startswith('"') and text.endswith('"'):
                    text = text[1:-1]
                elif text.startswith("'") and text.endswith("'"):
                    text = text[1:-1]
                cmd_stdin = (text + "\n").encode()
            else:
                cmd_stdin = text

    if (command.type == "list" and redirects
            and _is_last_cmd_redirect(command, redirects)):
        left, op, right = get_list_parts(command)
        left_stdout, left_io, left_exec = await execute_node(
            left, session, cmd_stdin, call_stack)
        left_bytes = await apply_barrier(left_stdout, left_io,
                                         BarrierPolicy.VALUE)
        session.last_exit_code = left_io.exit_code
        run_right = (op == "||" and left_io.exit_code
                     != 0) or (op == "&&" and left_io.exit_code == 0)
        if run_right:
            return await handle_redirect(execute_node, dispatch, right,
                                         redirects, session, cmd_stdin,
                                         call_stack)
        return left_bytes, left_io, left_exec

    stdout, io, exec_node = await execute_node(command, session, cmd_stdin,
                                               call_stack)

    stdout_data = await apply_barrier(stdout, io, BarrierPolicy.VALUE)
    if stdout_data is None:
        stdout_data = b""
    if isinstance(stdout_data, memoryview):
        stdout_data = bytes(stdout_data)

    stderr_data = await materialize(io.stderr)

    result_stdout = stdout_data
    result_stderr = stderr_data

    for r in redirects:
        stream = r.kind
        append = r.append
        fd = r.fd

        if stream in (RedirectKind.STDIN, RedirectKind.HEREDOC,
                      RedirectKind.HERESTRING):
            continue

        # 2>&1 — merge stderr into stdout
        if stream == RedirectKind.STDERR_TO_STDOUT and isinstance(
                r.target, int):
            result_stdout = (result_stdout or b"") + (result_stderr or b"")
            result_stderr = None
            continue

        # >&2 or 1>&2 — stdout to stderr
        if fd == 1 and isinstance(r.target, int) and r.target == 2:
            result_stderr = (result_stderr or b"") + (result_stdout or b"")
            result_stdout = None
            continue

        scope = _ensure_scope(r.target)
        path = scope.virtual

        # &> or &>> — both stdout+stderr to file
        if fd == -1:
            combined = (result_stdout or b"") + (result_stderr or b"")
            if append:
                combined = await _append_existing(dispatch, scope, combined)
            await dispatch("write", scope, data=combined)
            io.writes[path] = combined
            result_stdout = None
            result_stderr = None
            continue

        # 2> file — stderr to file
        if stream == RedirectKind.STDERR:
            data = result_stderr or b""
            if append:
                data = await _append_existing(dispatch, scope, data)
            if data:
                await dispatch("write", scope, data=data)
                io.writes[path] = data
            result_stderr = None
            continue

        # > or >> — stdout to file
        data = result_stdout or b""
        if append:
            data = await _append_existing(dispatch, scope, data)
        await dispatch("write", scope, data=data)
        io.writes[path] = data
        result_stdout = None

    io.stderr = result_stderr
    exec_node = ExecutionNode(command="redirect", exit_code=io.exit_code)
    return result_stdout if result_stdout else None, io, exec_node


async def _append_existing(dispatch, scope, data):
    try:
        existing, _ = await dispatch("read", scope)
        if isinstance(existing, bytes):
            return existing + data
    except FileNotFoundError:
        pass
    return data


def _ensure_scope(target):
    if isinstance(target, PathSpec):
        return target
    if isinstance(target, str):
        return _to_scope(target)
    return _to_scope(str(target))
