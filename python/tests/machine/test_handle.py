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
import shlex
from datetime import datetime, timedelta, timezone

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.cache.index.config import LookupStatus
from mirage.commands.config import Context
from mirage.context.session_context import run_as_process
from mirage.execution.process.constants import FIRST_PID
from mirage.execution.process.table import ProcessTable
from mirage.io.types import materialize
from mirage.machine import MachineConfig, MachineHandle
from mirage.machine.constants import (
    NOT_RUNNING_STATUS,
    PROCESS,
    RUN_PID_HOLD,
    RUN_PID_MARK,
    faketime_probe,
    is_run,
    stop_line,
)
from mirage.machine.errors import ConnectionLostError
from mirage.machine.handle import PidLineFilter
from mirage.machine.types import RunStatus
from mirage.runtime.errors import UnsupportedExecutionError
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.machine import RemoteRuntime
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.types import RunResult
from mirage.types import FileStat, FileType, Limit, PathSpec
from tests.fixtures.machine import machine_runtime, on


class RecordingMachine(MachineHandle):
    provider = "recbox"

    def __init__(self, captures=None, name="box", **kwargs) -> None:
        super().__init__(name, **kwargs)
        self.captures = captures
        self.execs: list[tuple[str, bytes | None, str]] = []
        self.exec_envs: list[dict[str, str]] = []
        self.connected = 0

    async def connect(self) -> None:
        self.connected += 1

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        if is_run(argv):
            env = {**env, PROCESS: argv[5].partition("=")[2]}
            argv = argv[7:]
        line = argv[2] if argv[:2] == ("/bin/sh", "-c") else shlex.join(argv)
        data = await materialize(stdin) if stdin is not None else None
        return await self.exec_line(line, data, env, cwd)

    async def exec_line(
        self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
    ) -> RunResult:
        self.execs.append((line, stdin, cwd))
        self.exec_envs.append(dict(env))
        return RunResult(
            stdout=b"ran:" + line.encode(), stderr=None, exit_code=0
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "python3 --version",
        "python -V",
        "node --version",
        "node -v",
        "tsc --version",
    ],
)
async def test_version_commands_reach_the_remote_environment(line):
    box = RecordingMachine(captures=(line.split()[0],))
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        **on(box, "workspace"),
    )
    try:
        io = await ws.shell(line)
        assert io.exit_code == 0
        assert await materialize(io.stdout) == b"ran:" + line.encode()
        assert box.execs[0][0] == line
    finally:
        await ws.close()


class FifoBox(RecordingMachine):
    async def connect(self) -> None:
        await super().connect()
        self.execs.append(("connect", None, "/"))

    async def exec_line(self, line, stdin, env, cwd):
        data = None if stdin is None else await materialize(stdin)
        if "rm -f" in line and self.lost:
            raise ConnectionError("gone")
        return await super().exec_line(line, data, env, cwd)

    lost = False


# A process substitution a program reads by path becomes a named pipe on
# the program's machine, only its owner's, made once the machine is
# reached, fed what the substitution writes, then removed; one it writes
# to stays its word.
@pytest.mark.asyncio
async def test_a_substitution_a_program_names_is_a_pipe_on_its_machine():
    box = FifoBox(captures=("node",))
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, **on(box))
    try:
        io = await ws.shell("node read.js <(echo hi) /dev/fd/9 >(cat)")
        assert io.exit_code == 0
    finally:
        await ws.close()
    lines = [line for line, _, _ in box.execs]
    [made] = [line for line in lines if line.startswith("mkfifo ")]
    fifo = made.removeprefix("mkfifo -m 600 ")
    assert fifo.startswith("/tmp/.mirage-fd-")
    ran = lines.index(f"node read.js {fifo} /dev/fd/9 /dev/fd/62")
    assert lines.index("connect") < lines.index(made) < ran
    fed = [(line, data) for line, data, _ in box.execs if "exec cat" in line]
    assert fed == [(f"[ -p {fifo} ] && exec cat > {fifo}", b"hi\n")]
    assert lines.index(f"exec 3<>{fifo}; exec 3>&-; rm -f {fifo}") > ran


