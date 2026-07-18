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
from mirage.io.stream import async_chain, materialize
from mirage.shell.types import ERREXIT_EXEMPT_TYPES
from mirage.shell.types import NodeType as NT
from mirage.utils.errors import format_fs_error
from mirage.workspace.executor.jobs import handle_background
from mirage.workspace.types import ExecutionNode


async def execute_program(
    recurse,
    node,
    session,
    stdin,
    call_stack,
    job_table,
    agent_id,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Execute program node (root / semicolon-separated)."""
    children = node.children
    all_stdout: list[Any] = []
    merged_io = IOResult()
    last_exec = ExecutionNode(command="", exit_code=0)

    i = 0
    while i < len(children):
        child = children[i]

        if (not child.is_named or child.type == NT.ERROR
                or child.type == NT.COMMENT):
            if child.type == NT.SEMI:
                i += 1
                continue
            i += 1
            continue

        # Check for background: named node followed by & token
        is_bg = (i + 1 < len(children)
                 and children[i + 1].type == NT.BACKGROUND)

        if is_bg:
            stdout, io, last_exec = await handle_background(
                recurse, child, None, session, job_table, agent_id, stdin,
                call_stack)
            i += 2
        else:
            stdout, io, last_exec = await recurse(child, session, stdin,
                                                  call_stack)
            # Materialize stdout so lazy exit codes (e.g. from
            # exit_on_empty in grep) are finalized before $? is set.
            drain_err: bytes | None = None
            try:
                stdout = await materialize(stdout)
            except OSError as exc:
                # Lazy reads (head/tail opening the stream mid-pipeline) can
                # fail on the first pull; format as a GNU coreutils line,
                # respelling the path as typed via the operands the leaf
                # node carries, mirroring the eager executor chokepoint.
                cmd_name = (last_exec.command.split()[0]
                            if last_exec.command else "")
                drain_err = format_fs_error(cmd_name, exc, last_exec.paths)
                stdout = None
            except Exception as exc:
                drain_err = f"{exc}\n".encode()
                stdout = None
            io.sync_exit_code()
            if drain_err is not None:
                existing = await materialize(io.stderr) or b""
                io.stderr = existing + drain_err
                io.exit_code = 1
            session.last_exit_code = io.exit_code
            i += 1

        if stdout is not None:
            all_stdout.append(stdout)
        merged_io = await merged_io.merge(io)

        if (io.exit_code != 0 and session.shell_options.get("errexit")
                and not is_bg and child.type not in ERREXIT_EXEMPT_TYPES):
            merged_io.exit_code = io.exit_code
            break

    if len(all_stdout) == 1:
        return all_stdout[0], merged_io, last_exec
    combined = async_chain(*all_stdout) if all_stdout else None
    return combined, merged_io, last_exec
