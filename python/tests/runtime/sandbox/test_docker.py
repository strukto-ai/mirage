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

from mirage.runtime.sandbox import DockerRuntime, SandboxResources


class FakeDockerRuntime(DockerRuntime):

    def __init__(self, **options):
        super().__init__(**options)
        self.calls: list[tuple[list[str], bytes | None]] = []
        self.files: dict[str, bytes] = {}

    async def _docker(self, args, stdin=None):
        self.calls.append((list(args), stdin))
        if args[0] == "run":
            return b"cid-42\n", b"", 0
        if args[0] == "inspect":
            return b"true\n", b"", 0
        if args[0] == "rm":
            return b"cid-42\n", b"", 0
        script = args[-1]
        if '"$HOME"' in script:
            return b"/root", b"", 0
        if script.startswith("mkdir -p"):
            self.files[script.rsplit("> ", 1)[1].strip("'")] = stdin or b""
            return b"", b"", 0
        if args[-2] == "cat":
            data = self.files.get(args[-1])
            if data is None:
                return b"", b"cat: no such file", 1
            return data, b"", 0
        return f"out:{script}".encode(), b"warn", 0


@pytest.mark.asyncio
async def test_create_maps_image_resources_and_run_args():
    runtime = FakeDockerRuntime(image="python:3.13",
                                resources=SandboxResources(cpu=2,
                                                           memory=4,
                                                           gpu=1),
                                run_args=["-v", "/host:/mnt/data"])
    sandbox_id = await runtime.create_sandbox()
    assert sandbox_id == "cid-42"
    args, _ = runtime.calls[0]
    assert args == [
        "run", "-d", "--cpus", "2", "--memory", "4g", "--gpus", "1", "-v",
        "/host:/mnt/data", "python:3.13", "sleep", "infinity"
    ]


@pytest.mark.asyncio
async def test_create_defaults_the_image():
    runtime = FakeDockerRuntime()
    await runtime.create_sandbox()
    args, _ = runtime.calls[0]
    assert "python:3.12-slim" in args


def test_disk_resource_fails_loud():
    with pytest.raises(ValueError, match="disk"):
        DockerRuntime(resources=SandboxResources(disk=10))


@pytest.mark.asyncio
async def test_default_workspace_root_derives_from_home():
    runtime = FakeDockerRuntime()
    runtime._sandbox_id = await runtime.create_sandbox()
    assert await runtime.default_workspace_root() == "/root/workspace"


@pytest.mark.asyncio
async def test_exec_line_threads_cwd_env_stdin_and_real_stderr():
    runtime = FakeDockerRuntime()
    runtime._sandbox_id = await runtime.create_sandbox()
    result = await runtime.exec_line("wc -l", b"a\nb\n", {"E": "1"},
                                     "/root/workspace")
    assert result.exit_code == 0
    assert result.stdout == b"out:wc -l"
    assert result.stderr == b"warn"
    args, stdin = runtime.calls[-1]
    assert args == [
        "exec", "-i", "-w", "/root/workspace", "-e", "E=1", "cid-42", "sh",
        "-c", "wc -l"
    ]
    assert stdin == b"a\nb\n"


@pytest.mark.asyncio
async def test_upload_download_round_trip():
    runtime = FakeDockerRuntime()
    runtime._sandbox_id = await runtime.create_sandbox()
    await runtime.upload("/root/workspace/data/train.py", b"code")
    args, stdin = runtime.calls[-1]
    assert args[-1] == ("mkdir -p /root/workspace/data && "
                        "cat > /root/workspace/data/train.py")
    assert stdin == b"code"
    assert await runtime.download("/root/workspace/data/train.py") == b"code"


@pytest.mark.asyncio
async def test_download_missing_file_fails_loud():
    runtime = FakeDockerRuntime()
    runtime._sandbox_id = await runtime.create_sandbox()
    with pytest.raises(RuntimeError, match="download failed"):
        await runtime.download("/root/workspace/missing")


@pytest.mark.asyncio
async def test_reattached_container_survives_close():
    runtime = FakeDockerRuntime(sandbox_id="cid-live")
    await runtime.connect_sandbox("cid-live")
    await runtime.close()
    assert all(args[0] != "rm" for args, _ in runtime.calls)


@pytest.mark.asyncio
async def test_close_removes_only_an_owned_container():
    runtime = FakeDockerRuntime()
    runtime._sandbox_id = await runtime.create_sandbox()
    runtime.owned_sandbox = True
    await runtime.close()
    args, _ = runtime.calls[-1]
    assert args == ["rm", "-f", "cid-42"]
