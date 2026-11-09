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
import time
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.cache.index.config import LookupStatus
from mirage.commands.config import Context
from mirage.context.session_context import run_as_process
from mirage.execution.job.handle import JobHandle
from mirage.execution.machine.table import MachineTable
from mirage.execution.process.constants import FIRST_PID
from mirage.execution.process.table import ProcessTable
from mirage.execution.ram import RAMExecutionStore
from mirage.execution.types import MachinePid
from mirage.io.types import materialize
from mirage.machine import MachineConfig, MachineHandle
from mirage.machine import handle as handle_module
from mirage.machine.constants import (
    JOB_REFUSED_STATUS,
    JOB_REMOVE,
    JOB_START,
    JOB_VIEW,
    NOT_RUNNING_STATUS,
    PROCESS,
    SETSID_PROBE,
    faketime_probe,
    is_run,
    signal_line,
    stop_line,
)
from mirage.machine.errors import ConnectionLostError
from mirage.machine.registry import known_providers, machine_class
from mirage.runtime.errors import UnsupportedExecutionError
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.machine import MachineRuntime
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.types import RunResult
from mirage.shell.console import Channel
from mirage.types import FileStat, FileType, Limit, PathSpec
from mirage.workspace.executor.background import resume_job
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
        f"warn\nmirage: {box.id}: connection lost\n".encode(),
    )


@pytest.mark.asyncio
async def test_a_dropped_connection_ends_the_line_as_hung_up():
    box = DroppedBox(captures=("train",))
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, **on(box))
    try:
        io = await ws.shell("train")
        assert io.exit_code == 129
        assert await materialize(io.stderr) == (
            f"warn\nmirage: {box.id}: connection lost\n".encode()
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
    assert MachineRuntime.reach == "remote"


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


class JobBox(RecordingMachine):
    """A box that detaches jobs, answering each viewer from ``views``:
    the stdout and stderr chunks it prints, then how it ends (an exit
    code, an error it raises, or an event it waits on). A stderr chunk's
    end mark gets the view's secret; one split across chunks does not."""

    detaches = True

    def __init__(self, views=(), setsid=True, **kwargs) -> None:
        super().__init__(**kwargs)
        self.views = list(views)
        self.setsid = setsid
        self.start_code = 0
        self.start_said = b""
        self.start_gate: asyncio.Event | None = None
        self.probes = 0
        self.started: list[tuple[str, ...]] = []
        self.viewed: list[tuple[str, ...]] = []
        self.removed: list[str] = []

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        script = argv[2] if argv[:2] == ("/bin/sh", "-c") else None
        if script == JOB_START:
            self.started.append(argv[4:])
            self.exec_envs.append(dict(env))
            if self.start_gate is not None:
                await self.start_gate.wait()
            return RunResult(
                stdout=self.start_said, stderr=None, exit_code=self.start_code
            )
        if script == JOB_VIEW:
            self.viewed.append(argv[4:7])
            mark = b"mirage-job " + argv[7].encode() + b" "
            out, err, end = self.views.pop(0)
            for chunk in out:
                await output(chunk)
            for chunk in err:
                await errors(chunk.replace(b"mirage-job ", mark))
            if isinstance(end, BaseException):
                raise end
            if isinstance(end, asyncio.Event):
                await end.wait()
                end = 0
            if isinstance(end, RunResult):
                return replace(
                    end,
                    stderr=end.stderr
                    and end.stderr.replace(b"mirage-job ", mark),
                )
            return RunResult(stdout=b"", stderr=None, exit_code=end)
        if script == JOB_REMOVE:
            self.removed.append(argv[4])
            return RunResult(stdout=b"", stderr=None, exit_code=0)
        return await super()._exec_argv(argv, stdin, env, cwd, output, errors)

    async def exec_line(self, line, stdin, env, cwd) -> RunResult:
        if line == SETSID_PROBE:
            self.probes += 1
            return RunResult(
                stdout=b"", stderr=None, exit_code=0 if self.setsid else 1
            )
        return await super().exec_line(line, stdin, env, cwd)


@pytest.fixture
def no_view_wait(monkeypatch):
    monkeypatch.setattr(handle_module, "VIEW_RETRY_SECONDS", 0)


async def _job_run(
    box, detachable=True, stdin=None, started=None, streamed=True
):
    """Run ``train`` on ``box`` as a job's process, its output streamed
    unless not ``streamed``: the result, stdout and stderr, and the
    process."""
    out, err, done = bytearray(), bytearray(), []
    ctx = Context(cwd=PathSpec.from_str_path("/"), stdin=stdin)

    async def output(data: bytes) -> None:
        out.extend(data)

    async def errors(data: bytes) -> None:
        err.extend(data)

    async def run() -> int:
        sinks = (output, errors) if streamed else (None, None)
        done.append(await box.run(("train",), ctx, None, *sinks))
        return done[0].exit_code

    runner = ProcessTable("w1", bind=run_as_process).start(
        session_id="s", command="train", cwd=ctx.cwd, run=run
    )
    runner.detachable = detachable
    if started is not None:
        started(runner)
    await runner.join()
    return done[0] if done else None, bytes(out), bytes(err), runner


def _keep_endings(runner) -> None:
    """Have ``runner`` run what waits for its ending once it is recorded."""
    runner.after_ending = []


async def _unrecorded(where) -> None:
    """A store that cannot record where a job runs."""
    raise RuntimeError("store unavailable")


def _tell_nowhere(runner) -> None:
    """Have ``runner`` tell its job's detaching to a store that fails."""
    runner.on_detach = _unrecorded


# However a viewer ends without the end mark, the job is viewed again from
# the bytes each stream delivered, so nothing comes twice or goes missing.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "end",
    [
        ConnectionLostError("closed by remote host"),
        RuntimeError("sdk stream ended"),
        255,
        0,
    ],
)
async def test_a_detached_job_is_viewed_again_from_what_it_delivered(
    end, no_view_wait
):
    box = JobBox(
        [
            ([b"step 0\n"], [b"warn\n"], end),
            ([b"step 1\n"], [b"\0mirage-job 3\n"], 0),
        ]
    )
    done, out, err, runner = await _job_run(box)
    assert (done.exit_code, out, err) == (3, b"step 0\nstep 1\n", b"warn\n")
    folder = box.viewed[0][0]
    assert [view[1:] for view in box.viewed] == [("0", "0"), ("7", "5")]
    assert box.started == [(folder, str(runner.record.id), "train")]
    assert PROCESS not in box.exec_envs[0]
    assert box.removed == [folder]


