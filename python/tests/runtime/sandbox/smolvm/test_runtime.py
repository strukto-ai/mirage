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

from mirage.runtime.sandbox.smolvm import SmolvmRuntime
from mirage.runtime.types import ProcessExecution, ShellExecution
from mirage.types import PathSpec


class FakeSmolvmRuntime(SmolvmRuntime):

    def __init__(self,
                 state: str = "running",
                 status_code: int = 0,
                 status_stdout: bytes | None = None,
                 **options):
        super().__init__(**options)
        self.state = state
        self.status_code = status_code
        self.status_stdout = status_stdout
        self.calls: list[tuple[list[str], bytes | None]] = []

    async def _smolvm(self, args, stdin=None):
        self.calls.append((list(args), stdin))
        if args[1] == "status":
            if self.status_stdout is not None:
                return self.status_stdout, b"", self.status_code
            if self.status_code != 0:
                return b"", b"machine 'vm' not found", self.status_code
            return json.dumps({
                "name": "vm",
                "state": self.state
            }).encode(), b"", 0
        script = args[-1]
        return f"out:{script}".encode(), b"warn", 0


@pytest.mark.asyncio
async def test_connect_probes_the_users_machine_state():
    runtime = FakeSmolvmRuntime(config={"machine": "vm"})
    await runtime.connect()
    args, _ = runtime.calls[0]
    assert args == ["machine", "status", "--name", "vm", "--json"]


@pytest.mark.asyncio
async def test_connect_fails_loud_on_a_stopped_machine():
    runtime = FakeSmolvmRuntime(state="stopped", config={"machine": "vm"})
    with pytest.raises(RuntimeError, match="not running"):
        await runtime.connect()


@pytest.mark.asyncio
@pytest.mark.parametrize(("state", "hint"), [
    ("unreachable", "guest agent is not answering"),
    ("frozen", "frozen fork base"),
    ("created", "never been started"),
])
async def test_connect_names_why_a_state_cannot_take_a_line(state, hint):
    runtime = FakeSmolvmRuntime(state=state, config={"machine": "vm"})
    with pytest.raises(RuntimeError, match=hint):
        await runtime.connect()


@pytest.mark.asyncio
async def test_connect_reports_an_unknown_state_verbatim():
    runtime = FakeSmolvmRuntime(state="quiesced", config={"machine": "vm"})
    with pytest.raises(RuntimeError, match=r"state: quiesced"):
        await runtime.connect()


@pytest.mark.asyncio
async def test_connect_fails_loud_when_the_cli_errors():
    runtime = FakeSmolvmRuntime(status_code=1, config={"machine": "vm"})
    with pytest.raises(RuntimeError, match="machine 'vm' not found"):
        await runtime.connect()


@pytest.mark.asyncio
async def test_connect_fails_loud_on_unreadable_json():
    runtime = FakeSmolvmRuntime(status_stdout=b"not json",
                                config={"machine": "vm"})
    with pytest.raises(RuntimeError, match="unreadable json"):
        await runtime.connect()


def test_machine_is_required():
    with pytest.raises(TypeError, match="machine"):
        SmolvmRuntime(config={})


@pytest.mark.asyncio
async def test_exec_line_threads_cwd_env_stdin_and_real_stderr():
    runtime = FakeSmolvmRuntime(config={"machine": "vm"})
    result = await runtime.exec_line("wc -l", b"a\nb\n", {"E": "1"},
                                     "/root/workspace")
    assert result.exit_code == 0
    assert result.stdout == b"out:wc -l"
    assert result.stderr == b"warn"
    args, stdin = runtime.calls[-1]
    assert args == [
        "machine", "exec", "--name", "vm", "-i", "-w", "/root/workspace", "-e",
        "E=1", "--", "sh", "-c", "wc -l"
    ]
    assert stdin == b"a\nb\n"


@pytest.mark.asyncio
async def test_exec_line_ends_flags_so_a_dashed_line_is_not_parsed():
    runtime = FakeSmolvmRuntime(config={"machine": "vm"})
    await runtime.exec_line("--version", None, {}, "/")
    args, _ = runtime.calls[-1]
    assert args[-3:] == ["sh", "-c", "--version"]
    assert args[-4] == "--"


@pytest.mark.asyncio
async def test_process_preserves_argv_and_shares_the_shell_connection():
    runtime = FakeSmolvmRuntime(config={
        "machine": "vm",
        "env": {
            "E": "config"
        }
    })
    argv = ("node", "a b", "$(echo literal)", "", "--flag")
    result = await runtime.execute(
        ProcessExecution(argv=argv,
                         cwd=PathSpec.from_str_path("/work"),
                         env={"E": "request"},
                         stdin=b"input"))
    assert result.stdout == b"out:--flag"
    assert result.stderr == b"warn"
    assert runtime.calls[-1] == ([
        "machine", "exec", "--name", "vm", "-i", "-w", "/work", "-e",
        "E=request", "--", *argv
    ], b"input")
    await runtime.execute(
        ShellExecution(line="pwd", cwd=PathSpec.from_str_path("/work")))
    assert sum(args[1] == "status" for args, _ in runtime.calls) == 1
    assert runtime.capabilities.process and runtime.capabilities.shell
    assert runtime.capabilities.filesystem == ()


@pytest.mark.asyncio
async def test_process_refuses_a_stopped_vm_and_empty_argv():
    runtime = FakeSmolvmRuntime(state="stopped", config={"machine": "vm"})
    with pytest.raises(ValueError, match="argv must not be empty"):
        await runtime.execute(
            ProcessExecution(argv=(), cwd=PathSpec.from_str_path("/")))
    assert not runtime.calls
    with pytest.raises(RuntimeError, match="not running"):
        await runtime.execute(
            ProcessExecution(argv=("node", ), cwd=PathSpec.from_str_path("/")))
    assert len(runtime.calls) == 1
