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
from dataclasses import replace
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
    FIFO_NAME,
    NOT_RUNNING_STATUS,
    PROCESS,
    RUN_DRAIN_SECONDS,
    RUN_EXIT_MARK,
    RUN_PID_HOLD,
    RUN_PID_MARK,
    RUN_PROGRAM_AT,
    faketime_probe,
    fifo_line,
    is_run,
    run_exit_mark,
    run_tag,
    stop_line,
)
from mirage.machine.errors import ConnectionLostError
from mirage.machine.handle import ExitLineFilter, PidLineFilter
from mirage.machine.types import RunStatus
from mirage.runtime.binding import answer_of
from mirage.runtime.errors import UnsupportedExecutionError
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.machine import RemoteRuntime
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.types import RunAnswer, RunResult
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
            env = {**env, PROCESS: run_tag(argv)}
            argv = argv[RUN_PROGRAM_AT:]
        line = argv[2] if argv[:2] == ("/bin/sh", "-c") else shlex.join(argv)
        data = await materialize(stdin) if stdin is not None else None
        done = await self.exec_line(line, data, env, cwd)
        if done.stdout:
            await output(done.stdout)
        if done.stderr:
            await errors(done.stderr)
        return RunResult(exit_code=done.exit_code)

    async def exec_line(
        self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
    ) -> RunAnswer:
        self.execs.append((line, stdin, cwd))
        self.exec_envs.append(dict(env))
        return RunAnswer(0, b"ran:" + line.encode())


async def _line(box: MachineHandle, ctx: Context) -> RunAnswer:
    return await answer_of(
        lambda output, errors: machine_runtime(box).run_line(
            None, [], [], ctx, output, errors
        )
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
        **on(box),
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
        done = await super().exec_line(line, data, env, cwd)
        if "mkfifo" not in line:
            return done
        return replace(
            done, stdout=f"/home/u/.mirage/fd-{_named(line)}".encode()
        )

    lost = False


def _named(line: str) -> str:
    return line.rpartition(f'"$d/{FIFO_NAME}-')[2].partition('"')[0]


def _fifo(lines: list[str]) -> tuple[str, str]:
    [made] = [line for line in lines if "mkfifo" in line]
    assert made == fifo_line(_named(made), ["/data"])
    return made, f"/home/u/.mirage/fd-{_named(made)}"


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
    made, fifo = _fifo(lines)
    ran = lines.index(f"node read.js {fifo} /dev/fd/9 /dev/fd/62")
    assert lines.index("connect") < lines.index(made) < ran
    fed = [(line, data) for line, data, _ in box.execs if "exec cat" in line]
    assert fed == [(f"[ -p {fifo} ] && exec cat > {fifo}", b"hi\n")]
    assert lines.index(f"exec 3<>{fifo}; exec 3>&-; rm -f {fifo}") > ran


# A function's program reads the substitution its call was given.
@pytest.mark.asyncio
async def test_a_functions_program_reads_its_calls_substitution():
    box = FifoBox(captures=("node",))
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, **on(box))
    try:
        io = await ws.shell('f() { node read.js "$1"; }; f <(echo hi)')
        assert io.exit_code == 0
    finally:
        await ws.close()
    _, fifo = _fifo([line for line, _, _ in box.execs])
    assert f"node read.js {fifo}" in [line for line, _, _ in box.execs]


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
        **on(box),
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
        **on(box),
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
            **on(box),
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
    result = await _line(box, ctx)
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
        **on(box),
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
        await answer_of(
            lambda output, errors: runtime.execute(
                [],
                [],
                Context(flags={"c": "print(1)"}),
                output=output,
                errors=errors,
            )
        )


def test_config_dict_form_coerces():
    box = RecordingMachine(config={"env": {"A": "1"}})
    assert box.config == MachineConfig(env={"A": "1"})


