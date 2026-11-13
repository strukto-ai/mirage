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
from pathlib import Path
from types import SimpleNamespace

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.machine.constants import encode_output, wrap_line
from mirage.machine.daytona import DaytonaMachine, sdk
from mirage.machine.daytona.constants import stdin_redirect
from tests.fixtures.machine import on


class FakeProcess:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str | None, dict | None]] = []

    async def exec(self, command, cwd=None, env=None, timeout=None):
        self.calls.append((command, cwd, env))

        class Response:
            exit_code = 0
            result = f"out:{command}"

        return Response()


class FakeFs:
    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.folders: list[str] = []

    async def create_folder(self, path, mode):
        self.folders.append(path)

    async def upload_file(self, data, path):
        self.files[path] = data


class FakeMachine:
    id = "sb-77"

    def __init__(self, state: str) -> None:
        self.process = FakeProcess()
        self.fs = FakeFs()
        self.state = state

    async def start(self):
        FakeClient.changes.append("start")

    async def pause(self):
        FakeClient.changes.append("pause")
        if FakeClient.pause_refusal is not None:
            raise FakeClient.pause_refusal


class FakeClient:
    configs: list[object] = []
    fetched: list[str] = []
    closed = 0
    last: "FakeMachine | None" = None
    state = "started"
    changes: list[str] = []
    pause_refusal: Exception | None = None

    def __init__(self, config=None) -> None:
        FakeClient.configs.append(config)

    async def get(self, sandbox_id):
        FakeClient.fetched.append(sandbox_id)
        FakeClient.last = FakeMachine(FakeClient.state)
        return FakeClient.last

    async def close(self):
        FakeClient.closed += 1


@pytest.fixture(autouse=True)
def fake_client(monkeypatch):
    FakeClient.configs = []
    FakeClient.fetched = []
    FakeClient.closed = 0
    FakeClient.last = None
    FakeClient.state = "started"
    FakeClient.changes = []
    FakeClient.pause_refusal = None
    monkeypatch.setattr(sdk, "AsyncDaytona", FakeClient)


@pytest.mark.asyncio
async def test_connect_gets_the_users_sandbox_by_id():
    runtime = DaytonaMachine("box", config={"sandbox_id": "sb-live"})
    await runtime.connect()
    assert (FakeClient.fetched, FakeClient.changes) == (["sb-live"], [])


@pytest.mark.asyncio
async def test_connect_starts_a_paused_sandbox_again():
    FakeClient.state = "paused"
    await DaytonaMachine("box", config={"sandbox_id": "sb-live"}).connect()
    assert FakeClient.changes == ["start"]


async def _reached(**config) -> DaytonaMachine:
    machine = DaytonaMachine("box", config={"sandbox_id": "sb-live", **config})
    await machine.connect()
    await machine.close()
    return machine


@pytest.mark.asyncio
async def test_pause_pauses_the_sandbox_it_reached_through_a_client_of_its_own():
    machine = await _reached()
    await machine.pause()
    assert (FakeClient.fetched, FakeClient.changes, FakeClient.closed) == (
        ["sb-live", "sb-live"],
        ["pause"],
        2,
    )


@pytest.mark.asyncio
async def test_pause_leaves_alone_a_sandbox_it_never_reached():
    await DaytonaMachine("box", config={"sandbox_id": "sb-live"}).pause()
    assert (FakeClient.fetched, FakeClient.changes) == ([], [])


@pytest.mark.asyncio
async def test_a_sandbox_already_gone_counts_as_paused():
    machine = await _reached()
    FakeClient.pause_refusal = sdk.DaytonaNotFoundError("gone")
    await machine.pause()
    assert FakeClient.closed == 2


@pytest.mark.asyncio
async def test_any_other_pause_failure_is_raised():
    machine = await _reached()
    FakeClient.pause_refusal = RuntimeError("container sandboxes cannot pause")
    with pytest.raises(RuntimeError, match="cannot pause"):
        await machine.pause()
    assert FakeClient.closed == 2


def _asks(**config) -> bool:
    return DaytonaMachine(
        "box", config={"sandbox_id": "sb", **config}
    ).config_asks_to_pause()


def test_only_on_pause_pause_asks_the_workspace_to_pause_it():
    assert (_asks(on_pause="pause"), _asks()) == (True, False)
    with pytest.raises(ValueError, match="daytona on_pause must be one of"):
        DaytonaMachine("box", config={"sandbox_id": "sb", "on_pause": "stop"})


def test_sandbox_id_is_required():
    with pytest.raises(TypeError, match="sandbox_id"):
        DaytonaMachine("box", config={})


