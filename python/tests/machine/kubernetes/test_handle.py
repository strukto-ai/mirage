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

import json

import pytest

from mirage.io.types import materialize
from mirage.machine import program
from mirage.machine.constants import wrap_line
from mirage.machine.errors import ConnectionLostError
from mirage.machine.kubernetes import KubernetesMachine
from mirage.machine.kubernetes.handle import ExitLineFilter, may_be_exit_line
from mirage.machine.registry import build_machine
from mirage.machine.types import MachinePipe
from mirage.runtime.types import OutputFn, RunResult

REPORT = b"command terminated with exit code 3\n"


class FakeKubernetesMachine(KubernetesMachine):
    def __init__(
        self, phase="Running", stderr=b"", exit_code=0, name="box", **options
    ):
        super().__init__(name, **options)
        self.phase = phase
        self.stderr = stderr
        self.exit_code = exit_code
        self.calls: list[tuple[list[str], bytes | None]] = []

    async def _exec_program(self, args, stdin=None, output=None, errors=None):
        stdin = await materialize(stdin) if stdin is not None else None
        self.calls.append((list(args), stdin))
        if args[0] == "get":
            pod = {"status": {"phase": self.phase}}
            return RunResult(json.dumps(pod).encode(), None, 0)
        if errors is not None and self.stderr:
            await errors(self.stderr)
        return RunResult(b"out", None, self.exit_code)


def collector() -> tuple[list[bytes], OutputFn]:
    chunks: list[bytes] = []

    async def collect(data: bytes) -> None:
        chunks.append(data)

    return chunks, collect


@pytest.mark.asyncio
async def test_connect_checks_the_pod_is_running():
    machine = FakeKubernetesMachine(
        config={"pod": "p", "namespace": "agents", "context": "prod"}
    )
    await machine.connect()
    assert machine.calls[0][0] == [
        "get",
        "pod",
        "--context",
        "prod",
        "--namespace",
        "agents",
        "p",
        "--output",
        "json",
    ]


@pytest.mark.asyncio
async def test_connect_fails_loud_on_a_pod_not_running():
    machine = FakeKubernetesMachine(phase="Pending", config={"pod": "p"})
    with pytest.raises(RuntimeError, match=r"pod p is not running"):
        await machine.connect()


def test_pod_is_required():
    with pytest.raises(TypeError, match="pod"):
        KubernetesMachine("box", config={})


def test_a_config_entry_builds_the_machine():
    machine = build_machine("box", {"provider": "kubernetes", "pod": "p"})
    assert isinstance(machine, KubernetesMachine)


def test_mount_type_is_one_of_ssh_fuse_both():
    with pytest.raises(
        ValueError, match="kubernetes mount_type must be one of"
    ):
        KubernetesMachine("box", config={"pod": "p", "mount_type": "nfs"})
    KubernetesMachine("box", config={"pod": "p", "mount_type": "ssh"})


@pytest.mark.asyncio
async def test_exec_line_carries_cwd_and_env_on_the_command():
    machine = FakeKubernetesMachine(
        config={
            "pod": "p",
            "namespace": "agents",
            "container": "main",
            "context": "prod",
        }
    )
    result = await machine.exec_line("wc -l", b"a\n", {"E": "1"}, "/work")
    assert (result.stdout, result.stderr, result.exit_code) == (
        b"out",
        None,
        0,
    )
    args, stdin = machine.calls[-1]
    assert args == [
        "exec",
        "--stdin",
        "--quiet",
        "--context",
        "prod",
        "--namespace",
        "agents",
        "--container",
        "main",
        "p",
        "--",
        "/bin/sh",
        "-c",
        wrap_line(("/bin/sh", "-c", "wc -l"), {"E": "1"}, "/work"),
    ]
    assert stdin == b"a\n"


@pytest.mark.asyncio
async def test_a_failing_program_says_only_what_it_said():
    machine = FakeKubernetesMachine(
        stderr=b"boom\n" + REPORT, exit_code=3, config={"pod": "p"}
    )
    result = await machine.exec_line("false", None, {}, "/")
    assert (result.stderr, result.exit_code) == (b"boom\n", 3)


@pytest.mark.asyncio
async def test_a_silent_failing_program_has_no_stderr():
    machine = FakeKubernetesMachine(
        stderr=REPORT, exit_code=3, config={"pod": "p"}
    )
    result = await machine.exec_line("false", None, {}, "/")
    assert (result.stderr, result.exit_code) == (None, 3)


