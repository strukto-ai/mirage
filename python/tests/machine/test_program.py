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
import re
import shlex
import signal
import sys
import time
from collections import Counter
from collections.abc import AsyncIterator

import pytest

from mirage.context.session_context import run_as_process
from mirage.execution.process.table import ProcessTable
from mirage.execution.types import MachinePid
from mirage.machine.constants import PIPE_DIAGNOSTIC_BYTES
from mirage.machine.errors import ConnectionLostError
from mirage.machine.program import (
    FAKETIME_LIBRARIES,
    Children,
    _served,
    close_children,
    host_signal,
    mirage_signal,
    open_program_pipe,
    run_program,
    scan_host,
    serve,
    stop_host_run,
    system_time_env,
    unserve,
)
from mirage.types import PathSpec
from mirage.utils.clock import (
    ShiftedClock,
    SystemClock,
    run_with_system_clock,
)

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


async def _running(pid: int) -> bool:
    """Whether ``pid`` runs: present, and no zombie.

    Args:
        pid (int): the process to look for.
    """
    ps = await asyncio.create_subprocess_exec(
        "ps", "-o", "stat=", "-p", str(pid), stdout=asyncio.subprocess.PIPE
    )
    out, _ = await ps.communicate()
    state = out.decode().strip()
    return bool(state) and not state.startswith("Z")


@pytest.mark.parametrize(
    ("name", "number"),
    [("KILL", 9), ("USR1", 10), ("TERM", 15), ("CONT", 18), ("STOP", 19)],
)
def test_a_signal_is_numbered_as_this_host_does_and_back(name, number):
    native = int(getattr(signal, f"SIG{name}"))
    assert host_signal(number) == native
    assert mirage_signal(native) == number


def test_signal_zero_stays_zero():
    assert host_signal(0) == 0


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


# A client to a machine that ends on a signal took the connection with it,
# so how the program in the box ended is unknown; its own exit is the
# program's.
@pytest.mark.asyncio
async def test_a_connection_client_ended_by_a_signal_is_a_lost_connection():
    with pytest.raises(ConnectionLostError) as lost:
        await run_program(
            "sh", None, ["-c", "echo hi; kill -KILL $$"], None, connection=True
        )
    assert lost.value.stdout == b"hi\n"
    ran = await run_program(
        "sh", None, ["-c", "exit 3"], None, connection=True
    )
    assert ran.exit_code == 3


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
async def test_a_direct_program_ends_though_what_it_left_holds_its_output():
    started = time.monotonic()
    ran = await run_program(
        "sh", None, ["-c", "sleep 4 & echo out"], None, direct=True
    )
    assert ran.stdout == b"out\n"
    assert ran.exit_code == 0
    assert time.monotonic() - started < 3


@pytest.mark.asyncio
async def test_a_missing_cli_raises_its_hint():
    with pytest.raises(RuntimeError, match="install it"):
        await run_program("mirage-no-such-program", "install it", [], None)


def test_a_served_folder_is_known_by_its_absolute_and_resolved_names(
    tmp_path, monkeypatch
):
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "link").symlink_to(real)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr("mirage.machine.program.SERVED", Counter())
    assert serve("link/mp") == [
        str(tmp_path / "link" / "mp"),
        os.path.join(os.path.realpath(real), "mp"),
    ]


def test_a_folder_stays_served_while_another_mount_records_it(monkeypatch):
    # A lazily released mount may end after a new one took its path.
    monkeypatch.setattr("mirage.machine.program.SERVED", Counter())
    old, new = serve("/tmp/mirage-mp"), serve("/tmp/mirage-mp")
    unserve(old)
    assert _served("/tmp/mirage-mp/a")
    unserve(new)
    assert not _served("/tmp/mirage-mp/a")


@pytest.mark.asyncio
@pytest.mark.parametrize("served", [True, False])
async def test_a_child_in_a_served_folder_starts_outside_it(
    tmp_path, monkeypatch, served
):
    # A folder a kernel mount here serves answers on the loop spawning the
    # child, which waits inside the spawn until the child runs, so the
    # child starts outside and the prelude takes it in.
    started = []
    loop = asyncio.get_running_loop()
    real = loop.subprocess_exec

    async def subprocess_exec(factory, program, *args, cwd=None, **kwargs):
        started.append((program, cwd))
        return await real(factory, program, *args, cwd=cwd, **kwargs)

    monkeypatch.setattr(loop, "subprocess_exec", subprocess_exec)
    monkeypatch.setattr(
        "mirage.machine.program.SERVED",
        Counter([str(tmp_path)] if served else []),
    )
    ran = await run_program(
        sys.executable,
        None,
        ["-c", "import os; print(os.getcwd())"],
        None,
        cwd=str(tmp_path),
    )
    assert ran.stdout.decode().strip() == os.path.realpath(tmp_path)
    assert started == [
        ("/bin/sh", None) if served else (sys.executable, str(tmp_path))
    ]


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
        ProcessTable(bind=run_as_process),
        f"trap 'echo bye > {said}; exit 0' TERM; echo $$ > {pid_file}; "
        "while :; do sleep 0.05; done",
    )
    await _wait_for_pid(pid_file)
    assert runner.terminate(signal.SIGTERM)
    async with asyncio.timeout(5):
        info = await runner.join()
    assert said.read_text() == "bye\n"
    assert info.exit == 143


