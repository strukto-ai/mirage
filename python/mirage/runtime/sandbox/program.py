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
import json
import logging
import os
import socket
import sys
import time
from collections.abc import Mapping, Sequence
from contextvars import Context

import aiofiles.os

from mirage.context.session_context import current_caller
from mirage.io.stream import close_quietly, feed
from mirage.io.types import ByteSource
from mirage.process.handle import ProcessHandle
from mirage.runtime.sandbox.constants import (
    EXEC_PRELUDE,
    HOST_START_SLACK_SECONDS,
    PIPE_DIAGNOSTIC_BYTES,
    PIPE_DIAGNOSTIC_WAIT_SECONDS,
    STOP_GRACE_SECONDS,
    STOP_POLL_SECONDS,
    stop_signal,
)
from mirage.runtime.types import OutputFn, RunResult, SandboxPipe
from mirage.shell.join import shell_join
from mirage.types import JsonValue

logger = logging.getLogger(__name__)

# Each running child with its transport, which closes our ends of its
# pipes, and the loop it runs on, which alone may wait for it.
Children = dict[
    asyncio.subprocess.Process,
    tuple[asyncio.SubprocessTransport, asyncio.AbstractEventLoop],
]

# What a pipe's reader buffers, as asyncio.create_subprocess_exec sets it.
STREAM_LIMIT = 2**16


