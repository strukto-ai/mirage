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
import os
import signal
import sys

import pytest

from mirage.runtime.sandbox.cli import (
    Children,
    close_children,
    open_cli_pipe,
    run_cli,
)
from mirage.runtime.sandbox.constants import PIPE_DIAGNOSTIC_BYTES

# A child that starts a sleep in a session of its own, so killing the
# child's group leaves it running with the output pipes it inherited.
ESCAPE = (
    "import subprocess, sys, time\n"
    "p = subprocess.Popen(['sleep', '30'], start_new_session=True)\n"
    "open(sys.argv[1], 'w').write(str(p.pid))\n"
    "time.sleep(30)\n"
)

# Children whose output nobody reads: one exits once its input closes,
# with a write still blocked in a thread; one stays blocked writing.
UNREAD_THEN_EXIT = (
    "import os, sys, threading\n"
    "threading.Thread(target=os.write, args=(1, b'x' * (1 << 20)), "
    "daemon=True).start()\n"
    "sys.stdin.buffer.read()\n"
    "os._exit(0)\n"
)
UNREAD_FOREVER = "import os\nos.write(1, b'x' * (1 << 20))\n"


async def _ended(pid: int) -> bool:
    """Whether ``pid`` has exited: gone, or a zombie its new parent has
    not reaped yet. Polled, since a kill lands asynchronously.

    Args:
        pid (int): the process to look for.
    """
    for _ in range(500):
        ps = await asyncio.create_subprocess_exec(
            "ps", "-o", "stat=", "-p", str(pid), stdout=asyncio.subprocess.PIPE
        )
        out, _ = await ps.communicate()
        state = out.decode().strip()
        if not state or state.startswith("Z"):
            return True
        await asyncio.sleep(0.01)
    return False


@pytest.mark.asyncio
async def test_run_cli_returns_both_streams_and_the_status():
    out, err, code = await run_cli(
        "sh", "no sh", ["-c", "cat; echo e >&2; exit 3"], b"in"
    )
    assert (out, err, code) == (b"in", b"e\n", 3)


async def _two_chunks():
    yield b"a"
    yield b"b"


@pytest.mark.asyncio
async def test_run_cli_streams_input_and_output_and_maps_a_signal():
    seen: list[bytes] = []

    async def output(chunk: bytes) -> None:
        seen.append(chunk)

    out, _, code = await run_cli(
        "sh", None, ["-c", "cat; kill -TERM $$"], _two_chunks(), output=output
    )
    assert (out, b"".join(seen), code) == (b"", b"ab", 128 + signal.SIGTERM)


@pytest.mark.asyncio
async def test_an_exited_command_does_not_wait_on_a_pending_input_pull():
    held = asyncio.Event()

    async def source():
        await held.wait()
        yield b""

    async with asyncio.timeout(5):
        out, _, code = await run_cli(
            "sh", None, ["-c", "printf done"], source()
        )
    assert (out, code) == (b"done", 0)


@pytest.mark.asyncio
async def test_a_missing_cli_raises_its_hint():
    with pytest.raises(RuntimeError, match="install it"):
        await run_cli("mirage-no-such-cli", "install it", [], None)


@pytest.mark.asyncio
async def test_cancelling_a_call_kills_the_child(tmp_path):
    pid_file = tmp_path / "pid"
    task = asyncio.create_task(
        run_cli(
            "sh", "no sh", ["-c", f"echo $$ > {pid_file}; exec sleep 30"], None
        )
    )
    for _ in range(200):
        if pid_file.exists() and pid_file.read_text().strip():
            break
        await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    pid = int(pid_file.read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


@pytest.mark.asyncio
async def test_cancelling_a_call_kills_what_the_child_started(tmp_path):
    # A grandchild holds the output pipes open, so killing the child
    # alone left the wait running until the grandchild exited.
    pid_file = tmp_path / "pid"
    task = asyncio.create_task(
        run_cli(
            "sh",
            None,
            ["-c", f"sleep 30 & echo $! > {pid_file}; wait"],
            None,
        )
    )
    for _ in range(200):
        if pid_file.exists() and pid_file.read_text().strip():
            break
        await asyncio.sleep(0.01)
    task.cancel()
    async with asyncio.timeout(5):
        with pytest.raises(asyncio.CancelledError):
            await task
    assert await _ended(int(pid_file.read_text()))


@pytest.mark.asyncio
async def test_close_children_kills_every_running_tree(tmp_path):
    children: Children = {}
    pid_file = tmp_path / "pid"
    task = asyncio.create_task(
        run_cli(
            "sh",
            None,
            ["-c", f"sleep 30 & echo $! > {pid_file}; wait"],
            None,
            children=children,
        )
    )
    async with asyncio.timeout(5):
        while not (pid_file.exists() and pid_file.read_text().strip()):
            await asyncio.sleep(0.01)
        await close_children(children)
        _, _, code = await task
    assert code != 0 and not children
    assert await _ended(int(pid_file.read_text()))


async def _wait_for_pid(pid_file) -> int:
    while not (pid_file.exists() and pid_file.read_text().strip()):
        await asyncio.sleep(0.01)
    return int(pid_file.read_text())


@pytest.mark.asyncio
async def test_a_cancelled_call_does_not_wait_on_a_descendant_that_left(
    tmp_path,
):
    pid_file = tmp_path / "pid"
    task = asyncio.create_task(
        run_cli(sys.executable, None, ["-c", ESCAPE, str(pid_file)], None)
    )
    escaped = await _wait_for_pid(pid_file)
    try:
        task.cancel()
        async with asyncio.timeout(5):
            with pytest.raises(asyncio.CancelledError):
                await task
    finally:
        os.kill(escaped, signal.SIGKILL)


@pytest.mark.asyncio
async def test_close_children_does_not_wait_on_a_descendant_that_left(
    tmp_path,
):
    children: Children = {}
    pid_file = tmp_path / "pid"
    task = asyncio.create_task(
        run_cli(
            sys.executable,
            None,
            ["-c", ESCAPE, str(pid_file)],
            None,
            children=children,
        )
    )
    escaped = await _wait_for_pid(pid_file)
    try:
        async with asyncio.timeout(5):
            await close_children(children)
            _, _, code = await task
        assert code != 0 and not children
    finally:
        os.kill(escaped, signal.SIGKILL)


@pytest.mark.asyncio
async def test_a_pipe_keeps_the_tail_of_its_stderr():
    pipe = await open_cli_pipe(
        sys.executable,
        ["-c", "import sys; sys.stderr.write('x' * 40000 + 'the-end')"],
    )
    try:
        assert pipe.diagnostic is not None
        said = await pipe.diagnostic()
        assert said.endswith("the-end")
        assert len(said) == PIPE_DIAGNOSTIC_BYTES
    finally:
        await pipe.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "script",
    [UNREAD_THEN_EXIT, UNREAD_FOREVER],
    ids=["exits_once_its_input_closes", "never_exits"],
)
async def test_stopping_a_pipe_does_not_wait_on_output_nobody_read(script):
    pipe = await open_cli_pipe(sys.executable, ["-c", script])
    await asyncio.sleep(0.5)
    async with asyncio.timeout(5):
        await pipe.stop()
