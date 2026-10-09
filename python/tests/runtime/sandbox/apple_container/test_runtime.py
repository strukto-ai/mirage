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
import subprocess

import pytest

from mirage import MountMode, Workspace
from mirage.runtime.sandbox.apple_container import AppleContainerRuntime
from mirage.runtime.sandbox.apple_container.constants import PRELUDE
from mirage.runtime.table import build_runtime
from mirage.runtime.types import ProcessExecution, ShellRequest
from mirage.types import PathSpec
from mirage.vfs.ram import RAMVFS


class FakeAppleContainerRuntime(AppleContainerRuntime):
    def __init__(
        self,
        states: dict[str, str] | None = None,
        inspect_code: int = 0,
        inspect_stdout: bytes | None = None,
        **options,
    ):
        super().__init__(**options)
        self.states = states or {}
        self.inspect_code = inspect_code
        self.inspect_stdout = inspect_stdout
        self.calls: list[tuple[list[str], bytes | None]] = []

    async def _container(self, args, stdin=None):
        self.calls.append((list(args), stdin))
        if args[0] == "inspect":
            if self.inspect_stdout is not None:
                return self.inspect_stdout, b"", self.inspect_code
            if self.inspect_code != 0:
                return (
                    b"",
                    f"Error: container not found: {args[1]}".encode(),
                    self.inspect_code,
                )
            return (
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
        return f"out:{script}".encode(), b"warn", 0

    def inspected(self) -> list[str]:
        return [args[1] for args, _ in self.calls if args[0] == "inspect"]

    def exec_targets(self) -> list[str]:
        return [
            args[args.index("sh") - 1]
            for args, _ in self.calls
            if args[0] == "exec"
        ]


def prelude(cwd: str, *argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["/bin/sh", "-c", PRELUDE, "sh", cwd, *argv],
        capture_output=True,
        check=False,
    )


@pytest.mark.asyncio
async def test_the_first_line_inspects_its_container():
    runtime = FakeAppleContainerRuntime(config={"container": "box"})
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
    runtime = FakeAppleContainerRuntime(
        states={"box": state}, config={"container": "box"}
    )
    with pytest.raises(RuntimeError, match=hint):
        await runtime.exec_line("pwd", None, {}, "/")
    assert runtime.exec_targets() == []


@pytest.mark.asyncio
async def test_an_inspect_error_fails_loud():
    runtime = FakeAppleContainerRuntime(
        inspect_code=1, config={"container": "box"}
    )
    with pytest.raises(RuntimeError, match="container not found: box"):
        await runtime.exec_line("pwd", None, {}, "/")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stdout", [b"not json", b"[]", b"{}", b'[{"status": null}]']
)
async def test_unreadable_inspect_json_fails_loud(stdout):
    runtime = FakeAppleContainerRuntime(
        inspect_stdout=stdout, config={"container": "box"}
    )
    with pytest.raises(RuntimeError, match="unreadable json"):
        await runtime.exec_line("pwd", None, {}, "/")


def test_config_needs_a_container():
    with pytest.raises(ValueError, match="container or containers"):
        AppleContainerRuntime(config={})


@pytest.mark.parametrize(
    ("config", "named"),
    [
        ({"container": ""}, "container must be a nonblank id"),
        ({"containers": {"agent_a": ""}}, "nonblank id: agent_a"),
        (
            {"container": "shared", "containers": {"b": " ", "a": "box"}},
            "nonblank id: b",
        ),
    ],
)
def test_config_refuses_a_blank_container_id(config, named):
    with pytest.raises(ValueError, match=named):
        AppleContainerRuntime(config=config)


def test_registers_under_the_config_name():
    runtime = build_runtime("apple_container", config={"container": "box"})
    assert isinstance(runtime, AppleContainerRuntime)
    assert runtime.captures == ("@external",)
    assert runtime.reach == "remote"


