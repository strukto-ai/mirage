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

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.runtime.sandbox.constants import wrap_line
from mirage.runtime.sandbox.daytona import DaytonaRuntime, sdk
from mirage.runtime.sandbox.daytona.constants import stdin_redirect


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


class FakeSandbox:
    id = "sb-77"

    def __init__(self) -> None:
        self.process = FakeProcess()
        self.fs = FakeFs()


class FakeClient:
    configs: list[object] = []
    fetched: list[str] = []
    closed = 0
    last: "FakeSandbox | None" = None

    def __init__(self, config=None) -> None:
        FakeClient.configs.append(config)

    async def get(self, sandbox_id):
        FakeClient.fetched.append(sandbox_id)
        FakeClient.last = FakeSandbox()
        return FakeClient.last

    async def close(self):
        FakeClient.closed += 1


@pytest.fixture(autouse=True)
def fake_client(monkeypatch):
    FakeClient.configs = []
    FakeClient.fetched = []
    FakeClient.closed = 0
    FakeClient.last = None
    monkeypatch.setattr(sdk, "AsyncDaytona", FakeClient)


@pytest.mark.asyncio
async def test_connect_gets_the_users_sandbox_by_id():
    runtime = DaytonaRuntime(config={"sandbox_id": "sb-live"})
    await runtime.connect()
    assert FakeClient.fetched == ["sb-live"]


def test_sandbox_id_is_required():
    with pytest.raises(TypeError, match="sandbox_id"):
        DaytonaRuntime(config={})


@pytest.mark.asyncio
async def test_api_key_reaches_the_client(monkeypatch):
    class FakeSdkConfig:
        def __init__(self, api_key=None) -> None:
            self.api_key = api_key

    monkeypatch.setattr(sdk, "DaytonaConfig", FakeSdkConfig)
    runtime = DaytonaRuntime(
        config={
            "sandbox_id": "sb-live",
            "api_key": "k-123",
        }
    )
    await runtime.connect()
    assert FakeClient.configs[0].api_key == "k-123"


@pytest.mark.asyncio
async def test_exec_line_redirects_stdin_through_a_file():
    runtime = DaytonaRuntime(config={"sandbox_id": "sb-live"})
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
    wrapped = wrap_line("wc -l", {"E": "1"}, "/workspace")
    assert command == stdin_redirect(wrapped, path)
    assert f"rm -f {path}" in command
    assert (cwd, env) == (None, None)


@pytest.mark.asyncio
async def test_close_releases_the_client_never_the_sandbox():
    runtime = DaytonaRuntime(config={"sandbox_id": "sb-live"})
    await runtime.connect()
    await runtime.close()
    # The fake exposes no delete at all: close only drops the client.
    assert FakeClient.closed == 1


@pytest.mark.asyncio
async def test_missing_sdk_fails_with_install_hint(monkeypatch):
    monkeypatch.setattr(sdk, "AsyncDaytona", None)
    runtime = DaytonaRuntime(config={"sandbox_id": "sb-live"})
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
    runtime = DaytonaRuntime(config={"sandbox_id": "sb-77"})
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"agent": profile},
        runtimes=[runtime, "workspace"],
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
