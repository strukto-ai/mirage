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
    stdin: bytes | None,
    *,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    children: Children | None = None,
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
        stdin (bytes | None): input for the command, or None for none.
        cwd (str | None): the working directory; None keeps this
            process's.
        env (dict[str, str] | None): the whole environment; None
            inherits this process's.
        children (Children | None): where the child is kept while it
            runs, for ``close_children``.

    Raises:
        RuntimeError: the executable is missing and ``hint`` names it.
    """
    loop = asyncio.get_running_loop()
    try:
        transport, protocol = await loop.subprocess_exec(
            lambda: asyncio.subprocess.SubprocessStreamProtocol(
                limit=_STREAM_LIMIT, loop=loop
            ),
            executable,
            *args,
            cwd=cwd,
            env=env,
            stdin=(
                asyncio.subprocess.PIPE
                if stdin is not None
                else asyncio.subprocess.DEVNULL
            ),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
    except FileNotFoundError:
        if hint is None:
            raise
        raise RuntimeError(hint) from None
    process = asyncio.subprocess.Process(transport, protocol, loop)
    if children is not None:
        children[process] = (transport, loop)
    try:
        stdout, stderr = await process.communicate(stdin)
    except asyncio.CancelledError:
        stop_tree(process, transport)
        await process.wait()
        raise
    finally:
        if children is not None:
            children.pop(process, None)
    code = process.returncode if process.returncode is not None else 1
    return stdout, stderr, code


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
