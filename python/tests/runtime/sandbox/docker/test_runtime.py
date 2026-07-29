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

from mirage.runtime.sandbox.docker import DockerRuntime


class FakeDockerRuntime(DockerRuntime):

    def __init__(self, running: bool = True, **options):
        super().__init__(**options)
        self.running = running
        self.calls: list[tuple[list[str], bytes | None]] = []

    async def _docker(self, args, stdin=None):
        self.calls.append((list(args), stdin))
        if args[0] == "inspect":
            return (b"true\n" if self.running else b"false\n"), b"", 0
        script = args[-1]
        return f"out:{script}".encode(), b"warn", 0


@pytest.mark.asyncio
async def test_connect_checks_the_users_container_is_running():
    runtime = FakeDockerRuntime(config={"container": "cid-42"})
    await runtime.connect()
    args, _ = runtime.calls[0]
    assert args == ["inspect", "--format", "{{.State.Running}}", "cid-42"]


@pytest.mark.asyncio
async def test_connect_fails_loud_on_a_stopped_container():
    runtime = FakeDockerRuntime(running=False, config={"container": "cid-42"})
    with pytest.raises(RuntimeError, match="not running"):
        await runtime.connect()


def test_container_is_required():
    with pytest.raises(TypeError, match="container"):
        DockerRuntime(config={})


@pytest.mark.asyncio
async def test_exec_line_threads_cwd_env_stdin_and_real_stderr():
    runtime = FakeDockerRuntime(config={"container": "cid-42"})
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
