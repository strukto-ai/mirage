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
import os
import subprocess
from types import SimpleNamespace

import pytest

from mirage import MountMode, Policy, Workspace
from mirage.commands.config import Context
from mirage.io.types import materialize
from mirage.machine.apple_container import AppleContainerMachine
from mirage.machine.constants import (
    EXEC_PRELUDE,
    run_argv,
    run_status_path,
)
from mirage.machine.registry import build_machine
from mirage.policy import Route
from mirage.runtime.machine import MachineRuntime
from mirage.runtime.mixin import LineExecutorMixin, ProcessExecutorMixin
from mirage.runtime.types import RunResult
from mirage.types import PathSpec
from mirage.vfs.ram import RAMVFS
from tests.fixtures.machine import machine_runtime


class FakeAppleContainerMachine(AppleContainerMachine):
    def __init__(
        self,
        states: dict[str, str] | None = None,
        inspect_code: int = 0,
        inspect_stdout: bytes | None = None,
        captures=None,
        name="box",
        **options,
    ):
        super().__init__(name, **options)
        self.captures = captures
        self.states = states or {}
        self.inspect_code = inspect_code
        self.inspect_stdout = inspect_stdout
        self.calls: list[tuple[list[str], bytes | None]] = []

    async def _exec_program(self, args, stdin=None, output=None, errors=None):
        stdin = await materialize(stdin) if stdin is not None else None
        self.calls.append((list(args), stdin))
        if args[0] == "inspect":
            if self.inspect_stdout is not None:
                return RunResult(self.inspect_stdout, b"", self.inspect_code)
            if self.inspect_code != 0:
                return RunResult(
                    b"",
                    f"Error: container not found: {args[1]}".encode(),
                    self.inspect_code,
                )
            return RunResult(
                json.dumps(
                    [
                        {
                            "id": args[1],
                            "configuration": {},
                            "status": {
                                "state": self.states.get(args[1], "running")
                            },
                        }
                    ]
                ).encode(),
                b"",
                0,
            )
        script = args[-1]
        if output is not None:
            await output(f"out:{script}".encode())
            return RunResult(b"", b"warn", 0)
        return RunResult(f"out:{script}".encode(), b"warn", 0)

    def inspected(self) -> list[str]:
        return [args[1] for args, _ in self.calls if args[0] == "inspect"]

    def exec_targets(self) -> list[str]:
        return [
            args[args.index("/bin/sh") - 1]
            for args, _ in self.calls
            if args[0] == "exec"
        ]


def prelude(cwd: str, *argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["/bin/sh", "-c", EXEC_PRELUDE, "sh", cwd, *argv],
        capture_output=True,
        check=False,
    )


def test_the_prelude_resolves_a_relative_cwd_without_cdpath(tmp_path):
    for root in ("start", "elsewhere"):
        (tmp_path / root / "sub").mkdir(parents=True)
    done = subprocess.run(
        ["/bin/sh", "-c", EXEC_PRELUDE, "sh", "sub"]
        + ["sh", "-c", 'pwd -P; printf "%s\\n" "$CDPATH"'],
        capture_output=True,
        check=False,
        cwd=tmp_path / "start",
        env={**os.environ, "CDPATH": str(tmp_path / "elsewhere")},
    )
    assert done.returncode == 0, done.stderr
    assert done.stdout.decode().splitlines() == [
        os.path.realpath(tmp_path / "start" / "sub"),
        str(tmp_path / "elsewhere"),
    ]


@pytest.mark.asyncio
async def test_connect_inspects_its_container():
    runtime = FakeAppleContainerMachine(config={"container": "box"})
    await runtime.connect()
    await runtime.exec_line("pwd", None, {}, "/")
    assert runtime.calls[0][0] == ["inspect", "box"]
    assert runtime.exec_targets() == ["box"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("state", "hint"),
    [
        ("stopped", "start it with `container start box`"),
        ("stopping", "shutting down"),
        ("unknown", r"state: unknown"),
    ],
)
async def test_a_state_that_cannot_take_a_line_is_named(state, hint):
    runtime = FakeAppleContainerMachine(
        states={"box": state}, config={"container": "box"}
    )
    with pytest.raises(RuntimeError, match=hint):
        await runtime.connect()
    assert runtime.exec_targets() == []


@pytest.mark.asyncio
async def test_an_inspect_error_fails_loud():
    runtime = FakeAppleContainerMachine(
        inspect_code=1, config={"container": "box"}
    )
    with pytest.raises(RuntimeError, match="container not found: box"):
        await runtime.connect()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stdout", [b"not json", b"[]", b"{}", b'[{"status": null}]']
)
async def test_unreadable_inspect_json_fails_loud(stdout):
    runtime = FakeAppleContainerMachine(
        inspect_stdout=stdout, config={"container": "box"}
    )
    with pytest.raises(RuntimeError, match="unreadable json"):
        await runtime.connect()


def test_config_needs_a_container():
    with pytest.raises(TypeError, match="container"):
        AppleContainerMachine("box", config={})
    with pytest.raises(ValueError, match="needs a nonblank container"):
        AppleContainerMachine("box", config={"container": " "})
    with pytest.raises(TypeError, match="containers"):
        AppleContainerMachine(
            "box", config={"container": "box", "containers": {"a": "box"}}
        )