async def run_program(
    executable: str,
    hint: str | None,
    args: list[str],
    stdin: ByteSource | None,
    *,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    children: Children | None = None,
    output: OutputFn | None = None,
    errors: OutputFn | None = None,
    direct: bool = False,
) -> RunResult:
    """One process run to its end: its output and its exit status.

    The child leads a process group of its own, and a cancelled call
    kills the whole group and closes our ends of the pipes before it
    re-raises: a grandchild left alive, or one that left the group,
    holds the output pipes open, so the wait would last until it exited
    on its own. A line abandoned to a timeout returns at once. When a
    ``kill`` stopped the runner with a signal other than KILL, the group
    gets that signal first (``end_tree``), so the program's handlers get
    to run, and a ``direct`` child that exits on its own then leaves its
    status with the runner.

    Args:
        executable (str): the program (``docker``, ``sandlock``, a host
            program).
        hint (str | None): the message a missing executable raises,
            saying how to get it; None lets the OSError through.
        args (list[str]): arguments after the executable.
        stdin (ByteSource | None): input for the command, or None for
            none.
        cwd (str | None): the working directory; None keeps this
            process's.
        env (dict[str, str] | None): the whole environment; None
            inherits this process's.
        children (Children | None): where the child is kept while it
            runs, for ``close_children``.
        output (OutputFn | None): receives stdout as it arrives instead
            of returning it.
        errors (OutputFn | None): receives stderr as it arrives instead
            of returning it.
        direct (bool): the child is the program itself, not a client
            that runs it elsewhere and exits on its own terms (``docker
            exec`` answers a TERM with 0 and leaves the program running).

    Raises:
        RuntimeError: the executable is missing and ``hint`` names it.
    """
    loop = asyncio.get_running_loop()
    try:
        process, transport = await _spawn(
            executable,
            args,
            cwd=cwd,
            env=env,
            stdin=(
                asyncio.subprocess.PIPE
                if stdin is not None
                else asyncio.subprocess.DEVNULL
            ),
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        if hint is None:
            raise
        raise RuntimeError(hint) from None
    run_key = f"host:{process.pid}"
    runner = current_caller().process
    if children is not None:
        children[process] = (transport, loop)
        if runner is not None:
            runner.add_run(run_key, host_run(process.pid, [executable, *args]))
    assert process.stdout is not None and process.stderr is not None

    writer = process.stdin

    async def write(chunk: bytes) -> None:
        assert writer is not None
        writer.write(chunk)
        await writer.drain()

    async def end() -> None:
        if writer is not None:
            writer.close()

    feeding = asyncio.create_task(
        feed(stdin, write, end, lambda: process.returncode is not None)
    )

    async def reap() -> None:
        await process.wait()
        if not feeding.done():
            feeding.cancel()

    waiting = asyncio.create_task(reap())
    reading = asyncio.create_task(read_into(process.stdout, output))
    erring = asyncio.create_task(read_into(process.stderr, errors))
    try:
        stdout, stderr, _, _ = await asyncio.gather(
            reading, erring, feeding, waiting
        )
    except BaseException:
        signum = stop_signal(runner)
        try:
            # The input ends first, as a pipe whose writer went away
            # does: a handler reading it to the end gets there in the
            # grace instead of waiting on a source that never ends.
            await end()
            if signum is not None:
                for reader in (reading, erring):
                    reader.cancel()
                await asyncio.gather(reading, erring, return_exceptions=True)
                await end_tree(process, signum, runner)
        finally:
            stop_tree(process, transport)
            await process.wait()
        code = process.returncode
        if (
            direct
            and runner is not None
            and signum is not None
            and code is not None
            and code >= 0
        ):
            runner.program_exited(code)
        raise
    finally:
        for task in (feeding, reading, erring, waiting):
            if not task.done():
                task.cancel()
        await asyncio.gather(
            feeding, reading, erring, waiting, return_exceptions=True
        )
        await end()
        await close_quietly(stdin)
        if children is not None:
            children.pop(process, None)
            if runner is not None:
                runner.drop_run(run_key)
    code = process.returncode if process.returncode is not None else 1
    return RunResult(
        stdout=stdout,
        stderr=stderr or None,
        exit_code=128 - code if code < 0 else code,
    )


def host_run(pid: int, argv: Sequence[str]) -> dict[str, JsonValue]:
    """How another workspace on this host reaches a child ``run_program``
    started, which leads its own process group: the host, the PID, and
    when it started, so a PID the host reused is never taken for it.
    Mirrors TypeScript's ``hostRun``.

    Args:
        pid (int): the child's PID.
        argv (Sequence[str]): what it runs.
    """
    return {
        "host": socket.gethostname(),
        "pid": pid,
        "started_at": time.time(),
        "command": shell_join(argv),
    }


async def _started_at(pid: int) -> float | None:
    """When a host process started, as ``ps -o lstart`` prints it, in
    epoch seconds; None once no process has the PID.

    Args:
        pid (int): the process.

    Raises:
        OSError: the host has no ``ps``.
    """
    ps = await asyncio.create_subprocess_exec(
        "ps",
        "-o",
        "lstart=",
        "-p",
        str(pid),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        env={**os.environ, "LC_ALL": "C"},
    )
    out, _ = await ps.communicate()
    text = out.decode().strip()
    if not text:
        return None
    return time.mktime(time.strptime(text, "%a %b %d %H:%M:%S %Y"))


async def reap_host_run(run: Mapping[str, JsonValue], signum: int) -> bool:
    """Stop a host run a lapsed workspace left: its process group gets
    ``signum``, then KILL after ``STOP_GRACE_SECONDS``. Mirrors
    TypeScript's ``reapHostRun``.

    Only a run of this host is reached, and only while its PID still
    names a process started when the run did, to the second ``ps``
    shows, so a PID the host reused is left alone. A PID that names no
    process may still name the run's group, whose leader exited before
    the programs it started: the host gives no new process the id of a
    group that still has members, so that group gets the signal too. A
    group this workspace may not signal is not reached while its leader
    still runs (macOS answers EPERM for one that only exited unreaped).

    Args:
        run (Mapping[str, JsonValue]): the run as ``host_run`` keeps it.
        signum (int): the first signal.

    Returns:
        bool: True once the run is stopped or gone; False when this
        workspace cannot reach it.
    """
    pid, recorded = run.get("pid"), run.get("started_at")
    if (
        sys.platform == "win32"
        or run.get("host") != socket.gethostname()
        or not isinstance(pid, int)
        or not isinstance(recorded, (int, float))
    ):
        return False
    try:
        started = await _started_at(pid)
    except OSError as exc:
        logger.debug("process %d not checked: %s", pid, exc)
        return False
    if (
        started is not None
        and abs(started - recorded) > HOST_START_SLACK_SECONDS
    ):
        return True
    try:
        os.killpg(pid, signum)
        async with asyncio.timeout(STOP_GRACE_SECONDS):
            while True:
                await asyncio.sleep(STOP_POLL_SECONDS)
                os.killpg(pid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return await _started_at(pid) is None
    except TimeoutError:
        logger.debug("process group %d outlived signal %d", pid, signum)
    try:
        os.killpg(pid, 9)
    except ProcessLookupError:
        logger.debug("process group %d has already exited", pid)
    except PermissionError:
        return await _started_at(pid) is None
    return True


async def read_into(
    stream: asyncio.StreamReader, sink: OutputFn | None
) -> bytes:
    """Read a program's output to its end, handing each chunk to
    ``sink`` as it arrives, or keeping it all for the caller without one.

    Args:
        stream (asyncio.StreamReader): the program's stdout or stderr.
        sink (OutputFn | None): where each chunk goes; None returns the
            whole output.
    """
    parts: list[bytes] = []
    while chunk := await stream.read(STREAM_LIMIT):
        if sink is None:
            parts.append(chunk)
        else:
            await sink(chunk)
    return b"".join(parts)


async def _spawn(
    executable: str,
    args: list[str],
    *,
    stdin: int,
    stderr: int,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
) -> tuple[asyncio.subprocess.Process, asyncio.SubprocessTransport]:
    """Start a child leading a process group of its own, keeping the
    transport that closes our ends of its pipes (``stop_tree``).

    Args:
        executable (str): the program.
        args (list[str]): arguments after the executable.
        stdin (int): ``asyncio.subprocess.PIPE`` or ``DEVNULL``.
        stderr (int): ``asyncio.subprocess.PIPE`` or ``DEVNULL``.
        cwd (str | None): the working directory; None keeps this
            process's.
        env (dict[str, str] | None): the whole environment; None
            inherits this process's.
    """
    loop = asyncio.get_running_loop()
    transport, protocol = await loop.subprocess_exec(
        lambda: asyncio.subprocess.SubprocessStreamProtocol(
            limit=STREAM_LIMIT, loop=loop
        ),
        executable,
        *args,
        cwd=cwd,
        env=env,
        stdin=stdin,
        stdout=asyncio.subprocess.PIPE,
        stderr=stderr,
        start_new_session=True,
    )
    return asyncio.subprocess.Process(transport, protocol, loop), transport


def reported_state(
    result: RunResult, command: str, path: Sequence[str | int]
) -> str:
    """The state a sandbox's status command printed as JSON, at ``path``.

    Args:
        result (RunResult): the status command's run.
        command (str): the command, for the message (``docker inspect``).
        path (Sequence[str | int]): the keys and indexes down to the state.

    Raises:
        RuntimeError: the command failed, or its JSON holds no state.
    """
    if result.exit_code != 0:
        said = (result.stderr or b"").decode().strip()
        raise RuntimeError(f"{command} failed: {said}")
    try:
        state = json.loads(result.stdout)
        for key in path:
            state = state[key]
    except (ValueError, LookupError, TypeError) as exc:
        raise RuntimeError(
            f"{command} returned unreadable json: {exc}"
        ) from exc
    return str(state)


def exec_args(
    head: Sequence[str],
    tail: Sequence[str],
    env: Mapping[str, str],
    cwd: str | None,
    argv: Sequence[str],
) -> list[str]:
    """A sandbox program's exec arguments, the same for every program that runs
    a command in a box: the program's own words, ``/`` as the working
    directory and each variable as ``-e``, the target or ``--``, then
    the command.

    A ``cwd`` runs the command there through the prelude, which exits
    126 when the box lacks it, and defers the chdir until the shell
    starts, so an agent that blocks on a chdir into a passive sshfs
    prefix still serves the mount's pipe. None runs it from ``/`` as
    given, for a helper pipe.

    Args:
        head (Sequence[str]): the program's exec words before the working
            directory (``exec -i``, smolvm's ``machine exec --name M``).
        tail (Sequence[str]): what follows the flags: the target, or
            ``--`` where the command is a trailing var arg, so a line
            starting with a dash is not read as a flag.
        env (Mapping[str, str]): the command's environment.
        cwd (str | None): the working directory, passed through verbatim;
            None for a helper pipe.
        argv (Sequence[str]): the command.
    """
    args = [*head, "-w", "/"]
    for key, value in env.items():
        args += ["-e", f"{key}={value}"]
    args += tail
    if cwd is not None:
        args += ["/bin/sh", "-c", EXEC_PRELUDE, "sh", cwd]
    return [*args, *argv]


async def cwd_refusal(name: str, cwd: str) -> RunResult | None:
    """Refuse a host program whose working directory this host lacks.

    The session cwd is a workspace path; running elsewhere instead would
    point a relative path at the wrong files.

    Args:
        name (str): the program, for the message.
        cwd (str): the session's working directory.
    """
    if await aiofiles.os.path.isdir(cwd):
        return None
    return RunResult(
        stdout=b"",
        stderr=(
            f"{name}: the working directory {cwd} is not on this host\n"
        ).encode(),
        exit_code=126,
    )


def kill_tree(process: asyncio.subprocess.Process, signum: int = 9) -> None:
    """Signal a child and everything it started: its process group.

    Windows has no process group to signal, and no signal but a kill, so
    only the child goes there, killed. A group whose members have all
    exited but are not yet reaped answers EPERM on macOS where Linux
    answers ESRCH; either way nothing in it is left to signal.

    Args:
        process (asyncio.subprocess.Process): a child ``run_program`` started.
        signum (int): the signal, KILL (9) by default.
    """
    if sys.platform == "win32":
        if process.returncode is None:
            process.kill()
        return
    try:
        os.killpg(process.pid, signum)
    except (ProcessLookupError, PermissionError):
        logger.debug("process group %d has already exited", process.pid)


async def end_tree(
    process: asyncio.subprocess.Process,
    signum: int,
    runner: ProcessHandle | None = None,
) -> None:
    """Signal a child's process group and give the group
    ``STOP_GRACE_SECONDS`` to end, reading and dropping the child's
    output meanwhile, so a handler that writes is not held on a full
    pipe. The grace is the group's: a descendant still handling the
    signal after the child exited keeps it, unless a KILL reaches the
    runner first. What is left after it is the caller's to kill
    (``stop_tree``). Mirrors TypeScript's ``endTree``.

    Args:
        process (asyncio.subprocess.Process): a child ``run_program`` started,
            with nothing else reading its output.
        signum (int): the signal.
        runner (ProcessHandle | None): the runner the signal stopped,
            whose KILL ends the grace.
    """
    kill_tree(process, signum)
    drops = [
        asyncio.create_task(_drop(stream))
        for stream in (process.stdout, process.stderr)
        if stream is not None
    ]
    try:
        async with asyncio.timeout(STOP_GRACE_SECONDS):
            while runner is None or runner.signal != 9:
                if sys.platform == "win32":
                    if process.returncode is not None:
                        return
                else:
                    try:
                        os.killpg(process.pid, 0)
                    except (ProcessLookupError, PermissionError):
                        return
                await asyncio.sleep(STOP_POLL_SECONDS)
    except TimeoutError:
        logger.debug(
            "process group %d outlived signal %d", process.pid, signum
        )
    finally:
        for drop in drops:
            drop.cancel()
        await asyncio.gather(*drops, return_exceptions=True)


async def _drop(stream: asyncio.StreamReader) -> None:
    """Read a stream to its end, keeping nothing.

    Args:
        stream (asyncio.StreamReader): a child's output.
    """
    while await stream.read(STREAM_LIMIT):
        pass


def stop_tree(
    process: asyncio.subprocess.Process,
    transport: asyncio.SubprocessTransport,
) -> None:
    """Kill a child's tree and close our ends of its pipes, which a
    descendant that left the group (a session of its own) survives the
    kill holding. Mirrors TypeScript's ``stopTree``.

    Args:
        process (asyncio.subprocess.Process): a child ``run_program`` started.
        transport (asyncio.SubprocessTransport): the child's transport.
    """
    kill_tree(process)
    transport.close()


async def close_children(children: Children) -> None:
    """Kill every child still running, so none outlives the workspace.

    Each child's pipes are closed on our side too, so a descendant that
    left the group cannot hold the close open. Only a child on the
    closing loop is waited for. One a sync ``with`` block left running
    belongs to the loop that block exits inside, which runs nothing
    until the close returns; that loop closes its pipes and reaps it
    once it runs again.

    Args:
        children (Children): a runtime's running children.
    """
    running = list(children.items())
    loop = asyncio.get_running_loop()
    for child, (transport, owner) in running:
        if owner is loop:
            stop_tree(child, transport)
            continue
        kill_tree(child)
        if not owner.is_closed():
            owner.call_soon_threadsafe(transport.close)
    await asyncio.gather(
        *(child.wait() for child, (_, owner) in running if owner is loop)
    )


async def open_program_pipe(executable: str, args: list[str]) -> SandboxPipe:
    """Hold a byte transport to a sandbox helper until stopped.

    The tail of what the helper says on stderr is kept for
    ``diagnostic``, so a mount that fails can say why. Stopping ends
    the helper's input; one that has not closed 0.1 s later loses its
    process group and our ends of its pipes, which output nobody read
    would otherwise hold open.

    Args:
        executable (str): the provider's program.
        args (list[str]): arguments starting a foreground helper.
    """
    child, transport = await _spawn(
        executable,
        args,
        stdin=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert child.stdin is not None and child.stdout is not None
    said = bytearray()

    async def keep_tail() -> None:
        assert child.stderr is not None
        try:
            while chunk := await child.stderr.read(STREAM_LIMIT):
                said.extend(chunk)
                del said[:-PIPE_DIAGNOSTIC_BYTES]
        except Exception:
            logger.debug("%s helper stderr closed", executable, exc_info=True)

    draining = asyncio.create_task(keep_tail(), context=Context())

    async def diagnostic() -> str:
        if not draining.done():
            try:
                await asyncio.wait_for(
                    asyncio.shield(draining), PIPE_DIAGNOSTIC_WAIT_SECONDS
                )
            except TimeoutError:
                logger.debug("%s helper is still running", executable)
        return said.decode(errors="replace").strip()

    async def stop() -> None:
        assert child.stdin is not None
        child.stdin.close()
        try:
            await asyncio.wait_for(child.wait(), 0.1)
        except TimeoutError:
            stop_tree(child, transport)
        await child.wait()
        draining.cancel()
        await asyncio.gather(draining, return_exceptions=True)

    return SandboxPipe(child.stdout, child.stdin, stop, diagnostic)