# The end mark is Mirage's, never the job's: one split across reads is
# held back, and a NUL the job wrote itself is delivered.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "chunks,said",
    [
        ([b"warn\n\0mirage-job ", b"0", b"\n"], b"warn\n"),
        ([b"a\0b\n", b"\0", b"mirage-job 0\n"], b"a\0b\n"),
    ],
)
async def test_the_end_mark_is_never_delivered(chunks, said):
    box = JobBox([([], chunks, 0)])
    done, _, err, _ = await _job_run(box)
    assert (done.exit_code, err) == (0, said)


# A mark the program wrote itself never ends its job, however its view
# ends (docker's client exits 0 when only its stream was cut): it lacks the
# view's secret, so the job is viewed again.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "end",
    [
        ConnectionLostError("closed by remote host"),
        RuntimeError("gone"),
        255,
        0,
    ],
)
async def test_a_mark_the_program_wrote_is_its_output(end, no_view_wait):
    fake = [b"\0mirage-j", b"ob 5ec4e7 0\n"]
    box = JobBox(
        [
            ([b"step 0\n"], fake, end),
            ([], [*fake, b"late\n", b"\0mirage-job 3\n"], 0),
        ]
    )
    done, out, err, _ = await _job_run(box)
    assert (done.exit_code, out, err) == (
        3,
        b"step 0\n",
        b"".join(fake) + b"late\n",
    )
    assert [view[1:] for view in box.viewed] == [("0", "0"), ("7", "0")]


# A view that ended early may not have delivered all its stdout (e2b sends
# the streams apart), so even its own mark ends nothing: the job is viewed
# again from what landed.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "end", [ConnectionLostError("closed by remote host"), RuntimeError("gone")]
)
async def test_a_view_that_failed_never_ends_its_job(end, no_view_wait):
    box = JobBox(
        [
            ([b"step 0\n"], [b"\0mirage-job 3\n"], end),
            ([b"step 1\n"], [b"\0mirage-job 3\n"], 0),
        ]
    )
    done, out, _, _ = await _job_run(box)
    assert (done.exit_code, out) == (3, b"step 0\nstep 1\n")
    assert [view[1:] for view in box.viewed] == [("0", "0"), ("7", "0")]