@pytest.mark.asyncio
async def test_api_key_reaches_the_client(monkeypatch):
    class FakeSdkConfig:
        def __init__(self, api_key=None) -> None:
            self.api_key = api_key

    monkeypatch.setattr(sdk, "DaytonaConfig", FakeSdkConfig)
    runtime = DaytonaMachine(
        "box",
        config={
            "sandbox_id": "sb-live",
            "api_key": "k-123",
        },
    )
    await runtime.connect()
    assert FakeClient.configs[0].api_key == "k-123"


@pytest.mark.asyncio
async def test_exec_line_redirects_stdin_through_a_file():
    runtime = DaytonaMachine("box", config={"sandbox_id": "sb-live"})
    await runtime.connect()
    result = await runtime.exec_line(
        "wc -l", b"a\nb\n", {"E": "1"}, "/workspace"
    )
    assert result.exit_code == 0
    assert result.stderr is None
    sandbox = FakeClient.last
    [path] = sandbox.fs.files
    # Unique per invocation, so concurrent stdin lines never collide.
    assert path.startswith("/tmp/.mirage_stdin_")
    assert sandbox.fs.files[path] == b"a\nb\n"
    command, cwd, env = sandbox.process.calls[0]
    wrapped = wrap_line(("/bin/sh", "-c", "wc -l"), {"E": "1"}, "/workspace")
    assert command == stdin_redirect(
        encode_output(wrapped, combined=True), path
    )
    assert f"rm -f {path}" in command
    assert (cwd, env) == (None, None)


@pytest.mark.asyncio
async def test_close_releases_the_client_never_the_sandbox():
    runtime = DaytonaMachine("box", config={"sandbox_id": "sb-live"})
    await runtime.connect()
    await runtime.close()
    # The fake exposes no delete at all: close only drops the client.
    assert FakeClient.closed == 1


@pytest.mark.asyncio
async def test_missing_sdk_fails_with_install_hint(monkeypatch):
    monkeypatch.setattr(sdk, "AsyncDaytona", None)
    runtime = DaytonaMachine("box", config={"sandbox_id": "sb-live"})
    with pytest.raises(ImportError, match="mirage-ai\\[daytona\\]"):
        await runtime.connect()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "profile",
    [
        {"paths": {"hide": ["/data/secret"]}},
        {"commands": {"deny": [{"paths": ["/data/secret"], "reason": "x"}]}},
        {"mounts": {"/data": "r"}},
    ],
)
async def test_a_session_restriction_refuses_every_line(profile):
    runtime = DaytonaMachine("box", config={"sandbox_id": "sb-77"})
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"agent": profile},
        **on(runtime, "workspace"),
    )
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("tool run")
    assert (result.exit_code, result.stdout, result.stderr) == (
        126,
        b"",
        b"daytona: Permission denied\n",
    )
    assert FakeClient.fetched == []
    assert (await (await ws.session("other")).shell("tool run")).exit_code == 0
    await ws.close()


class ShellProcess:
    """Daytona's exec over a local sh: stdout and stderr combined, decoded
    as its JSON result carries them (UTF-8, errors replaced)."""

    async def exec(self, command, cwd=None, env=None, timeout=None):
        process = await asyncio.create_subprocess_exec(
            "/bin/sh",
            "-c",
            command,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await process.communicate()
        return SimpleNamespace(
            result=out.decode("utf-8", "replace"), exit_code=process.returncode
        )


class LocalFs(FakeFs):
    async def upload_file(self, data, path):
        await super().upload_file(data, path)
        Path(path).write_bytes(data)


# Program output is bytes: invalid UTF-8, NUL and CRLF reach the host
# unchanged, stderr in the one combined stream, with the program's status,
# with or without piped input.
@pytest.mark.asyncio
@pytest.mark.parametrize("stdin", [None, b"in\xff\x00"])
async def test_arbitrary_output_bytes_and_the_exit_code_come_back_exactly(
    stdin,
):
    runtime = DaytonaMachine("box", config={"sandbox_id": "sb-live"})
    await runtime.connect()
    FakeClient.last.process = ShellProcess()
    FakeClient.last.fs = LocalFs()
    line = "printf 'a\\377\\000b\\r\\n\\303'; printf 'e\\376\\000\\r\\n' >&2; "
    line += "cat; exit 5" if stdin is not None else "exit 5"
    result = await runtime.exec_line(line, stdin, {}, "/")
    assert (result.exit_code, result.stdout, result.stderr) == (
        5,
        b"a\xff\x00b\r\n\xc3e\xfe\x00\r\n" + (stdin or b""),
        None,
    )
