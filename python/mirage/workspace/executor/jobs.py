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

import tree_sitter

from mirage.commands.builtin.utils.safeguard import CommandTimeoutError
from mirage.io import IOResult
from mirage.io.types import ByteSource, materialize
from mirage.shell.errors import ExitSignal
from mirage.shell.helpers import get_text
from mirage.shell.job_table import JobTable
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


async def handle_background(
    execute_node,
    left: tree_sitter.Node,
    right: tree_sitter.Node | None,
    session: Session,
    job_table: JobTable | None,
    agent_id: str | None,
    stdin: ByteSource | None = None,
    call_stack=None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run left side in background."""
    bg_session = session.fork()

    async def _run_bg():
        # Background jobs don't receive stdin, matching real shell
        # behavior where bg processes get /dev/null. This prevents
        # race conditions when stdin is an async iterator.
        cmd_str_inner = get_text(left) if hasattr(left, "text") else str(left)
        try:
            stdout, io, exec_node = await execute_node(left, bg_session, None,
                                                       call_stack)
        except CommandTimeoutError as exc:
            msg = (str(exc) + "\n").encode()
            io = IOResult(exit_code=124, stderr=msg)
            exec_node = ExecutionNode(command=cmd_str_inner,
                                      stderr=msg,
                                      exit_code=124)
            return b"", io, exec_node
        except ExitSignal as sig:
            # A background job is its own shell: exit ends the job only.
            io = IOResult(exit_code=sig.contained_code,
                          stderr=sig.stderr or None)
            exec_node = ExecutionNode(command=cmd_str_inner,
                                      stderr=sig.stderr,
                                      exit_code=sig.contained_code)
            return sig.stdout or b"", io, exec_node
        stdout = await materialize(stdout)
        # Eagerly materialize stderr too so JobTable._refresh can read
        # the task result synchronously without an async hop.
        await io.materialize_stderr()
        io.sync_exit_code()
        return stdout, io, exec_node

    task = asyncio.create_task(_run_bg())
    cmd_str = get_text(left) if hasattr(left, 'text') else str(left)

    if job_table is not None:
        job = job_table.submit(command=cmd_str,
                               task=task,
                               cwd=bg_session.cwd,
                               agent=agent_id or "",
                               session_id=session.session_id)
        session.last_bg_job_id = job.id
        job_line = f"[{job.id}]\n".encode()
    else:
        job_line = b"[bg]\n"

    if right is None:
        return None, IOResult(stderr=job_line), ExecutionNode(
            op="&",
            exit_code=0,
            children=[ExecutionNode(command=cmd_str, exit_code=0)])

    right_stdout, right_io, right_exec = await execute_node(
        right, session, stdin, call_stack)
    left_stderr = await materialize(right_io.stderr)
    right_io.stderr = (job_line + left_stderr if left_stderr else job_line)
    children = [
        ExecutionNode(command=cmd_str, exit_code=0),
        right_exec,
    ]
    return right_stdout, right_io, ExecutionNode(op="&",
                                                 exit_code=right_io.exit_code,
                                                 children=children)


async def handle_wait(
    job_table: JobTable,
    parts: list[str],
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    cmd_str = " ".join(parts)
    if len(parts) <= 1:
        await job_table.wait_all()
        return None, IOResult(), ExecutionNode(command=cmd_str, exit_code=0)
    raw = parts[1].lstrip("%")
    try:
        job_id = int(raw)
    except ValueError:
        err = f"wait: invalid job id: {parts[1]}\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=cmd_str,
                                                         exit_code=1,
                                                         stderr=err)
    job = job_table.get(job_id)
    if job is None:
        err = f"wait: no such job: {job_id}\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=cmd_str,
                                                         exit_code=1,
                                                         stderr=err)
    job = await job_table.wait(job_id)
    return job.stdout, IOResult(
        exit_code=job.exit_code,
        stderr=job.stderr or None,
    ), ExecutionNode(command=cmd_str, exit_code=job.exit_code)


async def handle_kill(
    job_table: JobTable,
    parts: list[str],
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    cmd_str = " ".join(parts)
    if len(parts) < 2:
        err = b"kill: usage: kill <job_id>\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=cmd_str,
                                                         exit_code=1,
                                                         stderr=err)
    raw = parts[1].lstrip("%")
    try:
        job_id = int(raw)
    except ValueError:
        err = f"kill: invalid job id: {parts[1]}\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=cmd_str,
                                                         exit_code=1,
                                                         stderr=err)
    killed = job_table.kill(job_id)
    if not killed:
        err = f"kill: no such job: {job_id}\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=cmd_str,
                                                         exit_code=1,
                                                         stderr=err)
    return None, IOResult(), ExecutionNode(command=cmd_str, exit_code=0)


async def handle_jobs(
    job_table: JobTable,
    parts: list[str],
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    cmd_str = " ".join(parts)
    lines = []
    for job in job_table.list_jobs():
        lines.append(f"[{job.id}] {job.status.value} {job.command}")
    job_table.pop_completed()
    out = ("\n".join(lines) + "\n").encode() if lines else b""
    return out, IOResult(), ExecutionNode(command=cmd_str, exit_code=0)


async def handle_ps(
    job_table: JobTable,
    parts: list[str],
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    cmd_str = " ".join(parts)
    running = job_table.running_jobs()
    lines = []
    for job in running:
        lines.append(f"{job.id}\t{job.command}")
    out = ("\n".join(lines) + "\n").encode() if lines else b""
    return out, IOResult(), ExecutionNode(command=cmd_str, exit_code=0)