# A job whose wrapper went with no exit code is not left running: it ends
# hung up, and says so.
@pytest.mark.asyncio
async def test_a_lost_job_ends_hung_up():
    box = JobBox([([b"step 0\n"], [b"\0mirage-job lost\n"], 0)])
    done, out, err, runner = await _job_run(box)
    assert (done.exit_code, out, err) == (129, b"step 0\n", b"")
    assert done.stderr == f"mirage: {box.id}: job lost\n".encode()
    assert runner.ended_by == 1
    assert stop_line(str(runner.record.id), 15) in [
        line for line, _, _ in box.execs
    ]
    assert box.removed == [box.viewed[0][0]]


# A detached job a kill stops is stopped in the box by its tag, with the
# signal named, and its folder goes.
@pytest.mark.asyncio
async def test_a_killed_detached_job_is_stopped_and_its_folder_removed():
    box = JobBox([([], [], asyncio.Event())])
    task = asyncio.ensure_future(_job_run(box, started=_kill_when_viewed(box)))
    _, _, _, runner = await task
    tag = str(runner.record.id)
    assert [line for line, _, _ in box.execs][-1] == stop_line(tag, 15)
    assert box.removed == [box.viewed[0][0]]


def _kill_when_viewed(box):
    def started(runner) -> None:
        async def kill() -> None:
            while not box.viewed:
                await asyncio.sleep(0)
            runner.terminate(15)

        asyncio.ensure_future(kill())

    return started


# A signal a job takes and goes on reaches the group its detached program
# leads, so what it started stops and continues with it.
@pytest.mark.asyncio
async def test_a_signal_reaches_a_detached_jobs_group():
    gate = asyncio.Event()
    box = JobBox([([], [], gate)])
    sent = []

    def started(runner) -> None:
        async def signal() -> None:
            while not box.viewed:
                await asyncio.sleep(0)
            sent.append(await box.signal(str(runner.record.id), 19))
            gate.set()

        asyncio.ensure_future(signal())

    box.views.append(([], [b"\0mirage-job 0\n"], 0))
    _, _, _, runner = await _job_run(box, started=started)
    assert sent == [True]
    assert signal_line(str(runner.record.id), 19, True) in [
        line for line, _, _ in box.execs
    ]


# Only a detachable job's program, fed no input, on a box that detaches
# and holds setsid, detaches; any other run is one attached exec.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "detachable,stdin,detaches,setsid",
    [
        (False, None, True, True),
        (True, b"input", True, True),
        (True, None, False, True),
        (True, None, True, False),
    ],
)
async def test_a_run_that_does_not_qualify_stays_attached(
    detachable, stdin, detaches, setsid
):
    box = JobBox(setsid=setsid)
    box.detaches = detaches
    done, _, _, runner = await _job_run(box, detachable, stdin)
    assert (done.exit_code, box.started) == (0, [])
    assert box.execs[-1][0] == "train"
    assert box.exec_envs[-1][PROCESS] == str(runner.record.id)


@pytest.mark.asyncio
async def test_a_machine_serving_mounts_keeps_jobs_attached():
    class Served:
        async def validate(self, binding, cwd):
            return None

        def guarded(self, argv):
            return argv

        async def land(self):
            return []

    box = JobBox()
    box._mounts = Served()
    done, _, _, _ = await _job_run(box)
    assert (done.exit_code, box.started, box.probes) == (0, [], 0)


@pytest.mark.asyncio
async def test_a_box_is_asked_for_setsid_once():
    box = JobBox(
        [([], [b"\0mirage-job 0\n"], 0), ([], [b"\0mirage-job 0\n"], 0)]
    )
    await _job_run(box)
    await _job_run(box)
    assert (box.probes, len(box.started)) == (2 - 1, 2)


# A background job detaches only on a store a restart reads, and only when
# its statement redirects no output; its output and status reach the
# console as an attached job's would.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,lease,detached",
    [
        ("train &", 30.0, True),
        ("train > /data/log &", 30.0, False),
        ("train &", None, False),
        ("{ train; } &", 30.0, False),
        ("set -x; train &", 30.0, False),
    ],
)
async def test_a_background_job_detaches_where_a_restart_finds_it(
    line, lease, detached
):
    box = JobBox(
        [([b"step 0\n"], [b"\0mirage-job 3\n"], 0)], captures=("train",)
    )
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, **on(box))
    try:
        ws.job_table.store = RAMExecutionStore(lease_seconds=lease)
        await ws.shell(line)
        io = await ws.shell("wait %1")
        assert bool(box.started) is detached
        if detached:
            assert io.exit_code == 3
    finally:
        await ws.close()