@pytest.mark.asyncio
async def test_line_timeout_answers_124():
    class SlowBox(RecordingMachine):
        async def exec_line(
            self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
        ) -> RunAnswer:
            await asyncio.sleep(0.5)
            return await super().exec_line(line, stdin, env, cwd)

    box = SlowBox(captures=("python3",))
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        **on(box),
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
        ) -> RunAnswer:
            result = await super().exec_line(line, stdin, env, cwd)
            if line == "yes":
                await asyncio.Event().wait()
            return result

    box = StuckBox(captures=("yes",))
    ctx = Context(flags={"c": "yes"}, cwd=PathSpec.from_str_path("/"))
    task = asyncio.create_task(_line(box, ctx))
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
        ) -> RunAnswer:
            result = await super().exec_line(line, stdin, env, cwd)
            if line == "yes":
                await asyncio.Event().wait()
            return result

    box = StuckBox(captures=("yes",))
    ctx = Context(flags={"c": "yes"}, cwd=PathSpec.from_str_path("/"))

    async def run() -> int:
        return (await _line(box, ctx)).exit_code

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
    """Writes a step and a warning, then loses the connection under a
    program's run; a transport's own ``hint`` comes before the drop."""

    error: Exception = ConnectionLostError("closed by remote host")
    hint = b""

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        if not is_run(argv):
            return await super()._exec_argv(
                argv, stdin, env, cwd, output, errors
            )
        await output(b"step 0\n")
        await errors(b"warn\n" + self.hint)
        raise self.error


# What a run wrote before the drop reached its sinks already and stays,
# the errors beside the message.
@pytest.mark.asyncio
async def test_a_dropped_run_keeps_what_it_wrote_before_the_drop():
    box = DroppedBox(captures=("train",))
    ctx = Context(flags={"c": "train"}, cwd=PathSpec.from_str_path("/"))
    ran = await _line(box, ctx)
    assert (ran.exit_code, ran.stdout, ran.stderr) == (
        129,
        b"step 0\n",
        f"warn\nmirage: {box.machine}: connection lost\n".encode(),
    )


# A transport says its own hint before it raises; the run's message
# follows it.
@pytest.mark.asyncio
async def test_a_transports_hint_comes_before_the_runs_message():
    box = DroppedBox(captures=("train",))
    box.hint = b"recbox: closed by remote host\n"
    ctx = Context(flags={"c": "train"}, cwd=PathSpec.from_str_path("/"))
    ran = await _line(box, ctx)
    assert (ran.exit_code, ran.stdout, ran.stderr) == (
        129,
        b"step 0\n",
        (
            "warn\nrecbox: closed by remote host\n"
            f"mirage: {box.machine}: connection lost\n"
        ).encode(),
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
        return (await _line(box, ctx)).exit_code

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
        async def exec_line(self, line, stdin, env, cwd) -> RunAnswer:
            await super().exec_line(line, stdin, env, cwd)
            return RunAnswer(code)

    box = AnsweringBox(captures=("yes",))
    assert await box.stop("t1", 15) is held
    assert box.connected == 1
    assert [line for line, _, _ in box.execs] == [stop_line("t1", 15)]


@pytest.mark.asyncio
async def test_a_failed_stop_answers_false():
    class FailingBox(RecordingMachine):
        async def exec_line(self, line, stdin, env, cwd) -> RunAnswer:
            return RunAnswer(127)

    assert await FailingBox(captures=("yes",)).stop("t1", 15) is False


@pytest.mark.asyncio
async def test_a_box_that_stops_answering_holds_a_cancel_only_so_long(
    monkeypatch,
):
    class DeadBox(RecordingMachine):
        async def exec_line(
            self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
        ) -> RunAnswer:
            await super().exec_line(line, stdin, env, cwd)
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    monkeypatch.setattr(
        "mirage.machine.handle.MACHINE_STOP_WAIT_SECONDS", 0.01
    )
    box = DeadBox(captures=("yes",))
    ctx = Context(flags={"c": "yes"}, cwd=PathSpec.from_str_path("/"))
    task = asyncio.create_task(_line(box, ctx))
    while not box.execs:
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 5)
    assert len(box.execs) == 2


# An answer the transport got whole streams through the run's stdout like
# any other, so a cap that stops reading stops the run before it settles,
# 141 as SIGPIPE leaves a program.
@pytest.mark.asyncio
async def test_line_output_caps_truncate_with_notice():
    class ChattyBox(RecordingMachine):
        async def exec_line(
            self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
        ) -> RunAnswer:
            return RunAnswer(0, b"a\nb\nc\n")

    guards = {"python3": Limit(max_lines=2)}
    box = ChattyBox(captures=("python3",))
    ws = Workspace(
        {"/data": (RAMVFS(), MountMode.EXEC, guards)},
        mode=MountMode.EXEC,
        **on(box),
    )
    try:
        io = await ws.shell("python3 train.py")
        assert await materialize(io.stdout) == b"a\nb\n"
        assert io.exit_code == 141
        assert b"truncated at limit" in await materialize(io.stderr)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_remote_line_invalidates_local_read_caches():
    box = RecordingMachine(captures=("python3",))
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        **on(box),
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
    ) -> RunAnswer:
        if line != faketime_probe():
            return await super().exec_line(line, stdin, env, cwd)
        self.execs.append((line, stdin, cwd))
        self.exec_envs.append(dict(env))
        found = f"{self.holds}\n" if self.holds else ""
        return RunAnswer(0, found.encode())


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
        **on(box),
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
    ) -> RunAnswer:
        if line != faketime_probe():
            return await super().exec_line(line, stdin, env, cwd)
        self.probes += 1
        await asyncio.sleep(0.01)
        exit_code = self.answers.pop(0) if self.answers else 0
        return RunAnswer(exit_code, b"/usr/lib/faketime/libfaketime.so.1\n")