@pytest.mark.asyncio
async def test_a_program_that_prints_the_report_keeps_it():
    machine = FakeKubernetesMachine(stderr=REPORT, config={"pod": "p"})
    result = await machine.exec_line("true", None, {}, "/")
    assert (result.stderr, result.exit_code) == (REPORT, 0)


@pytest.mark.asyncio
async def test_kubectl_failing_by_itself_is_a_lost_connection():
    said = b"error: lost connection to pod\n"
    machine = FakeKubernetesMachine(
        stderr=said, exit_code=1, config={"pod": "p"}
    )
    with pytest.raises(ConnectionLostError) as caught:
        await machine.exec_line("sleep 9", None, {}, "/")
    assert (caught.value.stdout, caught.value.stderr) == (b"out", said)


@pytest.mark.asyncio
async def test_a_report_for_another_status_is_kubectls_own_failure():
    machine = FakeKubernetesMachine(
        stderr=REPORT, exit_code=1, config={"pod": "p"}
    )
    with pytest.raises(ConnectionLostError):
        await machine.exec_line("x", None, {}, "/")


@pytest.mark.asyncio
async def test_a_streamed_failure_reaches_the_receiver_without_the_report():
    machine = FakeKubernetesMachine(
        stderr=b"boom\n" + REPORT, exit_code=3, config={"pod": "p"}
    )
    chunks, collect = collector()
    result = await machine._exec_argv(("false",), None, {}, "/", None, collect)
    assert (b"".join(chunks), result.exit_code) == (b"boom\n", 3)


@pytest.mark.parametrize(
    "line, held",
    [
        (b"", True),
        (b"command", True),
        (b"command terminated with exit code ", True),
        (b"command terminated with exit code 12", True),
        (b"command terminated with exit code 12\n", True),
        (b"command terminated with exit code \n", False),
        (b"command terminated with exit code 1x", False),
        (b"commands", False),
        (b"boom\n", False),
    ],
)
def test_only_what_can_become_the_report_is_held(line, held):
    assert may_be_exit_line(line) is held


@pytest.mark.asyncio
async def test_other_stderr_passes_as_it_arrives():
    chunks, collect = collector()
    said = ExitLineFilter(collect)
    await said.write(b"prompt> ")
    assert chunks == [b"prompt> "]
    await said.write(b"a\nb\n")
    assert b"".join(chunks) == b"prompt> a\nb\n"


@pytest.mark.asyncio
async def test_a_report_split_across_reads_is_still_removed():
    chunks, collect = collector()
    said = ExitLineFilter(collect)
    await said.write(b"boom\ncommand term")
    await said.write(b"inated with exit code")
    await said.write(b" 3\n")
    assert await said.finish(3) is True
    assert chunks == [b"boom\n"]


@pytest.mark.asyncio
async def test_a_line_that_only_began_like_the_report_is_released():
    chunks, collect = collector()
    said = ExitLineFilter(collect)
    await said.write(b"command")
    assert chunks == []
    await said.write(b"s failed\n")
    assert b"".join(chunks) == b"commands failed\n"
    assert await said.finish(0) is True


@pytest.mark.asyncio
async def test_a_held_line_is_released_when_kubectl_exits_zero():
    chunks, collect = collector()
    said = ExitLineFilter(collect)
    await said.write(b"command")
    assert await said.finish(0) is True
    assert chunks == [b"command"]


@pytest.mark.asyncio
async def test_a_pipe_holds_kubectl_exec_open_byte_for_byte(monkeypatch):
    spawned: list[tuple[str, ...]] = []
    spawn = program._spawn

    async def as_cat(executable, args, **kwargs):
        spawned.append((executable, *args))
        return await spawn("cat", [], **kwargs)

    monkeypatch.setattr(program, "_spawn", as_cat)
    machine = KubernetesMachine("box", config={"pod": "p"})
    pipe = await machine.open_pipe("exec sshfs x y")
    assert isinstance(pipe, MachinePipe)
    assert spawned == [
        (
            "kubectl",
            "exec",
            "--stdin",
            "--quiet",
            "p",
            "--",
            "/bin/sh",
            "-c",
            "exec sshfs x y",
        )
    ]
    payload = bytes(range(256))
    pipe.writer.write(payload)
    assert await pipe.reader.readexactly(len(payload)) == payload
    await pipe.stop()