# Jobs detach only on the providers a dropped connection was measured on.
def test_jobs_detach_on_the_measured_providers():
    assert {p for p in known_providers() if machine_class(p).detaches} == {
        "docker",
        "e2b",
        "microsandbox",
        "ssh",
    }


def _shared(box: MachineHandle) -> Workspace:
    """A workspace on ``box`` that another daemon may run too."""
    return Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        workspace_id="shared",
        session_id="s",
        **on(box),
    )


def _crash(ws: Workspace) -> None:
    """Leave a workspace as a crashed daemon would: its lease no longer
    renewed, whatever it runs left as it is."""
    lease = ws.job_table._lease
    assert lease is not None
    lease.cancel()


async def _until(check) -> None:
    async with asyncio.timeout(5):
        while not check():
            await asyncio.sleep(0.01)


# A daemon that takes the lease after one crashed adopts the detached job
# it left: the job keeps its number, its output goes on from what its
# console holds with nothing twice, and ``wait`` answers its real status,
# however far it got while no daemon held the lease.
@pytest.mark.asyncio
async def test_a_restarted_daemon_adopts_a_detached_job():
    store = RAMExecutionStore(lease_seconds=0.2)
    first = JobBox([([b"step 0\n"], [b"warn\n"], asyncio.Event())])
    old = _shared(first)
    old.job_table.store = store
    second = JobBox(captures=None)
    second.views = first.views
    second.views.append(([b"step 1\n"], [b"\0mirage-job 3\n"], 0))
    new = _shared(second)
    new.job_table.store = store
    try:
        await old.shell("train &", session_id="s")
        await _until(lambda: first.viewed)
        [job] = old.job_table.all_jobs()
        await _until(lambda: job.detached is not None)
        _crash(old)
        await asyncio.sleep(0.3)
        await new.shell("true", session_id="s")
        [adopted] = new.job_table.all_jobs()
        io = await new.shell("wait %1", session_id="s")
        assert io.exit_code == 3
        assert second.viewed[0][1:] == ("7", "5")
        assert adopted.process is not None
        assert adopted.process.record.pid == job.pid
        chunks, _, _ = await adopted.console.read_from(0)
        stdout = [c.data for c in chunks if c.channel == Channel.STDOUT]
        assert b"".join(stdout) == b"step 0\nstep 1\n"
        assert second.removed == [second.viewed[0][0]]
    finally:
        await new.close()
        await old.close()


# A daemon that lost the lease leaves a detached job to the daemon that
# adopts it: its run is cancelled without stopping the program or
# removing its folder.
@pytest.mark.asyncio
async def test_a_released_detached_job_is_left_running():
    box = JobBox([([], [], asyncio.Event())])

    def started(runner) -> None:
        async def release() -> None:
            while not box.viewed:
                await asyncio.sleep(0)
            runner.released = True
            runner.terminate(1)

        asyncio.ensure_future(release())

    _, _, _, runner = await _job_run(box, started=started)
    assert runner.detached
    assert not any(line.startswith("PATH=") for line, _, _ in box.execs[1:])
    assert box.removed == []


# A lease lost while the start has not answered releases the job too: the
# wrapper may already run its program, which the adopter views.
@pytest.mark.asyncio
async def test_a_job_released_while_starting_is_left_running():
    box = JobBox()
    box.start_gate = asyncio.Event()

    def started(runner) -> None:
        async def release() -> None:
            while not box.started:
                await asyncio.sleep(0)
            runner.released = runner.detached
            runner.terminate(1)

        asyncio.ensure_future(release())

    _, _, _, runner = await _job_run(box, started=started)
    assert runner.released
    assert not any(line.startswith("PATH=") for line, _, _ in box.execs[1:])
    assert box.removed == []


