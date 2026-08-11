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

from mirage.runtime.sandbox.constants import stdin_redirect
from mirage.runtime.sandbox.e2b import E2BRuntime, sdk


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


class FakeSandbox:
    connected: list[tuple[str, dict]] = []
    last: "FakeSandbox | None" = None

    def __init__(self) -> None:
        self.sandbox_id = "sb-e2b"
        self.commands = FakeCommands()
        self.files = FakeFiles()

    @classmethod
    async def connect(cls, sandbox_id, **params):
        cls.connected.append((sandbox_id, params))
        cls.last = cls()
        return cls.last


@pytest.fixture(autouse=True)
def fake_sdk(monkeypatch):
    FakeSandbox.connected = []
    FakeSandbox.last = None
    monkeypatch.setattr(sdk, "AsyncSandbox", FakeSandbox)


@pytest.mark.asyncio
async def test_connect_attaches_by_id_with_api_key():
    runtime = E2BRuntime(config={
        "sandbox_id": "sb-live",
        "api_key": "k-123",
    })
    await runtime.connect()
    assert FakeSandbox.connected == [("sb-live", {"api_key": "k-123"})]


def test_sandbox_id_is_required():
    with pytest.raises(TypeError, match="sandbox_id"):
        E2BRuntime(config={})


@pytest.mark.asyncio
async def test_exec_line_threads_env_cwd_and_real_stderr():
    runtime = E2BRuntime(config={"sandbox_id": "sb-live"})
    await runtime.connect()
    result = await runtime.exec_line("wc -l", None, {"E": "1"}, "/workspace")
    assert result.exit_code == 0
    assert result.stdout == b"out:wc -l"
    assert result.stderr == b"warn"
    sandbox = FakeSandbox.last
    assert sandbox.commands.calls[0] == ("wc -l", {"E": "1"}, "/workspace")


@pytest.mark.asyncio
async def test_exec_line_nonzero_exit_comes_back_as_result():
    runtime = E2BRuntime(config={"sandbox_id": "sb-live"})
    await runtime.connect()
    result = await runtime.exec_line("exit 3", None, {}, "/workspace")
    assert result.exit_code == 3
    assert result.stdout == b"partial"
    assert result.stderr == b"boom-err"


@pytest.mark.asyncio
async def test_stdin_redirects_through_an_uploaded_file():
    runtime = E2BRuntime(config={"sandbox_id": "sb-live"})
    await runtime.connect()
    result = await runtime.exec_line("wc -l", b"a\nb\n", {}, "/workspace")
    assert result.exit_code == 0
    sandbox = FakeSandbox.last
    [path] = sandbox.files.files
    # Unique per invocation, so concurrent stdin lines never collide.
    assert path.startswith("/tmp/.mirage_stdin_")
    assert sandbox.files.files[path] == b"a\nb\n"
    assert sandbox.files.dirs == ["/tmp"]
    command, _, cwd = sandbox.commands.calls[0]
    assert command == stdin_redirect("wc -l", path)
    assert f"rm -f {path}" in command
    assert cwd == "/workspace"


@pytest.mark.asyncio
async def test_missing_sdk_fails_with_install_hint(monkeypatch):
    monkeypatch.setattr(sdk, "AsyncSandbox", None)
    runtime = E2BRuntime(config={"sandbox_id": "sb-live"})
    with pytest.raises(ImportError, match="mirage-ai\\[e2b\\]"):
        await runtime.connect()
