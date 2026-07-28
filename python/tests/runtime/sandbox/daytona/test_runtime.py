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

from mirage.runtime.sandbox import DaytonaRuntime
from mirage.runtime.sandbox.daytona import sdk


class FakeProcess:

    def __init__(self) -> None:
        self.calls: list[tuple[str, str | None, dict | None]] = []

    async def exec(self, command, cwd=None, env=None, timeout=None):
        self.calls.append((command, cwd, env))

        class Response:
            exit_code = 0
            result = ("/home/daytona"
                      if "$HOME" in command else f"out:{command}")

        return Response()


class FakeFs:

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.folders: list[str] = []

    async def create_folder(self, path, mode):
        self.folders.append(path)

    async def upload_file(self, data, path):
        self.files[path] = data

    async def download_file(self, path):
        return self.files.get(path)


class FakeSandbox:
    id = "sb-77"

    def __init__(self) -> None:
        self.process = FakeProcess()
        self.fs = FakeFs()


class FakeClient:
    created: list[object] = []
    fetched: list[str] = []
    deleted: list[object] = []
    closed = 0
    last: "FakeSandbox | None" = None

    def __init__(self, config=None) -> None:
        self.config = config

    async def create(self, params):
        FakeClient.created.append(params)
        FakeClient.last = FakeSandbox()
        return FakeClient.last

    async def get(self, sandbox_id):
        FakeClient.fetched.append(sandbox_id)
        FakeClient.last = FakeSandbox()
        return FakeClient.last

    async def delete(self, sandbox, timeout=60):
        FakeClient.deleted.append(sandbox)

    async def close(self):
        FakeClient.closed += 1


@pytest.fixture(autouse=True)
def fake_client(monkeypatch):
    FakeClient.created = []
    FakeClient.fetched = []
    FakeClient.deleted = []
    FakeClient.closed = 0
    FakeClient.last = None
    monkeypatch.setattr(sdk, "AsyncDaytona", FakeClient)


@pytest.mark.asyncio
async def test_create_maps_image_env_and_gpu_forces_ephemeral():
    runtime = DaytonaRuntime(config={
        "image": "cuda:12",
        "env": {
            "A": "1"
        },
        "cpu": 4,
        "gpu": "H100",
    })
    sandbox_id = await runtime.create_sandbox()
    assert sandbox_id == "sb-77"
    params = FakeClient.created[0]
    assert params.image == "cuda:12"
    assert params.env_vars == {"A": "1"}
    assert params.ephemeral is True
    assert params.resources.cpu == 4
    assert params.resources.gpu == 1


@pytest.mark.asyncio
async def test_create_without_image_uses_default_snapshot():
    runtime = DaytonaRuntime()
    await runtime.create_sandbox()
    params = FakeClient.created[0]
    assert not hasattr(params, "image")


@pytest.mark.asyncio
async def test_template_boots_a_snapshot_by_name():
    runtime = DaytonaRuntime(config={"template": "mirage-fuse"})
    await runtime.create_sandbox()
    params = FakeClient.created[0]
    assert params.snapshot == "mirage-fuse"
    assert not hasattr(params, "image")


def test_template_and_image_conflict():
    with pytest.raises(ValueError, match="not both"):
        DaytonaRuntime(config={"template": "mirage-fuse", "image": "cuda:12"})


def test_cli_args_fail_loud():
    # Not a DaytonaConfig field: daytona is SDK-driven.
    with pytest.raises(TypeError, match="args"):
        DaytonaRuntime(config={"args": ["--cap-add", "SYS_ADMIN"]})


@pytest.mark.asyncio
async def test_params_pass_through_verbatim():
    runtime = DaytonaRuntime(
        config={
            "params": {
                "auto_stop_interval": 10,
                "auto_delete_interval": 30,
                "labels": {
                    "team": "ml"
                },
            }
        })
    await runtime.create_sandbox()
    params = FakeClient.created[0]
    assert params.auto_stop_interval == 10
    assert params.auto_delete_interval == 30
    assert params.labels == {"team": "ml"}


@pytest.mark.asyncio
async def test_params_merge_last_over_config_fields():
    runtime = DaytonaRuntime(config={
        "image": "cuda:12",
        "params": {
            "image": "cuda:13"
        },
    })
    await runtime.create_sandbox()
    params = FakeClient.created[0]
    assert params.image == "cuda:13"


@pytest.mark.asyncio
async def test_sizing_without_image_fails_loud():
    runtime = DaytonaRuntime(config={"gpu": 1})
    with pytest.raises(ValueError, match="requires an image"):
        await runtime.create_sandbox()


@pytest.mark.asyncio
async def test_exec_line_redirects_stdin_through_a_file():
    runtime = DaytonaRuntime()
    await runtime.create_sandbox()
    result = await runtime.exec_line("wc -l", b"a\nb\n", {"E": "1"},
                                     "/workspace")
    assert result.exit_code == 0
    assert result.stderr is None
    sandbox = FakeClient.last
    assert sandbox.fs.files["/tmp/.mirage_stdin"] == b"a\nb\n"
    command, cwd, env = sandbox.process.calls[0]
    assert command == "( wc -l ) < /tmp/.mirage_stdin"
    assert cwd == "/workspace"
    assert env == {"E": "1"}


@pytest.mark.asyncio
async def test_reattached_sandbox_survives_close():
    runtime = DaytonaRuntime(sandbox_id="sb-live")
    await runtime.connect_sandbox("sb-live")
    assert FakeClient.fetched == ["sb-live"]
    await runtime.close()
    assert FakeClient.deleted == []
    assert FakeClient.closed == 1


@pytest.mark.asyncio
async def test_close_deletes_only_an_owned_sandbox():
    runtime = DaytonaRuntime()
    await runtime.create_sandbox()
    runtime.owned_sandbox = True
    await runtime.close()
    assert len(FakeClient.deleted) == 1
    assert FakeClient.closed == 1


@pytest.mark.asyncio
async def test_default_workspace_root_derives_from_home():
    runtime = DaytonaRuntime()
    await runtime.create_sandbox()
    assert await runtime.default_workspace_root() == "/home/daytona/workspace"


@pytest.mark.asyncio
async def test_missing_sdk_fails_with_install_hint(monkeypatch):
    monkeypatch.setattr(sdk, "AsyncDaytona", None)
    runtime = DaytonaRuntime()
    with pytest.raises(ImportError, match="mirage-ai\\[daytona\\]"):
        await runtime.create_sandbox()