@pytest.mark.asyncio
async def test_a_machine_is_asked_once_and_again_after_a_failed_probe():
    box = CountedBox()
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        **on(box),
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
    assert seen == [RunStatus(812, 99.0)]


# stdout carries the line only at its very start; anything else passes at
# once, and a line further in is the program's own.
@pytest.mark.asyncio
async def test_stdout_gives_up_the_pid_line_only_at_its_start():
    assert await _filtered([RUN_PID_MARK + b"7 1\nout"], search=False) == (
        b"out",
        [RunStatus(7, 1.0)],
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


MARK = run_exit_mark("n1")


async def _exited(chunks: list[bytes]) -> tuple[bytes, list[int]]:
    out = bytearray()
    codes: list[int] = []

    async def keep(chunk: bytes) -> None:
        out.extend(chunk)

    line = ExitLineFilter(keep, codes.append, MARK)
    for chunk in chunks:
        await line.write(chunk)
    await line.finish()
    return bytes(out), codes


# The exit line can arrive in pieces; it comes out and its status is told,
# and what the program left running writes after it passes.
@pytest.mark.asyncio
async def test_the_exit_line_comes_out_and_gives_the_status():
    chunks = [
        b"err\n",
        MARK[:4],
        MARK[4:] + b"4",
        b"2\nlater\n",
    ]
    assert await _exited(chunks) == (b"err\nlater\n", [42])


# A mark with no status line after it is the program's own, and so is a
# piece of one the stream ends on.
@pytest.mark.asyncio
async def test_a_mark_without_a_status_line_is_the_programs_own():
    own = b"x" + MARK + b"abc\n"
    assert await _exited([own]) == (own, [])
    assert await _exited([MARK + b"1234\n"]) == (MARK + b"1234\n", [])
    assert await _exited([b"y" + MARK[:3]]) == (b"y" + MARK[:3], [])


# Only the run's own word makes a line its exit: a program that writes
# the mark itself, with another word or none, ends nothing.
@pytest.mark.asyncio
async def test_an_exit_line_without_the_runs_own_word_is_the_programs():
    forged = RUN_EXIT_MARK + b"0\n" + run_exit_mark("other") + b"0\n"
    assert await _exited([forged]) == (forged, [])


# The status is told once the output written with the line has been
# taken, so a slow reader never has the run let go mid-write.
@pytest.mark.asyncio
async def test_the_status_waits_for_the_output_written_with_it():
    taken = asyncio.Event()
    codes: list[int] = []

    async def slow(chunk: bytes) -> None:
        await taken.wait()

    line = ExitLineFilter(slow, codes.append, MARK)
    writing = asyncio.create_task(line.write(b"out\n" + MARK + b"0\n"))
    await asyncio.sleep(0)
    assert codes == []
    taken.set()
    await writing
    assert codes == [0]


class LeftOpenBox(RecordingMachine):
    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        await errors(run_exit_mark(argv[RUN_PROGRAM_AT - 2]) + b"3\n")
        await asyncio.Event().wait()


# A program that exits while what it left running holds the exec open
# ends with the status its exit line gave, without waiting for the exec.
@pytest.mark.asyncio
async def test_a_run_ends_on_its_exit_line_while_the_exec_stays_open():
    box = LeftOpenBox(captures=("train",))
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, **on(box))
    try:
        async with asyncio.timeout(5):
            io = await ws.shell("train")
        assert io.exit_code == 3
        assert await materialize(io.stderr) == b""
    finally:
        await ws.close()


class SlowStopBox(RecordingMachine):
    started = False

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        if not is_run(argv):
            return await super()._exec_argv(
                argv, stdin, env, cwd, output, errors
            )
        self.started = True
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await errors(run_exit_mark(argv[RUN_PROGRAM_AT - 2]) + b"0\n")
            await asyncio.sleep(RUN_DRAIN_SECONDS + 0.3)
            raise


