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

import pytest

from mirage import MountMode, RAMResource, Workspace
from mirage.cache.index.config import IndexEntry
from mirage.io.types import materialize
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.sandbox import RemoteSandbox, SandboxConfig
from mirage.runtime.types import RunResult
from mirage.types import Limit


class RecordingSandbox(RemoteSandbox):
    name = "recbox"

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.execs: list[tuple[str, bytes | None, str]] = []
        self.exec_envs: list[dict[str, str]] = []
        self.connected = 0

    async def connect(self) -> None:
        self.connected += 1

    async def exec_line(self, line: str, stdin: bytes | None,
                        env: dict[str, str], cwd: str) -> RunResult:
        self.execs.append((line, stdin, cwd))
        self.exec_envs.append(dict(env))
        return RunResult(stdout=b"ran:" + line.encode(),
                         stderr=None,
                         exit_code=0)


@pytest.mark.asyncio
async def test_first_line_connects_once():
    box = RecordingSandbox(captures=("python3", ))
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    try:
        io = await ws.execute("python3 x")
        assert await materialize(io.stdout) == b"ran:python3 x"
        assert box.connected == 1
        await ws.execute("python3 x")
        # The runtime connects on the first line, not per line.
        assert box.connected == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_failed_connect_retries_on_the_next_line():

    class FlakyBox(RecordingSandbox):

        async def connect(self) -> None:
            await super().connect()
            if self.connected == 1:
                raise RuntimeError("sandbox not running")

    box = FlakyBox(captures=("python3", ))
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    try:
        io = await ws.execute("python3 x")
        assert io.exit_code != 0
        assert b"not running" in await materialize(io.stderr)
        io = await ws.execute("python3 x")
        assert io.exit_code == 0
        assert box.connected == 2
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_cwd_passes_through_verbatim_and_env_merges():
    box = RecordingSandbox(captures=("*", ), config={"env": {"BASE": "1"}})
    result = await box.run_line("nvidia-smi", None, {"LINE": "2"},
                                "/data/deep")
    assert result.exit_code == 0
    # The sandbox serves the workspace at the same prefixes as the
    # host, so nothing is rewritten.
    assert box.execs[-1][2] == "/data/deep"
    assert box.exec_envs[-1]["BASE"] == "1"
    assert box.exec_envs[-1]["LINE"] == "2"


@pytest.mark.asyncio
async def test_stdin_bytes_reach_exec_line():
    box = RecordingSandbox(captures=("*", ))
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    try:
        await ws.execute("wc -l", stdin=b"a\nb\n")
        assert box.execs[-1][1] == b"a\nb\n"
    finally:
        await ws.close()


def test_sandboxes_take_lines_not_stages():
    # A sandbox is a line executor, never the engine inside one
    # command: it carries the line door and no interpreter door.
    box = RecordingSandbox()
    assert isinstance(box, LineExecutorMixin)
    assert not hasattr(box, "run")


def test_config_dict_form_coerces():
    box = RecordingSandbox(config={"env": {"A": "1"}})
    assert box.config == SandboxConfig(env={"A": "1"})


@pytest.mark.asyncio
async def test_line_timeout_answers_124():

    class SlowBox(RecordingSandbox):

        async def exec_line(self, line: str, stdin: bytes | None,
                            env: dict[str, str], cwd: str) -> RunResult:
            await asyncio.sleep(0.5)
            return await super().exec_line(line, stdin, env, cwd)

    guards = {"python3": Limit(timeout_seconds=0.05)}
    box = SlowBox(captures=("python3", ))
    ws = Workspace({"/data": (RAMResource(), MountMode.EXEC, guards)},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    try:
        # A captured line obeys the same command_limits as any
        # command: the mount's python3 timeout answers exit 124.
        io = await ws.execute("python3 train.py")
        assert io.exit_code == 124
        assert b"timed out" in await materialize(io.stderr)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_line_output_caps_truncate_with_notice():

    class ChattyBox(RecordingSandbox):

        async def exec_line(self, line: str, stdin: bytes | None,
                            env: dict[str, str], cwd: str) -> RunResult:
            return RunResult(stdout=b"a\nb\nc\n", stderr=None, exit_code=0)

    guards = {"python3": Limit(max_lines=2)}
    box = ChattyBox(captures=("python3", ))
    ws = Workspace({"/data": (RAMResource(), MountMode.EXEC, guards)},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    try:
        io = await ws.execute("python3 train.py")
        assert io.exit_code == 0
        assert await materialize(io.stdout) == b"a\nb\n"
        assert b"truncated at limit" in await materialize(io.stderr)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_remote_line_invalidates_local_read_caches():
    box = RecordingSandbox(captures=("python3", ))
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    try:
        mount = next(m for m in ws._registry.mounts() if m.prefix == "/data/")
        stale = IndexEntry(id="stale", name="stale.txt", resource_type="ram")
        await mount.resource.index.put("/stale.txt", stale)
        await ws.execute("python3 anything")
        looked = await mount.resource.index.get("/stale.txt")
        assert looked.entry is None
    finally:
        await ws.close()