@pytest.mark.asyncio
async def test_exec_line_runs_under_the_prelude_with_stdin_and_stderr():
    runtime = FakeAppleContainerRuntime(config={"container": "box"})
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
        "sh",
        "-c",
        PRELUDE,
        "sh",
        "/root/workspace",
        "sh",
        "-c",
        "wc -l",
    ]
    assert stdin == b"a\nb\n"


@pytest.mark.asyncio
async def test_process_preserves_argv_and_probes_the_container_once():
    runtime = FakeAppleContainerRuntime(
        config={"container": "box", "env": {"E": "config"}}
    )
    argv = ("node", "a b", "$(echo literal)", "", "--flag")
    result = await runtime.execute(
        ProcessExecution(
            argv=argv,
            cwd=PathSpec.from_str_path("/work"),
            env={"E": "request"},
            stdin=b"input",
        )
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
            "sh",
            "-c",
            PRELUDE,
            "sh",
            "/work",
            *argv,
        ],
        b"input",
    )
    await runtime.execute(
        ShellRequest(line="pwd", cwd=PathSpec.from_str_path("/work"))
    )
    assert runtime.inspected() == ["box"]
    assert runtime.capabilities.process and runtime.capabilities.shell
    assert runtime.capabilities.filesystem == ()


@pytest.mark.asyncio
async def test_process_refuses_empty_argv_and_a_stopped_container():
    runtime = FakeAppleContainerRuntime(
        states={"box": "stopped"}, config={"container": "box"}
    )
    with pytest.raises(ValueError, match="argv must not be empty"):
        await runtime.execute(
            ProcessExecution(argv=(), cwd=PathSpec.from_str_path("/"))
        )
    assert not runtime.calls
    with pytest.raises(RuntimeError, match="not running"):
        await runtime.execute(
            ProcessExecution(argv=("node",), cwd=PathSpec.from_str_path("/"))
        )
    assert len(runtime.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "session_id", ["agent_a", "constructor", "toString", "__proto__"]
)
async def test_each_session_runs_in_its_own_container(session_id):
    runtime = FakeAppleContainerRuntime(
        captures=["uname"],
        config={
            "container": "shared",
            "containers": {session_id: "box-a", "agent_b": "box-b"},
        },
    )
    ws = Workspace(
        {"/d": RAMVFS()}, mode=MountMode.EXEC, runtimes=[runtime, "workspace"]
    )
    for mapped_id in (session_id, "agent_b", session_id):
        handle = await ws.session(mapped_id)
        assert (await handle.shell("uname")).exit_code == 0
    assert (await ws.shell("uname")).exit_code == 0
    assert runtime.exec_targets() == ["box-a", "box-b", "box-a", "shared"]
    assert runtime.inspected() == ["box-a", "box-b", "shared"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "session_id", ["agent_b", "constructor", "toString", "__proto__"]
)
async def test_unmapped_session_uses_fallback(session_id):
    runtime = FakeAppleContainerRuntime(
        captures=["uname"],
        config={"container": "shared", "containers": {"agent_a": "box-a"}},
    )
    ws = Workspace(
        {"/d": RAMVFS()}, mode=MountMode.EXEC, runtimes=[runtime, "workspace"]
    )
    handle = await ws.session(session_id)
    assert (await handle.shell("uname")).exit_code == 0
    assert runtime.exec_targets() == ["shared"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "session_id", ["agent_b", "constructor", "toString", "__proto__"]
)
async def test_a_session_with_no_container_fails_loud(session_id):
    runtime = FakeAppleContainerRuntime(
        captures=["uname"], config={"containers": {"agent_a": "box-a"}}
    )
    ws = Workspace(
        {"/d": RAMVFS()}, mode=MountMode.EXEC, runtimes=[runtime, "workspace"]
    )
    handle = await ws.session(session_id)
    result = await handle.shell("uname")
    assert result.exit_code == 1
    stderr = await result.stderr_str()
    assert f"no container for session {session_id}" in stderr
    assert not runtime.calls


@pytest.mark.asyncio
async def test_a_missing_cli_names_how_to_install_it(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path))
    runtime = AppleContainerRuntime(config={"container": "box"})
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