# A pipe that cannot be removed, the machine gone, leaves the program's
# output as it ran.
@pytest.mark.asyncio
async def test_a_pipe_left_behind_keeps_the_programs_output():
    box = FifoBox(captures=("node",))
    box.lost = True
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, **on(box))
    try:
        io = await ws.shell("node read.js <(echo hi)")
        assert io.exit_code == 0
        assert (await materialize(io.stdout)).startswith(b"ran:node read.js ")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_first_line_connects_once():
    box = RecordingMachine(captures=("python3",))
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        **on(box, "workspace"),
    )
    try:
        io = await ws.shell("python3 x")
        assert await materialize(io.stdout) == b"ran:python3 x"
        assert box.connected == 1
        await ws.shell("python3 x")
        # The runtime connects on the first line, not per line.
        assert box.connected == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_failed_connect_retries_on_the_next_line():
    class FlakyBox(RecordingMachine):
        async def connect(self) -> None:
            await super().connect()
            if self.connected == 1:
                raise RuntimeError("sandbox not running")

    box = FlakyBox(captures=("python3",))
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        **on(box, "workspace"),
    )
    try:
        io = await ws.shell("python3 x")
        assert io.exit_code != 0
        assert b"not running" in await materialize(io.stderr)
        io = await ws.shell("python3 x")
        assert io.exit_code == 0
        assert box.connected == 2
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_handle_another_workspace_takes_connects_again():
    box = RecordingMachine(captures=("python3",))
    for _ in range(2):
        ws = Workspace(
            {"/data": RAMVFS()},
            mode=MountMode.EXEC,
            **on(box, "workspace"),
        )
        try:
            assert (await ws.shell("python3 x")).exit_code == 0
        finally:
            await ws.close()
    assert box.connected == 2


@pytest.mark.asyncio
async def test_cwd_passes_through_verbatim_and_env_merges():
    box = RecordingMachine(captures=("@line",), config={"env": {"BASE": "1"}})
    cwd = PathSpec.from_str_path("/data/deep")
    ctx = Context(flags={"c": "nvidia-smi"}, env={"LINE": "2"}, cwd=cwd)
    result = await machine_runtime(box).run_line(None, [], [], ctx)
    assert result.exit_code == 0
    # The sandbox serves the workspace at the same prefixes as the
    # host, so nothing is rewritten.
    assert box.execs[-1][2] == "/data/deep"
    assert box.exec_envs[-1]["BASE"] == "1"
    assert box.exec_envs[-1]["LINE"] == "2"


@pytest.mark.asyncio
async def test_stdin_bytes_reach_exec_line():
    box = RecordingMachine(captures=("@line",))
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        **on(box, "workspace"),
    )
    try:
        await ws.shell("wc -l", stdin=b"a\nb\n")
        assert box.execs[-1][1] == b"a\nb\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_machines_take_lines_not_stages():
    # A machine's runtime is a line executor, never the engine inside
    # one command: it carries the line entry point and no interpreter
    # entry point.
    runtime = machine_runtime(RecordingMachine())
    assert isinstance(runtime, LineExecutorMixin)
    assert not isinstance(runtime, LanguageRuntime)
    with pytest.raises(UnsupportedExecutionError, match="code execution"):
        await runtime.execute([], [], Context(flags={"c": "print(1)"}))


def test_config_dict_form_coerces():
    box = RecordingMachine(config={"env": {"A": "1"}})
    assert box.config == MachineConfig(env={"A": "1"})


@pytest.mark.asyncio
async def test_line_timeout_answers_124():
    class SlowBox(RecordingMachine):
        async def exec_line(
            self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
        ) -> RunResult:
            await asyncio.sleep(0.5)
            return await super().exec_line(line, stdin, env, cwd)

    box = SlowBox(captures=("python3",))
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        **on(box, "workspace"),
        command_limits={"@line": Limit(timeout_seconds=0.05)},
    )
    try:
        # A captured whole line runs under the line deadline like a
        # walked one: it answers exit 124.
        io = await ws.shell("python3 train.py")
        assert io.exit_code == 124
        assert await materialize(io.stderr) == b"line: timed out after 0.05s\n"
    finally:
        await ws.close()