@pytest.mark.asyncio
async def test_a_runner_killed_with_kill_gives_the_child_no_handler(
    tmp_path,
):
    pid_file, said = tmp_path / "pid", tmp_path / "said"
    runner = _start_runner(
        ProcessTable(bind=run_as_process),
        f"trap 'echo bye > {said}; exit 0' TERM; echo $$ > {pid_file}; "
        "while :; do sleep 0.05; done",
    )
    child = await _wait_for_pid(pid_file)
    assert runner.terminate(signal.SIGKILL)
    async with asyncio.timeout(5):
        info = await runner.join()
    assert not said.exists()
    assert info.exit == 137
    assert await _ended(child)


# A KILL while a program still has the grace an earlier TERM gave it ends
# that grace: what ignores TERM is killed at once, as a second
# ``kill -KILL`` does, not a second later.
@pytest.mark.asyncio
async def test_a_kill_during_the_grace_ends_it(tmp_path):
    pid_file = tmp_path / "pid"
    runner = _start_runner(
        ProcessTable(bind=run_as_process),
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
    assert info.exit == 137
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
        ProcessTable(bind=run_as_process),
        f"{trap}echo $$ > {pid_file}; while :; do sleep 0.05; done",
        direct,
    )
    await _wait_for_pid(pid_file)
    assert runner.terminate(signum)
    async with asyncio.timeout(5):
        info = await runner.join()
    assert (info.exit, runner.program_code) == (128 + signum, code)


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
        ProcessTable(bind=run_as_process),
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
        ProcessTable(bind=run_as_process),
        f"trap 'exit 0' TERM; echo $$ > {pid_file}; "
        "while :; do sleep 0.05; done",
    )
    await _wait_for_pid(pid_file)
    assert runner.terminate(signal.SIGTERM)
    async with asyncio.timeout(5):
        info = await runner.join()
    assert (info.exit, info.error) == (143, None)


# The grace is the group's: a descendant still handling the signal after
# the program it ran under has exited keeps its second.
@pytest.mark.asyncio
async def test_a_descendant_keeps_the_grace_after_its_parent_exits(tmp_path):
    pid_file, said = tmp_path / "pid", tmp_path / "said"
    runner = _start_runner(
        ProcessTable(bind=run_as_process),
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
        ProcessTable(bind=run_as_process),
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
        ProcessTable(bind=run_as_process),
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
        ProcessTable(bind=run_as_process),
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
        ProcessTable(bind=run_as_process),
        f"trap '' TERM; echo $$ > {pid_file}; while :; do sleep 0.05; done",
    )
    child = await _wait_for_pid(pid_file)
    assert runner.terminate(signal.SIGTERM)
    async with asyncio.timeout(5):
        info = await runner.join()
    assert info.exit == 143
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


# A host program a runtime runs directly is its runner's process on this
# host: the runner's record names its PID and when it started, so a
# workspace that outlives this one can stop it. A client that runs a
# program elsewhere (``docker exec``) is not the program, so it names none.
@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [True, False])
async def test_a_program_run_directly_names_its_host_pid(tmp_path, direct):
    pid_file = tmp_path / "pid"
    children: Children = {}

    async def run() -> int:
        ran = await run_program(
            "sh",
            None,
            ["-c", f"echo $$ > {pid_file}; sleep 0.3"],
            None,
            children=children,
            direct=direct,
        )
        return ran.exit_code

    runner = ProcessTable(bind=run_as_process).start(
        session_id="s", command="sh", cwd=PathSpec.from_str_path("/"), run=run
    )
    pid = await _wait_for_pid(pid_file)
    found = runner.record.machine_pid
    assert (await runner.join()).exit == 0
    if not direct:
        assert found is None
        return
    assert found is not None and found.pid == pid
    assert abs(found.started - time.time()) < 5 and found.exited is None


# A program that exits while what it started holds its output open marks
# its record with when it exited, the last time its group was known.
@pytest.mark.asyncio
async def test_a_program_that_exits_first_marks_its_record(tmp_path):
    pid_file = tmp_path / "pid"
    children: Children = {}

    async def run() -> int:
        ran = await run_program(
            "sh",
            None,
            ["-c", f"echo $$ > {pid_file}; sleep 0.5 &"],
            None,
            children=children,
            direct=True,
        )
        return ran.exit_code

    runner = ProcessTable(bind=run_as_process).start(
        session_id="s", command="sh", cwd=PathSpec.from_str_path("/"), run=run
    )
    await _wait_for_pid(pid_file)

    def exited() -> float | None:
        found = runner.record.machine_pid
        return found.exited if found is not None else None

    async with asyncio.timeout(5):
        while exited() is None:
            await asyncio.sleep(0.01)
    at = exited()
    assert at is not None and abs(at - time.time()) < 5
    assert (await runner.join()).exit == 0