# An adopted job past its line's limit is stopped in the box and ends 124
# with the line's notice, as it would have where it started.
@pytest.mark.asyncio
async def test_an_adopted_job_past_its_deadline_ends_124():
    box = JobBox([([], [], asyncio.Event())])
    job = JobHandle(
        id=1,
        command="train",
        cwd="/",
        created_at=0.0,
        detached={"machine": str(box.id), "folder": "/f", "tag": "w:9"},
        deadline=time.time() - 1,
        timeout=5.0,
    )
    code = await resume_job(MachineTable({box.name: box}), job, (0, 0))
    chunks, _, _ = await job.console.read_from(0)
    assert code == 124
    assert b"line" in b"".join(c.data for c in chunks)
    assert box.execs[-1][0] == stop_line("w:9", 15)
    assert box.removed == ["/f"]


# A start that failed returns its own status, and whatever a wrapper that
# outlived the start's wait started is stopped by its tag, its folder gone.
@pytest.mark.asyncio
async def test_a_failed_start_returns_its_status_and_stops_its_tag():
    box = JobBox()
    box.start_code = 126
    done, _, _, runner = await _job_run(box)
    assert (done.exit_code, box.viewed) == (126, [])
    assert box.execs[-1][0] == stop_line(str(runner.record.id), 15)
    assert box.removed == [box.started[0][0]]


# Output a transport returns whole, or one a dropped connection read, is
# kept and counted, so the next viewer starts after it.
@pytest.mark.asyncio
async def test_output_returned_whole_is_kept_and_counted(no_view_wait):
    box = JobBox(
        [
            ([], [], ConnectionLostError("closed", b"a\n", b"w\n")),
            ([], [], RunResult(b"b\n", b"\0mirage-job 0\n", 0)),
        ]
    )
    done, _, _, _ = await _job_run(box, streamed=False)
    assert (done.stdout, done.stderr) == (b"a\nb\n", b"w\n")
    assert box.viewed[1][1:] == ("2", "2")


# An adopted job on a machine this workspace no longer has is lost.
@pytest.mark.asyncio
async def test_an_adopted_job_on_an_unknown_machine_is_lost():
    job = JobHandle(
        id=1,
        command="train",
        cwd="/",
        created_at=0.0,
        detached={"machine": "docker:gone", "folder": "/f", "tag": "w:9"},
    )
    assert await resume_job(MachineTable({}), job, (0, 0)) == 129
    chunks, _, _ = await job.console.read_from(0)
    assert (
        b"".join(c.data for c in chunks) == b"mirage: docker:gone: job lost\n"
    )


# A start that failed past the connection may have started what nothing
# would view: it is stopped by its tag and its folder goes.
@pytest.mark.asyncio
async def test_a_start_that_failed_stops_its_tag():
    class BrokenStart(JobBox):
        async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
            if argv[2:3] == (JOB_START,):
                self.started.append(argv[4:])
                raise RuntimeError("sdk failed")
            return await super()._exec_argv(
                argv, stdin, env, cwd, output, errors
            )

    box = BrokenStart()
    _, _, _, runner = await _job_run(box)
    assert box.execs[-1][0] == stop_line(str(runner.record.id), 15)
    assert box.removed == [box.started[0][0]]


# `$!` names a detached job's program by the pid its start printed.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "said, pid",
    [(b"4242 9000\n", MachinePid(4242, 9000.0)), (b"", None)],
)
async def test_a_detached_start_gives_the_job_its_program_pid(
    said, pid, no_view_wait
):
    box = JobBox([([], [b"\0mirage-job 0\n"], 0)])
    box.start_said = said
    done, _, _, runner = await _job_run(box)
    assert (done.exit_code, runner.record.machine_pid) == (0, pid)


# A box that cannot detach a job, with no folder of the user's own or no
# setsid, runs it attached, as it would any other run.
@pytest.mark.asyncio
async def test_a_job_the_box_cannot_detach_runs_attached():
    box = JobBox()
    box.start_code = JOB_REFUSED_STATUS
    told: list = []

    async def record(where) -> None:
        told.append(where)

    def started(runner) -> None:
        runner.on_detach = record

    done, _, _, runner = await _job_run(box, started=started)
    assert (done.exit_code, box.viewed) == (0, [])
    assert [where is None for where in told] == [False, True]
    assert box.removed == [box.started[0][0]]
    assert box.execs[-1][0] == "train"
    assert not runner.detached
    assert box.exec_envs[-1][PROCESS] == str(runner.record.id)