# A run cancelled midway (head closed its pipe, a timeout) may leave its
# program running in the box, so every process it started is stopped by
# the run's id, with one more exec that carries no id of its own.
@pytest.mark.asyncio
async def test_a_cancelled_run_stops_what_it_left_in_the_box():
    class StuckBox(RecordingMachine):
        async def exec_line(
            self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
        ) -> RunResult:
            result = await super().exec_line(line, stdin, env, cwd)
            if line == "yes":
                await asyncio.Event().wait()
            return result

    box = StuckBox(captures=("yes",))
    ctx = Context(flags={"c": "yes"}, cwd=PathSpec.from_str_path("/"))
    task = asyncio.create_task(
        machine_runtime(box).run_line(None, [], [], ctx)
    )
    while not box.execs:
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    tag = box.exec_envs[0][PROCESS]
    assert [line for line, _, _ in box.execs] == ["yes", stop_line(tag)]
    assert PROCESS not in box.exec_envs[1]


# A run a ``kill`` stopped is stopped in the box with the signal it named.
@pytest.mark.asyncio
async def test_a_killed_run_is_stopped_in_the_box_with_its_signal():
    class StuckBox(RecordingMachine):
        async def exec_line(
            self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
        ) -> RunResult:
            result = await super().exec_line(line, stdin, env, cwd)
            if line == "yes":
                await asyncio.Event().wait()
            return result

    box = StuckBox(captures=("yes",))
    ctx = Context(flags={"c": "yes"}, cwd=PathSpec.from_str_path("/"))

    async def run() -> int:
        return (
            await machine_runtime(box).run_line(None, [], [], ctx)
        ).exit_code

    runner = ProcessTable(bind=run_as_process).start(
        session_id="s", command="yes", cwd=ctx.cwd, run=run
    )
    while not box.execs:
        await asyncio.sleep(0)
    assert runner.terminate(2)
    assert (await runner.join()).exit == 130
    assert box.exec_envs[0][PROCESS] == str(runner.record.id)
    assert [line for line, _, _ in box.execs] == [
        "yes",
        stop_line(str(runner.record.id), 2),
    ]


class DroppedBox(RecordingMachine):
    error: Exception = ConnectionLostError(
        "closed by remote host", b"step 0\n", b"warn\n"
    )

    async def exec_line(
        self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
    ) -> RunResult:
        result = await super().exec_line(line, stdin, env, cwd)
        if line.startswith("train"):
            raise self.error
        return result


class StreamingDroppedBox(DroppedBox):
    error = ConnectionLostError("closed by remote host", b"step 0\n")

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        if errors is not None:
            await errors(b"warn\n")
        return await super()._exec_argv(argv, stdin, env, cwd, output, errors)


# Errors a transport streamed before the drop stay beside the message.
@pytest.mark.asyncio
async def test_a_dropped_run_keeps_the_errors_it_streamed():
    box = StreamingDroppedBox(captures=("train",))
    ctx = Context(flags={"c": "train"}, cwd=PathSpec.from_str_path("/"))
    ran = await machine_runtime(box).run_line(None, [], [], ctx)
    assert (ran.exit_code, ran.stdout, ran.stderr) == (
        129,
        b"step 0\n",
        f"warn\nmirage: {box.machine}: connection lost\n".encode(),
    )


# A run whose output was kept rather than streamed keeps what it read
# before the drop.
@pytest.mark.asyncio
async def test_a_dropped_run_keeps_the_output_it_read():
    box = DroppedBox(captures=("train",))
    ctx = Context(flags={"c": "train"}, cwd=PathSpec.from_str_path("/"))
    ran = await machine_runtime(box).run_line(None, [], [], ctx)
    assert (ran.exit_code, ran.stdout, ran.stderr) == (
        129,
        b"step 0\n",
        f"warn\nmirage: {box.machine}: connection lost\n".encode(),
    )