# A program a lapsed workspace left on this host is stopped, its whole
# group, while its PID still names the process it started; a PID that
# names a later process is left alone.
@pytest.mark.asyncio
async def test_a_left_host_run_is_stopped_only_while_it_is_the_same(tmp_path):
    pid_file = tmp_path / "pid"
    child = await asyncio.create_subprocess_exec(
        "sh",
        "-c",
        f"trap '' TERM; echo $$ > {pid_file}; while :; do sleep 0.05; done",
        start_new_session=True,
    )
    pid = await _wait_for_pid(pid_file)
    found = MachinePid(pid, time.time())
    try:
        assert await stop_host_run(MachinePid(pid, 0.0), None, 15)
        assert child.returncode is None
        async with asyncio.timeout(5):
            assert await stop_host_run(found, None, 15)
            await child.wait()
        assert child.returncode == -9
    finally:
        if child.returncode is None:
            child.kill()
            await child.wait()


# A run whose leader exited before the program it started is stopped too,
# its group outliving the leader, while a member started by the time the
# group was last known to be the run's; a group none of whose members
# proves that, which may have taken the id since, is left alone and out of
# reach, so its record stays.
@pytest.mark.asyncio
async def test_a_left_host_run_whose_leader_exited_is_stopped(tmp_path):
    pid_file = tmp_path / "pid"
    child = await asyncio.create_subprocess_exec(
        "sh",
        "-c",
        f"sleep 30 & echo $! > {pid_file}",
        start_new_session=True,
    )
    found = MachinePid(child.pid, time.time())
    await child.wait()
    survivor = await _wait_for_pid(pid_file)
    try:
        assert not await stop_host_run(found, None, 15)
        assert not await stop_host_run(found, found.started - 60, 15)
        assert await _running(survivor)
        assert await stop_host_run(
            MachinePid(found.pid, found.started, time.time()), None, 15
        )
        assert await _ended(survivor)
    finally:
        if await _running(survivor):
            os.kill(survivor, 9)


# A host whose ps fails before it lists every process reaches nothing: a
# group missing from a cut-short list is not taken for gone.
@pytest.mark.asyncio
async def test_a_host_run_is_out_of_reach_when_ps_fails(tmp_path, monkeypatch):
    fake = tmp_path / "ps"
    fake.write_text('#!/bin/sh\ncase "$1" in -A) kill -9 $$ ;; esac\nexit 1\n')
    fake.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}:{os.environ['PATH']}")
    assert not await stop_host_run(
        MachinePid(2**22 + 7, time.time()), None, 15
    )


def _denied(group: int, signum: int) -> None:
    raise PermissionError(errno.EPERM, "Operation not permitted")


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
    monkeypatch.setattr(os, "killpg", _denied)
    try:
        assert not await stop_host_run(MachinePid(pid, time.time()), None, 15)
    finally:
        monkeypatch.undo()
        child.kill()
        await child.wait()


@pytest.mark.asyncio
async def test_system_time_env_preloads_libfaketime_at_the_offset(
    tmp_path, monkeypatch
):
    library = tmp_path / "libfaketime.so.1"
    library.write_bytes(b"")
    monkeypatch.setattr(
        "mirage.machine.program.FAKETIME_LIBRARIES",
        (str(tmp_path / "none"), str(library)),
    )
    monkeypatch.setattr(sys, "platform", "linux")
    start = time.time() - 3600.25
    clock = ShiftedClock.starting(SystemClock(), start)

    env = await run_with_system_clock(
        clock, system_time_env({"LD_PRELOAD": "/opt/x.so"})
    )
    assert env["LD_PRELOAD"] == f"{library}:/opt/x.so"
    assert env["FAKETIME_FMT"] == "%s"
    assert env["FAKETIME_DONT_RESET"] == "1"
    assert env["FAKETIME_DONT_FAKE_MONOTONIC"] == "1"
    assert env["NO_FAKE_STAT"] == "1"
    assert re.fullmatch(r"@\d+\.\d{3}", env["FAKETIME"])
    assert float(env["FAKETIME"][1:]) == pytest.approx(start, abs=0.05)
    library.unlink()
    assert await run_with_system_clock(clock, system_time_env({})) == {}
    assert await system_time_env({}) == {}
    assert FAKETIME_LIBRARIES


@pytest.mark.asyncio
@pytest.mark.skipif(sys.platform == "win32", reason="ps")
async def test_a_host_scan_leaves_a_group_whose_pid_went_to_another_program():
    leader = await asyncio.create_subprocess_exec(
        "sleep", "30", start_new_session=True
    )
    began = time.time()
    try:
        rows = await scan_host({leader.pid: ("run", began)})
        assert [(row.tag, row.pid) for row in rows] == [("run", leader.pid)]
        assert await scan_host({leader.pid: ("old", began - 3600)}) == []
    finally:
        leader.kill()
        await leader.wait()
