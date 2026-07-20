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
from e2b import CommandExitException

from mirage.runtime.sandbox import E2BRuntime, SandboxResources
from mirage.runtime.sandbox import e2b as e2b_mod


class FakeResult:

    def __init__(self, stdout: str, stderr: str = "", exit_code: int = 0):
        self.stdout = stdout
        self.stderr = stderr
        self.exit_code = exit_code


class FakeCommands:

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict | None, str | None]] = []

    async def run(self, command, envs=None, cwd=None):
        self.calls.append((command, envs, cwd))
        if "$HOME" in command:
            return FakeResult("/home/user")
        if "exit 3" in command:
            raise CommandExitException(stderr="boom-err",
                                       stdout="partial",
                                       exit_code=3,
                                       error=None)
        return FakeResult(f"out:{command}", stderr="warn")


class FakeFiles:

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.dirs: list[str] = []

    async def make_dir(self, path):
        self.dirs.append(path)
        return True

    async def write(self, path, data):
        self.files[path] = data

    async def read(self, path, format="text"):
        assert format == "bytes"
        return self.files.get(path, b"")


class FakeSandbox:
    created: list[dict] = []
    connected: list[tuple[str, dict]] = []
    killed = 0
    last: "FakeSandbox | None" = None

    def __init__(self) -> None:
        self.sandbox_id = "sb-e2b"
        self.commands = FakeCommands()
        self.files = FakeFiles()

    @classmethod
    async def create(cls, **params):
        cls.created.append(params)
        cls.last = cls()
        return cls.last

    @classmethod
    async def connect(cls, sandbox_id, **params):
        cls.connected.append((sandbox_id, params))
        cls.last = cls()
        return cls.last

    async def kill(self):
        FakeSandbox.killed += 1
        return True


@pytest.fixture(autouse=True)
def fake_sdk(monkeypatch):
    FakeSandbox.created = []
    FakeSandbox.connected = []
    FakeSandbox.killed = 0
    FakeSandbox.last = None
    monkeypatch.setattr(e2b_mod, "AsyncSandbox", FakeSandbox)


@pytest.mark.asyncio
async def test_create_maps_template_env_and_api_key():
    runtime = E2BRuntime(template="mirage-base",
                         env={"A": "1"},
                         api_key="k-123")
    sandbox_id = await runtime.create_sandbox()
    assert sandbox_id == "sb-e2b"
    params = FakeSandbox.created[0]
    assert params == {
        "api_key": "k-123",
        "template": "mirage-base",
        "envs": {
            "A": "1"
        },
    }


@pytest.mark.asyncio
async def test_sandbox_params_merge_last_over_named_options():
    runtime = E2BRuntime(template="mirage-base",
                         sandbox_params={
                             "template": "override",
                             "timeout": 600
                         })
    await runtime.create_sandbox()
    params = FakeSandbox.created[0]
    assert params["template"] == "override"
    assert params["timeout"] == 600


def test_image_fails_loud():
    with pytest.raises(ValueError, match="template"):
        E2BRuntime(image="python:3.12")


def test_resources_fail_loud():
    with pytest.raises(ValueError, match="template"):
        E2BRuntime(resources=SandboxResources(cpu=2))


@pytest.mark.asyncio
async def test_exec_line_threads_env_cwd_and_real_stderr():
    runtime = E2BRuntime()
    await runtime.create_sandbox()
    result = await runtime.exec_line("wc -l", None, {"E": "1"}, "/workspace")
    assert result.exit_code == 0
    assert result.stdout == b"out:wc -l"
    assert result.stderr == b"warn"
    sandbox = FakeSandbox.last
    assert sandbox.commands.calls[0] == ("wc -l", {"E": "1"}, "/workspace")


@pytest.mark.asyncio
async def test_exec_line_nonzero_exit_comes_back_as_result():
    runtime = E2BRuntime()
    await runtime.create_sandbox()
    result = await runtime.exec_line("exit 3", None, {}, "/workspace")
    assert result.exit_code == 3
    assert result.stdout == b"partial"
    assert result.stderr == b"boom-err"


@pytest.mark.asyncio
async def test_stdin_redirects_through_an_uploaded_file():
    runtime = E2BRuntime()
    await runtime.create_sandbox()
    result = await runtime.exec_line("wc -l", b"a\nb\n", {}, "/workspace")
    assert result.exit_code == 0
    sandbox = FakeSandbox.last
    assert sandbox.files.files["/tmp/.mirage_stdin"] == b"a\nb\n"
    assert sandbox.files.dirs == ["/tmp"]
    command, _, cwd = sandbox.commands.calls[0]
    assert command == "( wc -l ) < /tmp/.mirage_stdin"
    assert cwd == "/workspace"


@pytest.mark.asyncio
async def test_default_workspace_root_derives_from_home():
    runtime = E2BRuntime()
    await runtime.create_sandbox()
    assert await runtime.default_workspace_root() == "/home/user/workspace"


@pytest.mark.asyncio
async def test_reattached_sandbox_survives_close():
    runtime = E2BRuntime(sandbox_id="sb-live", api_key="k-123")
    await runtime.connect_sandbox("sb-live")
    assert FakeSandbox.connected == [("sb-live", {"api_key": "k-123"})]
    await runtime.close()
    assert FakeSandbox.killed == 0


@pytest.mark.asyncio
async def test_close_kills_only_an_owned_sandbox():
    runtime = E2BRuntime()
    await runtime.create_sandbox()
    runtime.owned_sandbox = True
    await runtime.close()
    assert FakeSandbox.killed == 1


@pytest.mark.asyncio
async def test_missing_sdk_fails_with_install_hint(monkeypatch):
    monkeypatch.setattr(e2b_mod, "AsyncSandbox", None)
    runtime = E2BRuntime()
    with pytest.raises(ImportError, match="mirage-ai\\[e2b\\]"):
        await runtime.create_sandbox()