@pytest.mark.asyncio
async def test_a_dropped_connection_ends_the_line_as_hung_up():
    box = DroppedBox(captures=("train",))
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, **on(box))
    try:
        io = await ws.shell("train")
        assert io.exit_code == 129
        assert await materialize(io.stderr) == (
            f"warn\nmirage: {box.machine}: connection lost\n".encode()
        )
    finally:
        await ws.close()


# Only a transport's ConnectionLostError means the connection went; an OS
# error of that family from elsewhere in the run stays the error it is.
@pytest.mark.asyncio
async def test_another_connection_family_error_is_not_a_lost_connection():
    box = DroppedBox(captures=("train",))
    box.error = ConnectionResetError("closed by remote host")
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, **on(box))
    try:
        io = await ws.shell("train")
        assert io.exit_code != 129
        assert b"connection lost" not in await materialize(io.stderr)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_job_whose_connection_dropped_is_listed_as_hung_up():
    box = DroppedBox(captures=("train",))
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, **on(box))
    try:
        await ws.shell("train &")
        rows = b"Running"
        while b"Running" in rows:
            await asyncio.sleep(0.01)
            rows = await materialize((await ws.shell("jobs")).stdout)
        assert rows.endswith(b"[1]+  Hangup                  train\n")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_job_whose_connection_dropped_is_reported_hung_up():
    box = DroppedBox(captures=("train",))
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, **on(box))
    try:
        await ws.shell("train &")
        io = await ws.shell("wait %1")
        assert io.exit_code == 129
        assert b"Hangup" in await materialize(io.stderr)
    finally:
        await ws.close()


# A run in the box carries the id of the process it runs as, which a
# workspace that outlives this one stops it by.
@pytest.mark.asyncio
async def test_a_run_in_the_box_is_tagged_with_its_process():
    box = RecordingMachine(captures=("yes",))
    ctx = Context(flags={"c": "yes"}, cwd=PathSpec.from_str_path("/"))

    async def run() -> int:
        return (
            await machine_runtime(box).run_line(None, [], [], ctx)
        ).exit_code

    runner = ProcessTable("w1", bind=run_as_process).start(
        session_id="s", command="yes", cwd=ctx.cwd, run=run
    )
    assert (await runner.join()).exit == 0
    assert box.exec_envs[0][PROCESS] == f"w1:{FIRST_PID}"


# A run another workspace left is stopped by its tag, the box reached
# first if this runtime never was. The stop says whether the box held the
# run: a box that holds none of it and a stop that failed both answer
# False, so neither counts as having stopped it.
@pytest.mark.asyncio
@pytest.mark.parametrize("code,held", [(0, True), (NOT_RUNNING_STATUS, False)])
async def test_a_left_run_is_stopped_by_its_tag(code, held):
    class AnsweringBox(RecordingMachine):
        async def exec_line(self, line, stdin, env, cwd) -> RunResult:
            await super().exec_line(line, stdin, env, cwd)
            return RunResult(stdout=b"", stderr=None, exit_code=code)

    box = AnsweringBox(captures=("yes",))
    assert await box.stop("t1", 15) is held
    assert box.connected == 1
    assert [line for line, _, _ in box.execs] == [stop_line("t1", 15)]


@pytest.mark.asyncio
async def test_a_failed_stop_answers_false():
    class FailingBox(RecordingMachine):
        async def exec_line(self, line, stdin, env, cwd) -> RunResult:
            return RunResult(stdout=b"", stderr=None, exit_code=127)

    assert await FailingBox(captures=("yes",)).stop("t1", 15) is False


@pytest.mark.asyncio
async def test_a_box_that_stops_answering_holds_a_cancel_only_so_long(
    monkeypatch,
):
    class DeadBox(RecordingMachine):
        async def exec_line(
            self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
        ) -> RunResult:
            await super().exec_line(line, stdin, env, cwd)
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    monkeypatch.setattr(
        "mirage.machine.handle.MACHINE_STOP_WAIT_SECONDS", 0.01
    )
    box = DeadBox(captures=("yes",))
    ctx = Context(flags={"c": "yes"}, cwd=PathSpec.from_str_path("/"))
    task = asyncio.create_task(
        machine_runtime(box).run_line(None, [], [], ctx)
    )
    while not box.execs:
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 5)
    assert len(box.execs) == 2