# A run a kill stopped ends as stopped, even when its program says it
# exited 0 while the stop is still under way.
@pytest.mark.asyncio
async def test_a_stopped_run_ends_as_stopped_whatever_its_program_said():
    box = SlowStopBox()
    ctx = Context(flags={"c": "train"}, cwd=PathSpec.from_str_path("/"))

    async def run() -> int:
        return (await _line(box, ctx)).exit_code

    runner = ProcessTable(bind=run_as_process).start(
        session_id="s", command="train", cwd=ctx.cwd, run=run
    )
    async with asyncio.timeout(5):
        while not box.started:
            await asyncio.sleep(0.01)
        assert runner.terminate(2)
        assert (await runner.join()).exit == 130


class PidLineBox(RecordingMachine):
    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        if not is_run(argv):
            return await super()._exec_argv(
                argv, stdin, env, cwd, output, errors
            )
        if self.joins_streams:
            mark = run_exit_mark(argv[RUN_PROGRAM_AT - 2])
            await output(RUN_PID_MARK + b"812 99\nran:train" + mark + b"0\n")
            return RunResult(exit_code=0)
        await errors(RUN_PID_MARK + b"812 99\n")
        await output(RUN_PID_MARK + b"7 1\nmine\n")
        return RunResult(exit_code=0)


# The wrapper's pid line comes on stderr, so a program's own stdout that
# starts like it is left whole; an exec that hands its streams back joined
# (``joins_streams``) brings the line at the start of stdout. Either way
# the first line gives the program's pid.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("joined", "stdout"),
    [(False, RUN_PID_MARK + b"7 1\nmine\n"), (True, b"ran:train")],
)
async def test_the_pid_line_gives_the_programs_pid_once(joined, stdout):
    box = PidLineBox(captures=("train",))
    box.joins_streams = joined
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, **on(box))
    try:
        io = await ws.shell("train")
        assert await materialize(io.stdout) == stdout
        [program] = [p for p in await ws.processes() if p.program]
        assert program.machine_pid is not None
        assert program.machine_pid.pid == 812
        assert program.machine_instance == "box"
    finally:
        await ws.close()


class JoinedBox(RecordingMachine):
    """Hands a run's streams back joined, once, at its end (Daytona)."""

    joins_streams = True

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        if not is_run(argv):
            return await super()._exec_argv(
                argv, stdin, env, cwd, output, errors
            )
        mark = run_exit_mark(argv[RUN_PROGRAM_AT - 2])
        await output(RUN_PID_MARK + b"812 99\nout\nerr\n" + mark + b"3\n")
        return RunResult(exit_code=3)


# A transport whose answer joins stderr into stdout writes it once through
# the run's stdout; the wrapper's pid and exit lines come off it there,
# and the status is the program's.
@pytest.mark.asyncio
async def test_a_joined_answer_comes_without_the_runs_own_lines():
    box = JoinedBox(captures=("train",))
    ctx = Context(flags={"c": "train"}, cwd=PathSpec.from_str_path("/"))
    ran = await _line(box, ctx)
    assert ran == RunAnswer(3, b"out\nerr\n", b"")


# A transport that keeps its streams apart leaves stdout as the program
# wrote it, the wrapper's lines included.
@pytest.mark.asyncio
async def test_a_stdout_kept_apart_is_left_as_the_program_wrote_it():
    box = JoinedBox(captures=("train",))
    box.joins_streams = False
    ctx = Context(flags={"c": "train"}, cwd=PathSpec.from_str_path("/"))
    ran = await _line(box, ctx)
    assert ran.exit_code == 3
    assert ran.stdout.startswith(RUN_PID_MARK + b"812 99\nout\nerr\n")


class HungBox(RecordingMachine):
    async def connect(self) -> None:
        await asyncio.Event().wait()


@pytest.mark.asyncio
async def test_close_never_waits_for_a_hung_connect_on_a_machine_that_cannot_pause():
    box = HungBox()
    connecting = asyncio.ensure_future(box.ensure_connected())
    await asyncio.sleep(0)
    try:
        async with asyncio.timeout(1):
            await box.close()
    finally:
        connecting.cancel()


@pytest.mark.asyncio
async def test_has_program_asks_the_machine_once_per_name():
    box = RecordingMachine()
    assert await box.has_program("grep") is True
    assert await box.has_program("grep") is True
    assert [line for line, _, _ in box.execs] == [
        "command -v grep >/dev/null 2>&1"
    ]