def test_registers_under_the_config_name():
    machine = build_machine(
        "box", {"provider": "apple_container", "container": "box"}
    )
    assert isinstance(machine, AppleContainerMachine)
    assert str(machine.id) == "apple_container:box"


@pytest.mark.asyncio
async def test_exec_line_runs_under_the_prelude_with_stdin_and_stderr():
    runtime = FakeAppleContainerMachine(config={"container": "box"})
    result = await runtime.exec_line(
        "wc -l", b"a\nb\n", {"E": "1"}, "/root/workspace"
    )
    assert result.exit_code == 0
    assert result.stdout == b"out:wc -l"
    assert result.stderr == b"warn"
    args, stdin = runtime.calls[-1]
    assert args == [
        "exec",
        "-i",
        "-w",
        "/",
        "-e",
        "E=1",
        "box",
        "/bin/sh",
        "-c",
        EXEC_PRELUDE,
        "sh",
        "/root/workspace",
        "/bin/sh",
        "-c",
        "wc -l",
    ]
    assert stdin == b"a\nb\n"


@pytest.mark.asyncio
async def test_process_preserves_argv_and_probes_the_container_once(
    monkeypatch,
):
    monkeypatch.setattr(
        "mirage.machine.handle.uuid.uuid4",
        lambda: SimpleNamespace(hex="run"),
    )
    runtime = FakeAppleContainerMachine(
        config={"container": "box", "env": {"E": "config"}}
    )
    argv = ("node", "a b", "$(echo literal)", "", "--flag")
    work = PathSpec.from_str_path("/work")
    ctx = Context(cwd=work, env={"E": "request"}, stdin=b"input")
    result = await machine_runtime(runtime).execute(
        [], list(argv), ctx, kind="process"
    )
    assert result.stdout == b"out:--flag"
    assert result.stderr == b"warn"
    assert runtime.calls[-1] == (
        [
            "exec",
            "-i",
            "-w",
            "/",
            "-e",
            "E=request",
            "box",
            "/bin/sh",
            "-c",
            EXEC_PRELUDE,
            "sh",
            "/work",
            *run_argv("run", run_status_path("run"), (), argv),
        ],
        b"input",
    )
    line = Context(flags={"c": "pwd"}, cwd=work)
    await machine_runtime(runtime).execute([], [], line, kind="line")
    assert runtime.inspected() == ["box"]
    assert isinstance(machine_runtime(runtime), ProcessExecutorMixin)
    assert isinstance(machine_runtime(runtime), LineExecutorMixin)
    assert machine_runtime(runtime).filesystem == ()


@pytest.mark.asyncio
async def test_process_refuses_empty_argv_and_a_stopped_container():
    runtime = FakeAppleContainerMachine(
        states={"box": "stopped"}, config={"container": "box"}
    )
    with pytest.raises(ValueError, match="argv must not be empty"):
        await machine_runtime(runtime).execute(
            [], [], Context(), kind="process"
        )
    assert not runtime.calls
    with pytest.raises(RuntimeError, match="not running"):
        await machine_runtime(runtime).execute(
            [], ["node"], Context(), kind="process"
        )
    assert len(runtime.calls) == 1


class _OwnBox(Policy):
    def pre_execute(self, ctx):
        return Route(machine=ctx.session_id)


@pytest.mark.asyncio
async def test_a_route_gives_each_session_a_container_of_its_own():
    boxes = {
        name: FakeAppleContainerMachine(
            name=name, config={"container": f"box-{name}"}
        )
        for name in ("agent_a", "agent_b")
    }
    ws = Workspace(
        {"/d": RAMVFS()},
        mode=MountMode.EXEC,
        machines=boxes,
        runtimes=[MachineRuntime(["uname"]), "workspace"],
        policies=[_OwnBox()],
    )
    try:
        for session_id in ("agent_a", "agent_b", "agent_a"):
            handle = await ws.session(session_id)
            assert (await handle.shell("uname")).exit_code == 0
    finally:
        await ws.close()
    assert boxes["agent_a"].exec_targets() == ["box-agent_a"] * 3
    assert boxes["agent_b"].exec_targets() == ["box-agent_b"] * 2
    assert boxes["agent_a"].inspected() == ["box-agent_a"]


@pytest.mark.asyncio
async def test_a_missing_cli_names_how_to_install_it(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path))
    runtime = AppleContainerMachine("box", config={"container": "box"})
    with pytest.raises(RuntimeError, match="brew install container"):
        await runtime.exec_line("pwd", None, {}, "/")


def test_prelude_enters_the_cwd_and_hands_over_argv_unchanged(tmp_path):
    done = prelude(
        str(tmp_path),
        "sh",
        "-c",
        'pwd; printf "[%s]\\n" "$@"',
        "sh",
        "a b",
        "$(echo literal)",
        "",
        "--flag",
    )
    assert done.returncode == 0
    assert done.stdout.decode().splitlines() == [
        str(tmp_path),
        "[a b]",
        "[$(echo literal)]",
        "[]",
        "[--flag]",
    ]


def test_prelude_fails_loud_on_a_missing_cwd_and_creates_nothing(tmp_path):
    missing = tmp_path / "unserved"
    done = prelude(str(missing), "pwd")
    assert done.returncode != 0
    assert done.stdout == b""
    assert str(missing) in done.stderr.decode()
    assert not missing.exists()


def test_prelude_keeps_the_exit_code():
    assert prelude("/", "sh", "-c", "exit 7").returncode == 7
