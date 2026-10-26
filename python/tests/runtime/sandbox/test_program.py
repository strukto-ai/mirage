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
import errno
import os
import shlex
import signal
import socket
import sys
import time
from collections.abc import AsyncIterator

import pytest

from mirage.context.session_context import run_with_execution
from mirage.process.table import ProcessTable
from mirage.runtime.sandbox.constants import PIPE_DIAGNOSTIC_BYTES
from mirage.runtime.sandbox.program import (
    Children,
    close_children,
    host_run,
    open_program_pipe,
    reap_host_run,
    run_program,
)
from mirage.types import PathSpec

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
    ran = await run_program(
        "sh", "no sh", ["-c", "cat; echo e >&2; exit 3"], b"in"
    )
    assert (ran.stdout, ran.stderr, ran.exit_code) == (b"in", b"e\n", 3)


async def _two_chunks():
    yield b"a"
    yield b"b"


async def _one_then_open() -> AsyncIterator[bytes]:
    yield b"x"
    await asyncio.Event().wait()


@pytest.mark.asyncio
async def test_run_cli_streams_input_and_output_and_maps_a_signal():
    seen: list[bytes] = []

    async def output(chunk: bytes) -> None:
        seen.append(chunk)

    ran = await run_program(
        "sh", None, ["-c", "cat; kill -TERM $$"], _two_chunks(), output=output
    )
    assert (ran.stdout, b"".join(seen), ran.exit_code) == (
        b"",
        b"ab",
        128 + signal.SIGTERM,
    )


# stderr goes to its own callback as it arrives, as stdout goes to output.
@pytest.mark.asyncio
async def test_run_cli_streams_stderr_to_its_callback():
    seen: list[bytes] = []

    async def errors(chunk: bytes) -> None:
        seen.append(chunk)

    ran = await run_program(
        "sh", None, ["-c", "echo o; echo e >&2; exit 3"], None, errors=errors
    )
    assert (ran.stdout, ran.stderr, b"".join(seen), ran.exit_code) == (
        b"o\n",
        None,
        b"e\n",
        3,
    )


@pytest.mark.asyncio
async def test_an_exited_command_does_not_wait_on_a_pending_input_pull():
    held = asyncio.Event()

    async def source():
        await held.wait()
        yield b""

    async with asyncio.timeout(5):
        ran = await run_program("sh", None, ["-c", "printf done"], source())
    assert (ran.stdout, ran.exit_code) == (b"done", 0)


@pytest.mark.asyncio
async def test_a_missing_cli_raises_its_hint():
    with pytest.raises(RuntimeError, match="install it"):
        await run_program("mirage-no-such-program", "install it", [], None)