@pytest.mark.asyncio
async def test_line_output_caps_truncate_with_notice():
    class ChattyBox(RecordingMachine):
        async def exec_line(
            self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
        ) -> RunResult:
            return RunResult(stdout=b"a\nb\nc\n", stderr=None, exit_code=0)

    guards = {"python3": Limit(max_lines=2)}
    box = ChattyBox(captures=("python3",))
    ws = Workspace(
        {"/data": (RAMVFS(), MountMode.EXEC, guards)},
        mode=MountMode.EXEC,
        **on(box, "workspace"),
    )
    try:
        io = await ws.shell("python3 train.py")
        assert io.exit_code == 0
        assert await materialize(io.stdout) == b"a\nb\n"
        assert b"truncated at limit" in await materialize(io.stderr)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_remote_line_invalidates_local_read_caches():
    box = RecordingMachine(captures=("python3",))
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        **on(box, "workspace"),
    )
    try:
        mount = next(m for m in ws._registry.mounts() if m.prefix == "/data/")
        stale = FileStat(
            name="stale.txt", type=FileType.FILE, fingerprint="stale"
        )
        live = datetime.now(timezone.utc) + timedelta(hours=1)
        await mount.index_store.set_dir("/", [("stale.txt", stale)], live)
        assert (await mount.index_store.list_dir("/")).entries is not None
        await ws.shell("python3 anything")
        # Expired, so the next stat or listing asks the backend again.
        listed = await mount.index_store.list_dir("/")
        assert listed.status is LookupStatus.EXPIRED
    finally:
        await ws.close()


def test_reach_is_remote():
    assert RemoteRuntime.reach == "remote"


class FaketimeBox(RecordingMachine):
    """Answers the libfaketime probe as a sandbox holding ``holds``, or
    none when it is empty."""

    def __init__(self, holds: str) -> None:
        super().__init__(captures=("python3",))
        self.holds = holds

    async def exec_line(
        self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
    ) -> RunResult:
        if line != faketime_probe():
            return await super().exec_line(line, stdin, env, cwd)
        self.execs.append((line, stdin, cwd))
        self.exec_envs.append(dict(env))
        found = f"{self.holds}\n" if self.holds else ""
        return RunResult(stdout=found.encode(), stderr=None, exit_code=0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "holds, system_time",
    [
        ("/usr/lib/faketime/libfaketime.so.1", "2026-03-02T09:00:00Z"),
        ("", "2026-03-02T09:00:00Z"),
        ("/usr/lib/faketime/libfaketime.so.1", None),
    ],
)
async def test_a_program_gets_the_system_time_through_the_sandboxs_libfaketime(
    holds, system_time
):
    box = FaketimeBox(holds)
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        **on(box, "workspace"),
        system_time=system_time,
    )
    try:
        await ws.shell("python3 a")
        await ws.shell("python3 b")
        probes = [line for line, _, _ in box.execs if line == faketime_probe()]
        assert len(probes) == (0 if system_time is None else 1)
        env = box.exec_envs[-1]
        if holds and system_time is not None:
            assert env["LD_PRELOAD"] == holds
            assert env["FAKETIME_FMT"] == "%s"
            assert float(env["FAKETIME"][1:]) == pytest.approx(
                1772442000, abs=5
            )
        else:
            assert "FAKETIME" not in env
    finally:
        await ws.close()


class CountedBox(RecordingMachine):
    """``answers`` is what its probes exit with, in turn."""

    def __init__(self) -> None:
        super().__init__(captures=("python3",))
        self.answers = [1, 0]
        self.probes = 0

    async def exec_line(
        self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
    ) -> RunResult:
        if line != faketime_probe():
            return await super().exec_line(line, stdin, env, cwd)
        self.probes += 1
        await asyncio.sleep(0.01)
        exit_code = self.answers.pop(0) if self.answers else 0
        return RunResult(
            stdout=b"/usr/lib/faketime/libfaketime.so.1\n",
            stderr=None,
            exit_code=exit_code,
        )


