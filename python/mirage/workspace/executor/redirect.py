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
from mirage.shell.types import Redirect, RedirectKind
from mirage.types import PathSpec
from mirage.workspace.executor.builtins import _to_scope
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode

_TO_STDOUT = object()
_TO_STDERR = object()


async def handle_redirect(
    execute_node,
    dispatch,
    command: tree_sitter.Node | None,
    redirects: list[Redirect],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Handle all redirect patterns: >, >>, <, 2>, 2>&1, &>, >&2, <<<.

    File-descriptor routing follows bash's left-to-right fd table:
    each redirect updates where fd1/fd2 point at that moment, so
    `cmd > f 2>&1` sends both streams to f while `cmd 2>&1 > f`
    sends stderr to the original stdout. Output files are created (and
    truncated unless appending) when the redirect is processed, even
    if the stream ends up empty — including the command-less
    `> file` form (command is None).

    Deliberate divergence from bash: when both streams route to the
    same destination they are concatenated stdout-then-stderr, not
    temporally interleaved (streams are materialized buffers).
    """
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

    if command is None:
        stdout_data = b""
        stderr_data = b""
        io = IOResult(exit_code=0)
    else:
        stdout, io, _ = await execute_node(command, session, cmd_stdin,
                                           call_stack)
        barriered = await apply_barrier(stdout, io, BarrierPolicy.VALUE)
        if isinstance(barriered, memoryview):
            barriered = bytes(barriered)
        stdout_data = await materialize(barriered) or b""
        stderr_data = await materialize(io.stderr) or b""

    fd1: object = _TO_STDOUT
    fd2: object = _TO_STDERR
    file_bufs: dict[str, bytearray] = {}
    file_scopes: dict[str, PathSpec] = {}

    for r in redirects:
        if r.kind in (RedirectKind.STDIN, RedirectKind.HEREDOC,
                      RedirectKind.HERESTRING):
            continue

        # 2>&1 — fd2 follows wherever fd1 points right now
        if r.kind == RedirectKind.STDERR_TO_STDOUT and isinstance(
                r.target, int):
            fd2 = fd1
            continue

        # >&2 or 1>&2 — fd1 follows wherever fd2 points right now
        if r.fd == 1 and isinstance(r.target, int) and r.target == 2:
            fd1 = fd2
            continue

        # other numeric dups (3>&1, ...) are not simulated
        if isinstance(r.target, int):
            continue

        scope = _ensure_scope(r.target)
        path = scope.virtual
        file_scopes[path] = scope
        if r.append:
            if path not in file_bufs:
                file_bufs[path] = bytearray(await
                                            _read_existing(dispatch, scope))
        else:
            file_bufs[path] = bytearray()

        if r.fd == -1:  # &> / &>>
            fd1 = path
            fd2 = path
        elif r.kind == RedirectKind.STDERR:
            fd2 = path
        else:
            fd1 = path

    out_stdout = bytearray()
    out_stderr = bytearray()
    for data, dest in ((stdout_data, fd1), (stderr_data, fd2)):
        if dest is _TO_STDOUT:
            out_stdout += data
        elif dest is _TO_STDERR:
            out_stderr += data
        elif isinstance(dest, str):
            file_bufs[dest] += data

    for path, buf in file_bufs.items():
        data = bytes(buf)
        await dispatch("write", file_scopes[path], data=data)
        io.writes[path] = data

    result_stdout = bytes(out_stdout)
    io.stderr = bytes(out_stderr) if out_stderr else None
    exec_node = ExecutionNode(command="redirect", exit_code=io.exit_code)
    return result_stdout if result_stdout else None, io, exec_node


async def _read_existing(dispatch, scope) -> bytes:
    try:
        existing, _ = await dispatch("read", scope)
        if isinstance(existing, bytes):
            return existing
    except FileNotFoundError:
        # appending to a missing file starts from empty
        pass
    return b""


def _ensure_scope(target):
    if isinstance(target, PathSpec):
        return target
    if isinstance(target, str):
        return _to_scope(target)
    return _to_scope(str(target))
