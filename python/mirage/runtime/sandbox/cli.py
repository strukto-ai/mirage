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
import logging
import os
import signal
import sys
from collections.abc import Awaitable, Callable, Mapping, Sequence
from contextvars import Context

from mirage.io.stream import async_chain, close_quietly
from mirage.io.types import ByteSource
from mirage.runtime.sandbox.constants import (
    EXEC_PRELUDE,
    PIPE_DIAGNOSTIC_BYTES,
    PIPE_DIAGNOSTIC_WAIT_SECONDS,
)
from mirage.runtime.types import RunResult, SandboxPipe

logger = logging.getLogger(__name__)

# Each running child with its transport, which closes our ends of its
# pipes, and the loop it runs on, which alone may wait for it.
Children = dict[
    asyncio.subprocess.Process,
    tuple[asyncio.SubprocessTransport, asyncio.AbstractEventLoop],
]

# What a pipe's reader buffers, as asyncio.create_subprocess_exec sets it.
_STREAM_LIMIT = 2**16


async def run_cli(
    executable: str,
    hint: str | None,
    args: list[str],
    stdin: ByteSource | None,
    *,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    children: Children | None = None,
    output: Callable[[bytes], Awaitable[None]] | None = None,
) -> tuple[bytes, bytes, int]:
    """One process run to its end: its output and its exit status.

    The child leads a process group of its own, and a cancelled call
    kills the whole group and closes our ends of the pipes before it
    re-raises: a grandchild left alive, or one that left the group,
    holds the output pipes open, so the wait would last until it exited
    on its own. A line abandoned to a timeout returns at once.

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
        output (Callable[[bytes], Awaitable[None]] | None): receives
            stdout as it arrives instead of returning it.

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
    if children is not None:
        children[process] = (transport, loop)
    assert process.stdout is not None and process.stderr is not None

    async def feed() -> None:
        if process.stdin is None:
            return
        try:
            async for chunk in async_chain(
                [stdin] if stdin is not None else []
            ):
                process.stdin.write(chunk)
                await process.stdin.drain()
        except asyncio.CancelledError:
            if process.returncode is None:
                raise
            logger.debug(
                "process %d ended before consuming stdin", process.pid
            )
        except (BrokenPipeError, ConnectionResetError):
            logger.debug("process %d closed stdin", process.pid)
        finally:
            process.stdin.close()

    async def read_stdout() -> bytes:
        parts: list[bytes] = []
        assert process.stdout is not None
        while chunk := await process.stdout.read(_STREAM_LIMIT):
            if output is None:
                parts.append(chunk)
            else:
                await output(chunk)
        return b"".join(parts)

    feeding = asyncio.create_task(feed())

    async def reap() -> None:
        await process.wait()
        if not feeding.done():
            feeding.cancel()

    waiting = asyncio.create_task(reap())
    reading = asyncio.create_task(read_stdout())
    errors = asyncio.create_task(process.stderr.read())
    try:
        stdout, stderr, _, _ = await asyncio.gather(
            reading, errors, feeding, waiting
        )
    except BaseException:
        stop_tree(process, transport)
        await process.wait()
        raise
    finally:
        for task in (feeding, reading, errors, waiting):
            if not task.done():
                task.cancel()
        await asyncio.gather(
            feeding, reading, errors, waiting, return_exceptions=True
        )
        await close_quietly(stdin)
        if children is not None:
            children.pop(process, None)
    code = process.returncode if process.returncode is not None else 1
    return stdout, stderr, 128 - code if code < 0 else code


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
            limit=_STREAM_LIMIT, loop=loop
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


def exec_args(
    head: Sequence[str],
    tail: Sequence[str],
    env: Mapping[str, str],
    cwd: str | None,
    argv: Sequence[str],
) -> list[str]:
    """A sandbox CLI's exec arguments, the same for every CLI that runs
    a command in a box: the CLI's own words, ``/`` as the working
    directory and each variable as ``-e``, the target or ``--``, then
    the command.

    A ``cwd`` runs the command there through the prelude, which exits
    126 when the box lacks it, and defers the chdir until the shell
    starts, so an agent that blocks on a chdir into a passive sshfs
    prefix still serves the mount's pipe. None runs it from ``/`` as
    given, for a helper pipe.

    Args:
        head (Sequence[str]): the CLI's exec words before the working
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


def cwd_refusal(name: str, cwd: str) -> RunResult | None:
    """Refuse a host program whose working directory this host lacks.

    The session cwd is a workspace path; running elsewhere instead would
    point a relative path at the wrong files.

    Args:
        name (str): the program, for the message.
        cwd (str): the session's working directory.
    """
    if os.path.isdir(cwd):
        return None
    return RunResult(
        stdout=b"",
        stderr=(
            f"{name}: the working directory {cwd} is not on this host\n"
        ).encode(),
        exit_code=126,
    )


def kill_tree(process: asyncio.subprocess.Process) -> None:
    """Kill a child and everything it started: its process group.

    Windows has no process group to kill, so only the child goes there.

    Args:
        process (asyncio.subprocess.Process): a child ``run_cli`` started.
    """
    if sys.platform == "win32":
        if process.returncode is None:
            process.kill()
        return
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        logger.debug("process group %d has already exited", process.pid)


def stop_tree(
    process: asyncio.subprocess.Process,
    transport: asyncio.SubprocessTransport,
) -> None:
    """Kill a child's tree and close our ends of its pipes, which a
    descendant that left the group (a session of its own) survives the
    kill holding. Mirrors TypeScript's ``stopTree``.

    Args:
        process (asyncio.subprocess.Process): a child ``run_cli`` started.
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


async def open_cli_pipe(executable: str, args: list[str]) -> SandboxPipe:
    """Hold a byte transport to a sandbox helper until stopped.

    The tail of what the helper says on stderr is kept for
    ``diagnostic``, so a mount that fails can say why. Stopping ends
    the helper's input; one that has not closed 0.1 s later loses its
    process group and our ends of its pipes, which output nobody read
    would otherwise hold open.

    Args:
        executable (str): the provider's CLI.
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
            while chunk := await child.stderr.read(_STREAM_LIMIT):
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