@pytest.mark.asyncio
async def test_a_machine_is_asked_once_and_again_after_a_failed_probe():
    box = CountedBox()
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        **on(box, "workspace"),
        system_time="2026-03-02T09:00:00Z",
    )
    try:
        await ws.shell("python3 a")
        assert "FAKETIME" not in box.exec_envs[-1]
        await asyncio.gather(ws.shell("python3 b"), ws.shell("python3 c"))
        assert "FAKETIME" in box.exec_envs[-1]
        await ws.shell("python3 d")
        assert box.probes == 2
    finally:
        await ws.close()


async def _filtered(chunks: list[bytes], search: bool) -> tuple[bytes, list]:
    out = bytearray()
    seen: list[RunStatus] = []

    async def keep(chunk: bytes) -> None:
        out.extend(chunk)

    line = PidLineFilter(keep, seen.append, search)
    for chunk in chunks:
        await line.write(chunk)
    await line.finish()
    return bytes(out), seen


# stderr may carry the exec client's own words ahead of the pid line, which
# can arrive in pieces; the line comes out and its pid and start are told.
@pytest.mark.asyncio
async def test_the_pid_line_comes_out_of_stderr_after_the_clients_words():
    out, seen = await _filtered(
        [
            b"Defaulted container\n",
            RUN_PID_MARK[:4],
            RUN_PID_MARK[4:] + b"81",
            b"2 99\nerr\n",
        ],
        search=True,
    )
    assert out == b"Defaulted container\nerr\n"
    assert seen == [RunStatus(812, 99.0, None)]


# stdout carries the line only at its very start; anything else passes at
# once, and a line further in is the program's own.
@pytest.mark.asyncio
async def test_stdout_gives_up_the_pid_line_only_at_its_start():
    assert await _filtered([RUN_PID_MARK + b"7 1\nout"], search=False) == (
        b"out",
        [RunStatus(7, 1.0, None)],
    )
    late = b"x" + RUN_PID_MARK + b"7 1\n"
    assert await _filtered([late], search=False) == (late, [])


# A run whose wrapper wrote no line keeps every byte it wrote, released at
# once past the most stderr may hold, else when the stream ends.
@pytest.mark.asyncio
async def test_a_stream_with_no_pid_line_keeps_every_byte():
    assert await _filtered([b"only err"], search=True) == (b"only err", [])
    big = b"e" * (RUN_PID_HOLD + 1)
    assert await _filtered([big, b"!"], search=True) == (big + b"!", [])


class PidLineBox(RecordingMachine):
    joined = False

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        result = await super()._exec_argv(
            argv, stdin, env, cwd, output, errors
        )
        if self.joined:
            return RunResult(
                stdout=RUN_PID_MARK + b"812 99\n" + result.stdout,
                stderr=None,
                exit_code=0,
            )
        await errors(RUN_PID_MARK + b"812 99\n")
        await output(RUN_PID_MARK + b"7 1\nmine\n")
        return RunResult(stdout=b"", stderr=b"", exit_code=0)


# The wrapper's pid line comes on stderr, so a program's own stdout that
# starts like it is left whole; an exec that returns its streams joined
# brings the line at the start of stdout. Either way the first line gives
# the program's pid.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("joined", "stdout"),
    [(False, RUN_PID_MARK + b"7 1\nmine\n"), (True, b"ran:train")],
)
async def test_the_pid_line_gives_the_programs_pid_once(joined, stdout):
    box = PidLineBox(captures=("train",))
    box.joined = joined
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, **on(box))
    try:
        io = await ws.shell("train")
        assert await materialize(io.stdout) == stdout
        [program] = [p for p in await ws.processes() if p.runtime]
        assert program.machine_pid is not None
        assert program.machine_pid.pid == 812
        assert program.machine_instance == "box"
    finally:
        await ws.close()