@pytest.mark.asyncio
async def test_cancelling_a_call_kills_the_child(tmp_path):
    pid_file = tmp_path / "pid"
    task = asyncio.create_task(
        run_program(
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
        run_program(
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


def _start_runner(
    processes: ProcessTable,
    script: str,
    direct: bool = False,
    stdin: AsyncIterator[bytes] | None = None,
):
    async def run() -> int:
        ran = await run_program(
            "sh", None, ["-c", script], stdin, direct=direct
        )
        return ran.exit_code

    return processes.start(
        session_id="s",
        command="sh",
        cwd=PathSpec.from_str_path("/"),
        run=run,
    )


# A kill that names TERM reaches the program as TERM, so its handler
# runs, and the runner's status is bash's 143 for a child TERM ended.
@pytest.mark.asyncio
async def test_a_runner_killed_with_term_lets_the_child_handle_it(tmp_path):
    pid_file, said = tmp_path / "pid", tmp_path / "said"
    runner = _start_runner(
        ProcessTable(bind=run_with_execution),
        f"trap 'echo bye > {said}; exit 0' TERM; echo $$ > {pid_file}; "
        "while :; do sleep 0.05; done",
    )
    await _wait_for_pid(pid_file)
    assert runner.terminate(signal.SIGTERM)
    async with asyncio.timeout(5):
        info = await runner.join()
    assert said.read_text() == "bye\n"
    assert info.exit_code == 143


@pytest.mark.asyncio
async def test_a_runner_killed_with_kill_gives_the_child_no_handler(
    tmp_path,
):
    pid_file, said = tmp_path / "pid", tmp_path / "said"
    runner = _start_runner(
        ProcessTable(bind=run_with_execution),
        f"trap 'echo bye > {said}; exit 0' TERM; echo $$ > {pid_file}; "
        "while :; do sleep 0.05; done",
    )
    child = await _wait_for_pid(pid_file)
    assert runner.terminate(signal.SIGKILL)
    async with asyncio.timeout(5):
        info = await runner.join()
    assert not said.exists()
    assert info.exit_code == 137
    assert await _ended(child)


# A KILL while a program still has the grace an earlier TERM gave it ends
# that grace: what ignores TERM is killed at once, as a second
# ``kill -KILL`` does, not a second later.
@pytest.mark.asyncio
async def test_a_kill_during_the_grace_ends_it(tmp_path):
    pid_file = tmp_path / "pid"
    runner = _start_runner(
        ProcessTable(bind=run_with_execution),
        f"trap '' TERM; echo $$ > {pid_file}; while :; do sleep 0.05; done",
    )
    child = await _wait_for_pid(pid_file)
    assert runner.terminate(signal.SIGTERM)
    await asyncio.sleep(0.1)
    killed = time.monotonic()
    assert runner.terminate(signal.SIGKILL)
    async with asyncio.timeout(5):
        info = await runner.join()
    assert time.monotonic() - killed < 0.5
    assert info.exit_code == 137
    assert await _ended(child)


# A child that is the program itself and exits on its own after a gentler
# signal leaves its status with the runner; a client's (``docker exec``)
# says nothing about the program, and a child the signal ended has none.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "direct,trap,signum,code",
    [
        (True, "trap 'exit 3' TERM; ", signal.SIGTERM, 3),
        (False, "trap 'exit 3' TERM; ", signal.SIGTERM, None),
        (True, "", signal.SIGTERM, None),
        (True, "trap 'exit 3' TERM; ", signal.SIGKILL, None),
    ],
)
async def test_a_direct_child_that_handles_the_signal_leaves_its_status(
    tmp_path, direct, trap, signum, code
):
    pid_file = tmp_path / "pid"
    runner = _start_runner(
        ProcessTable(bind=run_with_execution),
        f"{trap}echo $$ > {pid_file}; while :; do sleep 0.05; done",
        direct,
    )
    await _wait_for_pid(pid_file)
    assert runner.terminate(signum)
    async with asyncio.timeout(5):
        info = await runner.join()
    assert (info.exit_code, runner.program_code) == (128 + signum, code)


# A kill reaches the program once, as bash's does: a handler that counts
# its signals, or one already exiting, must not see a second.
@pytest.mark.asyncio
async def test_a_kill_signals_the_child_once(tmp_path):
    pid_file, count = tmp_path / "pid", tmp_path / "count"
    program = (
        "import os, signal, sys, time\n"
        "def stop(*_):\n"
        f"    open({str(count)!r}, 'a').write('x\\n')\n"
        "    time.sleep(0.2)\n"
        "    sys.exit(0)\n"
        "signal.signal(signal.SIGTERM, stop)\n"
        f"open({str(pid_file)!r}, 'w').write(str(os.getpid()))\n"
        "while True:\n"
        "    time.sleep(0.05)\n"
    )
    runner = _start_runner(
        ProcessTable(bind=run_with_execution),
        f"exec {shlex.quote(sys.executable)} -c {shlex.quote(program)}",
    )
    await _wait_for_pid(pid_file)
    assert runner.terminate(signal.SIGTERM)
    async with asyncio.timeout(5):
        await runner.join()
    assert count.read_text() == "x\n"


# macOS answers EPERM where Linux answers ESRCH for a group whose members
# have all exited but are not yet reaped; either way the group is gone,
# and the stop must not fail on it.
@pytest.mark.asyncio
async def test_a_group_answering_eperm_is_gone(tmp_path, monkeypatch):
    killpg = os.killpg

    def darwin(pid: int, signum: int) -> None:
        try:
            killpg(pid, signum)
        except ProcessLookupError:
            raise PermissionError(
                errno.EPERM, "Operation not permitted"
            ) from None

    monkeypatch.setattr(os, "killpg", darwin)
    pid_file = tmp_path / "pid"
    runner = _start_runner(
        ProcessTable(bind=run_with_execution),
        f"trap 'exit 0' TERM; echo $$ > {pid_file}; "
        "while :; do sleep 0.05; done",
    )
    await _wait_for_pid(pid_file)
    assert runner.terminate(signal.SIGTERM)
    async with asyncio.timeout(5):
        info = await runner.join()
    assert (info.exit_code, info.failure) == (143, None)


# The grace is the group's: a descendant still handling the signal after
# the program it ran under has exited keeps its second.
@pytest.mark.asyncio
async def test_a_descendant_keeps_the_grace_after_its_parent_exits(tmp_path):
    pid_file, said = tmp_path / "pid", tmp_path / "said"
    runner = _start_runner(
        ProcessTable(bind=run_with_execution),
        f'sh -c \'trap "sleep 0.3; echo bye > {said}; exit 0" TERM; '
        f"while :; do sleep 0.05; done' >/dev/null 2>&1 & "
        f"echo $$ > {pid_file}; wait",
    )
    await _wait_for_pid(pid_file)
    await asyncio.sleep(0.2)
    assert runner.terminate(signal.SIGTERM)
    async with asyncio.timeout(5):
        await runner.join()
    assert said.read_text() == "bye\n"


# What ignores the signal, a descendant too, ends with KILL after the
# grace, though the program it ran under exited at once.
@pytest.mark.asyncio
async def test_a_descendant_that_ignores_the_signal_is_killed(tmp_path):
    pid_file, kid_file = tmp_path / "pid", tmp_path / "kid"
    runner = _start_runner(
        ProcessTable(bind=run_with_execution),
        "sh -c \"trap '' TERM; while :; do sleep 0.05; done\" "
        f">/dev/null 2>&1 & echo $! > {kid_file}; echo $$ > {pid_file}; wait",
    )
    await _wait_for_pid(pid_file)
    kid = await _wait_for_pid(kid_file)
    await asyncio.sleep(0.2)
    assert runner.terminate(signal.SIGTERM)
    async with asyncio.timeout(5):
        await runner.join()
    assert await _ended(kid)


# A handler that writes more than a pipe holds is not blocked on it: the
# output is read and dropped through the grace.
@pytest.mark.asyncio
async def test_a_handler_writing_its_output_finishes_in_the_grace(tmp_path):
    pid_file, said = tmp_path / "pid", tmp_path / "said"
    runner = _start_runner(
        ProcessTable(bind=run_with_execution),
        f"trap 'head -c 300000 /dev/zero; head -c 300000 /dev/zero >&2; "
        f"echo bye > {said}; exit 0' TERM; echo $$ > {pid_file}; "
        "while :; do sleep 0.05; done",
    )
    await _wait_for_pid(pid_file)
    assert runner.terminate(signal.SIGTERM)
    async with asyncio.timeout(5):
        await runner.join()
    assert said.read_text() == "bye\n"


# The input ends before the grace starts, as a closed pipe would: a
# handler that reads its input to the end gets there instead of waiting
# on a source that is still open until KILL.
@pytest.mark.asyncio
async def test_a_handler_reading_its_input_sees_it_end(tmp_path):
    pid_file, said = tmp_path / "pid", tmp_path / "said"
    program = (
        "import os, signal, sys, time\n"
        "def stop(*_):\n"
        "    data = sys.stdin.buffer.read()\n"
        f"    open({str(said)!r}, 'w').write(str(len(data)))\n"
        "    os._exit(0)\n"
        "signal.signal(signal.SIGTERM, stop)\n"
        f"open({str(pid_file)!r}, 'w').write(str(os.getpid()))\n"
        "while True:\n"
        "    time.sleep(0.05)\n"
    )

    runner = _start_runner(
        ProcessTable(bind=run_with_execution),
        f"exec {shlex.quote(sys.executable)} -c {shlex.quote(program)}",
        True,
        _one_then_open(),
    )
    await _wait_for_pid(pid_file)
    assert runner.terminate(signal.SIGTERM)
    async with asyncio.timeout(5):
        await runner.join()
    assert said.read_text() == "1"
    assert runner.program_code == 0


# A program that ignores the signal still ends: KILL follows the grace.
@pytest.mark.asyncio
async def test_a_child_that_ignores_the_signal_is_killed_after_the_grace(
    tmp_path,
):
    pid_file = tmp_path / "pid"
    runner = _start_runner(
        ProcessTable(bind=run_with_execution),
        f"trap '' TERM; echo $$ > {pid_file}; while :; do sleep 0.05; done",
    )
    child = await _wait_for_pid(pid_file)
    assert runner.terminate(signal.SIGTERM)
    async with asyncio.timeout(5):
        info = await runner.join()
    assert info.exit_code == 143
    assert await _ended(child)


@pytest.mark.asyncio
async def test_close_children_kills_every_running_tree(tmp_path):
    children: Children = {}
    pid_file = tmp_path / "pid"
    task = asyncio.create_task(
        run_program(
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
        ran = await task
    assert ran.exit_code != 0 and not children
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
        run_program(sys.executable, None, ["-c", ESCAPE, str(pid_file)], None)
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
        run_program(
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
            ran = await task
        assert ran.exit_code != 0 and not children
    finally:
        os.kill(escaped, signal.SIGKILL)


@pytest.mark.asyncio
async def test_a_pipe_keeps_the_tail_of_its_stderr():
    pipe = await open_program_pipe(
        sys.executable,
        [
            "-c",
            "import sys, time; sys.stderr.write('x' * 40000 + 'the-end'); "
            "sys.stderr.flush(); time.sleep(30)",
        ],
    )
    assert pipe.diagnostic is not None
    try:
        said = await pipe.diagnostic()
        assert said.endswith("the-end")
        assert len(said) == PIPE_DIAGNOSTIC_BYTES
    finally:
        await pipe.stop()
    assert await pipe.diagnostic() == said


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "script",
    [UNREAD_THEN_EXIT, UNREAD_FOREVER],
    ids=["exits_once_its_input_closes", "never_exits"],
)
async def test_stopping_a_pipe_does_not_wait_on_output_nobody_read(script):
    pipe = await open_program_pipe(sys.executable, ["-c", script])
    await asyncio.sleep(0.5)
    async with asyncio.timeout(5):
        await pipe.stop()


# A host program a runtime keeps as its child is one of the runner's
# native runs while it runs: this host, its PID and when it started, so a
# workspace that outlives this one can stop it; it goes once it ended.
@pytest.mark.asyncio
async def test_a_kept_child_is_a_native_run_of_its_runner(tmp_path):
    pid_file = tmp_path / "pid"
    children: Children = {}

    async def run() -> int:
        ran = await run_program(
            "sh",
            None,
            ["-c", f"echo $$ > {pid_file}; sleep 0.3"],
            None,
            children=children,
        )
        return ran.exit_code

    runner = ProcessTable(bind=run_with_execution).start(
        session_id="s", command="sh", cwd=PathSpec.from_str_path("/"), run=run
    )
    pid = await _wait_for_pid(pid_file)
    run = runner.runs[f"host:{pid}"]
    assert (run["host"], run["pid"], run["command"]) == (
        socket.gethostname(),
        pid,
        f"sh -c 'echo $$ > {pid_file}; sleep 0.3'",
    )
    assert abs(float(run["started_at"]) - time.time()) < 5
    assert (await runner.join()).exit_code == 0
    assert runner.runs == {}


# A run a lapsed workspace left on this host is stopped, its whole group,
# while its PID still names the process it started; a PID that names a
# later process, or a run of another host, is left alone.
@pytest.mark.asyncio
async def test_a_left_host_run_is_reaped_only_while_it_is_the_same(tmp_path):
    pid_file = tmp_path / "pid"
    child = await asyncio.create_subprocess_exec(
        "sh",
        "-c",
        f"trap '' TERM; echo $$ > {pid_file}; while :; do sleep 0.05; done",
        start_new_session=True,
    )
    pid = await _wait_for_pid(pid_file)
    run = host_run(pid, ["sh"])
    try:
        assert not await reap_host_run({**run, "host": "elsewhere"}, 15)
        assert not await reap_host_run({**run, "started_at": None}, 15)
        assert await reap_host_run({**run, "started_at": 0.0}, 15)
        assert child.returncode is None
        async with asyncio.timeout(5):
            assert await reap_host_run(run, 15)
            await child.wait()
        assert child.returncode == -9
    finally:
        if child.returncode is None:
            child.kill()
            await child.wait()


# A group this workspace may not signal is out of its reach while its
# leader still runs, so a workspace with the rights can stop it later; a
# group whose leader is gone was stopped already.
@pytest.mark.asyncio
async def test_a_host_run_it_may_not_signal_is_out_of_reach(
    tmp_path, monkeypatch
):
    pid_file = tmp_path / "pid"
    child = await asyncio.create_subprocess_exec(
        "sh",
        "-c",
        f"echo $$ > {pid_file}; while :; do sleep 0.05; done",
        start_new_session=True,
    )
    pid = await _wait_for_pid(pid_file)
    run = host_run(pid, ["sh"])

    def denied(group: int, signum: int) -> None:
        raise PermissionError(errno.EPERM, "Operation not permitted")

    monkeypatch.setattr(os, "killpg", denied)
    try:
        assert not await reap_host_run(run, 15)
    finally:
        monkeypatch.undo()
        child.kill()
        await child.wait()
