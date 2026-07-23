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

from mirage.commands.builtin.utils.safeguard import CommandTimeoutError
from mirage.io import IOResult
from mirage.io.types import ByteSource, materialize
from mirage.shell.console import Channel, JobConsole
from mirage.shell.errors import ExitSignal
from mirage.shell.helpers import get_text
from mirage.shell.job_table import Job, JobTable
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


async def pump(console: JobConsole, channel: Channel,
               stream: ByteSource | None) -> None:
    """Send a command's output to a console as chunks arrive.

    Consuming the stream piece by piece rather than materializing it
    whole is what lets a reader watch a running job. A command that
    computes its output eagerly still lands in one chunk, because there
    was nothing to observe before it finished.

    Args:
        console (JobConsole): where the output goes.
        channel (Channel): which stream the bytes belong to.
        stream (ByteSource | None): the output to drain.
    """
    if stream is None:
        return
    if isinstance(stream, bytes):
        if stream:
            await console.emit(channel, stream)
        return
    async for chunk in stream:
        if chunk:
            await console.emit(channel, chunk)


async def handle_background(
    execute_node,
    left: tree_sitter.Node,
    right: tree_sitter.Node | None,
    session: Session,
    job_table: JobTable,
    agent_id: str | None,
    stdin: ByteSource | None = None,
    call_stack=None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run left side in background."""
    bg_session = session.fork()

    async def _run_bg(job: Job) -> tuple[IOResult, ExecutionNode]:
        # Background jobs don't receive stdin, matching real shell
        # behavior where bg processes get /dev/null. This prevents
        # race conditions when stdin is an async iterator.
        console = job.console
        cmd_str_inner = get_text(left) if hasattr(left, "text") else str(left)
        try:
            # Handing the console down as a sink is what makes compound
            # bodies stream: each statement writes as it finishes rather
            # than the whole construct landing at the end. Statements
            # that emit return no stdout, so the pump below is a no-op
            # for them and still covers constructs that do not stream.
            stdout, io, exec_node = await execute_node(left,
                                                       bg_session,
                                                       None,
                                                       call_stack,
                                                       sink=console)
        except CommandTimeoutError as exc:
            msg = (str(exc) + "\n").encode()
            stdout = b""
            io = IOResult(exit_code=124, stderr=msg)
            exec_node = ExecutionNode(command=cmd_str_inner,
                                      stderr=msg,
                                      exit_code=124)
        except ExitSignal as sig:
            # A background job is its own shell: exit ends the job only.
            stdout = sig.stdout or b""
            io = IOResult(exit_code=sig.contained_code,
                          stderr=sig.stderr or None)
            exec_node = ExecutionNode(command=cmd_str_inner,
                                      stderr=sig.stderr,
                                      exit_code=sig.contained_code)
        await pump(console, Channel.STDOUT, stdout)
        stderr = await io.materialize_stderr()
        if stderr:
            await console.emit(Channel.STDERR, stderr)
        io.sync_exit_code()
        return io, exec_node

    cmd_str = get_text(left) if hasattr(left, 'text') else str(left)

    job = job_table.submit(command=cmd_str,
                           run=_run_bg,
                           cwd=bg_session.cwd,
                           agent=agent_id or "",
                           session_id=session.session_id)
    session.last_bg_job_id = job.id
    job_line = f"[{job.id}]\n".encode()

    if right is None:
        return None, IOResult(stderr=job_line), ExecutionNode(
            op="&",
            exit_code=0,
            children=[ExecutionNode(command=cmd_str, exit_code=0)])

    right_stdout, right_io, right_exec = await execute_node(
        right, session, stdin, call_stack)
    right_stderr = await materialize(right_io.stderr)
    right_io.stderr = (job_line + right_stderr if right_stderr else job_line)
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
        # Bare `wait` adopts every job's output, the way `wait <id>`
        # already does for one. A real shell has nothing to adopt: its
        # jobs share the terminal and have printed already. Mirage jobs
        # print to their console, so the shell has to surface it or the
        # output is stranded.
        #
        # Every unreaped job, not just the ones still running: a job
        # that finished before this line was reached has output nobody
        # has read, and whether it finished in time is a scheduling
        # accident. Ordered by job id, because jobs finish concurrently
        # and completion order is not reproducible. Reaped afterwards so
        # a second `wait` does not print the same output twice.
        await job_table.wait_all()
        out = b""
        err = b""
        for finished in sorted(job_table.list_jobs(), key=lambda j: j.id):
            out += await finished.console.snapshot(Channel.STDOUT)
            err += await finished.console.snapshot(Channel.STDERR)
        job_table.pop_completed()
        return out or None, IOResult(stderr=err or None), ExecutionNode(
            command=cmd_str, exit_code=0)
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
    stdout = await job.console.snapshot(Channel.STDOUT)
    stderr = await job.console.snapshot(Channel.STDERR)
    # Reaped like GNU bash reaps a job waited on by id, so a later bare
    # `wait` does not adopt this console a second time.
    job_table.reap(job_id)
    return stdout, IOResult(
        exit_code=job.exit_code,
        stderr=stderr or None,
    ), ExecutionNode(command=cmd_str, exit_code=job.exit_code)


async def handle_fg(
    job_table: JobTable,
    parts: list[str],
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Foreground a background job: print its command line, then block
    on it and adopt its output and exit code.

    Args:
        job_table (JobTable): the session's job table.
        parts (list[str]): argv including the command name; the
            optional operand is a job id, with or without ``%``.
    """
    cmd_str = " ".join(parts)
    if len(parts) <= 1:
        running = job_table.running_jobs()
        if not running:
            err = b"fg: current: no such job\n"
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command=cmd_str,
                                                             exit_code=1,
                                                             stderr=err)
        job_id = running[-1].id
    else:
        raw = parts[1].lstrip("%")
        try:
            job_id = int(raw)
        except ValueError:
            err = f"fg: {parts[1]}: no such job\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command=cmd_str,
                                                             exit_code=1,
                                                             stderr=err)
        if job_table.get(job_id) is None:
            err = f"fg: {parts[1]}: no such job\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command=cmd_str,
                                                             exit_code=1,
                                                             stderr=err)
    job = await job_table.wait(job_id)
    header = (job.command + "\n").encode()
    stdout = header + await job.console.snapshot(Channel.STDOUT)
    stderr = await job.console.snapshot(Channel.STDERR)
    job_table.reap(job_id)
    return stdout, IOResult(
        exit_code=job.exit_code,
        stderr=stderr or None,
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
    killed = await job_table.kill(job_id)
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