async def _flaky_run(box, fail, kept=False, saved=False):
    """Run ``train`` on ``box`` as a job's process whose ``fail`` sink
    raises once, keeping the chunk first when ``kept``, as a job's console
    keeps a chunk its terminal copy failed on; its process tells what the
    console holds when ``saved``: the stdout and stderr that landed."""
    landed = {"out": bytearray(), "err": bytearray()}
    failed: list[bytes] = []
    ctx = Context(cwd=PathSpec.from_str_path("/"))

    def sink(name: str):
        async def take(data: bytes) -> None:
            if name == fail and not failed:
                failed.append(data)
                if kept:
                    landed[name].extend(data)
                raise MemoryError("terminal full")
            landed[name].extend(data)

        return take

    async def console() -> tuple[int, int]:
        return len(landed["out"]), len(landed["err"])

    async def run() -> int:
        runner.detachable = True
        if saved:
            runner.saved = console
        return (
            await box.run(("train",), ctx, None, sink("out"), sink("err"))
        ).exit_code

    runner = ProcessTable("w1", bind=run_as_process).start(
        session_id="s", command="train", cwd=ctx.cwd, run=run
    )
    assert (await runner.join()).exit == 0
    return bytes(landed["out"]), bytes(landed["err"])


# The end mark counts only when all the view printed before it landed: a
# view whose stderr failed to land is viewed again, however it ended, from
# what the job's console holds, so a chunk it kept before its copy failed
# comes once and one it never kept comes again.
@pytest.mark.asyncio
@pytest.mark.parametrize("kept", [True, False])
async def test_a_mark_after_output_that_did_not_land_is_viewed_again(
    no_view_wait, kept
):
    again = [b"\0mirage-job 0\n"] if kept else [b"warn\n\0mirage-job 0\n"]
    box = JobBox([([], [b"warn\n\0mirage-job 0\n"], 0), ([], again, 0)])
    _, err = await _flaky_run(box, "err", kept=kept, saved=True)
    sent = ("0", "5") if kept else ("0", "0")
    assert [view[1:] for view in box.viewed] == [("0", "0"), sent]
    assert err == b"warn\n"


# A job's folder outlives its viewing until its ending is recorded, so a
# daemon that adopts it meanwhile still reads how it ended.
@pytest.mark.asyncio
async def test_a_job_folder_goes_once_its_ending_is_recorded():
    box = JobBox([([], [b"\0mirage-job 3\n"], 0)])
    done, _, _, runner = await _job_run(box, started=_keep_endings)
    assert (done.exit_code, box.removed) == (3, [])
    [then] = runner.after_ending
    await then()
    assert box.removed == [box.viewed[0][0]]


# A job no daemon could be told of runs attached: one no daemon could
# find must not outlive this one.
@pytest.mark.asyncio
async def test_a_job_that_could_not_be_recorded_runs_attached():
    box = JobBox()
    done, _, _, runner = await _job_run(box, started=_tell_nowhere)
    assert (done.exit_code, box.started) == (0, [])
    assert box.execs[-1][0] == "train"
    assert box.exec_envs[-1][PROCESS] == str(runner.record.id)


# A view whose stdout failed to land is viewed again from what it wrote:
# stdout may still be on its way to the console, which so cannot tell.
@pytest.mark.asyncio
async def test_a_mark_before_stdout_that_did_not_land_is_viewed_again(
    no_view_wait,
):
    view = ([], [b"\0mirage-job 0\n"], RunResult(b"x\n", None, 0))
    box = JobBox([view, view])
    out, _ = await _flaky_run(box, "out", saved=True)
    assert [v[1:] for v in box.viewed] == [("0", "0"), ("0", "0")]
    assert out == b"x\n"


# Output a daemon may not write now, its lease perhaps passing, is held and
# viewed again from where it stood, never counted as written.
@pytest.mark.asyncio
async def test_output_held_while_the_lease_may_pass_is_viewed_again(
    no_view_wait,
):
    box = JobBox(
        [([b"step 0\n"], [], 0), ([b"step 0\n"], [b"\0mirage-job 0\n"], 0)]
    )
    asked: list = []

    def may_write() -> bool:
        asked.append(True)
        return len(asked) > 1

    def started(runner) -> None:
        runner.may_write = may_write

    done, out, _, _ = await _job_run(box, started=started)
    assert (done.exit_code, out) == (0, b"step 0\n")
    assert [view[1:] for view in box.viewed] == [("0", "0"), ("0", "0")]
