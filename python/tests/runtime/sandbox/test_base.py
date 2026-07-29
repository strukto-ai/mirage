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

from mirage import MountMode, RAMResource, Workspace
from mirage.cache.index.config import IndexEntry
from mirage.io.types import materialize
from mirage.runtime.base import RunArgs, RunResult
from mirage.runtime.sandbox import RemoteSandbox, SandboxConfig

FAKE_SPEC = {"resource": "s3", "config": {"bucket": "b"}}

CREATE_LINE = ("mirage workspace delete sandbox >/dev/null 2>&1; "
               "mirage workspace create --id sandbox --from-env")


class RecordingSandbox(RemoteSandbox):
    name = "recbox"

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.execs: list[tuple[str, bytes | None, str]] = []
        self.exec_envs: list[dict[str, str]] = []
        self.connected = 0
        self.synced = 0

    async def connect(self) -> None:
        self.connected += 1

    async def exec_line(self, line: str, stdin: bytes | None,
                        env: dict[str, str], cwd: str) -> RunResult:
        self.execs.append((line, stdin, cwd))
        self.exec_envs.append(dict(env))
        return RunResult(stdout=b"ran:" + line.encode(),
                         stderr=None,
                         exit_code=0)

    # Base-machinery tests exercise connection, not the mount setup,
    # so record the call and skip the real one; FuseSandbox restores it.
    async def mount_workspace(self) -> None:
        self.synced += 1


class FuseSandbox(RecordingSandbox):

    async def mount_workspace(self) -> None:
        await RemoteSandbox.mount_workspace(self)


def _attach_specs(box: RecordingSandbox, specs: dict) -> None:
    box.attach(box._dispatch, lambda: list(specs), lambda: dict(specs))


def _create_calls(box: RecordingSandbox) -> list[dict]:
    return [
        json.loads(env["MIRAGE_WORKSPACE_CONFIG"])
        for (line, _, _), env in zip(box.execs, box.exec_envs)
        if line == CREATE_LINE
    ]


@pytest.mark.asyncio
async def test_first_line_connects_and_mounts_once():
    box = RecordingSandbox(captures=("python3", ))
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    try:
        io = await ws.execute("python3 x")
        assert await materialize(io.stdout) == b"ran:python3 x"
        assert box.connected == 1
        assert box.synced == 1
        await ws.execute("python3 x")
        # The workspace mounts once on the first line, not per line.
        assert box.connected == 1
        assert box.synced == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_mount_creates_one_workspace_with_config_in_env():
    box = FuseSandbox(captures=("python3", ))
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    _attach_specs(box, {"/data": FAKE_SPEC})
    try:
        await ws.execute("python3 /data/train.py")
        configs = _create_calls(box)
        assert len(configs) == 1
        assert configs[0] == {
            "mode": "EXEC",
            "mounts": {
                "/data": {
                    **FAKE_SPEC,
                    "fuse": "/workspace/data",
                },
            },
        }
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_mount_excludes_system_mounts_and_runs_once():
    box = FuseSandbox(captures=("python3", ))
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    _attach_specs(box, {"/data": FAKE_SPEC, "/dev": None})
    try:
        await ws.execute("python3 x")
        await ws.execute("python3 x")
        configs = _create_calls(box)
        # One workspace create at first line, /dev never reproduced,
        # and no mount work on later lines.
        assert len(configs) == 1
        assert list(configs[0]["mounts"]) == ["/data"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_root_only_workspace_mounts_at_the_root():
    box = FuseSandbox(captures=("python3", ))
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    _attach_specs(box, {"/": FAKE_SPEC})
    try:
        await ws.execute("python3 x")
        configs = _create_calls(box)
        assert configs[0]["mounts"]["/"]["fuse"] == "/workspace"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_cwd_resolves_under_workspace_root_and_env_merges():
    box = RecordingSandbox(captures=("*", ), config={"env": {"BASE": "1"}})
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    try:
        result = await box.run_line("nvidia-smi", None, {"LINE": "2"},
                                    "/data/deep")
        assert result.exit_code == 0
        assert box.execs[-1][2] == "/workspace/data/deep"
        assert box.exec_envs[-1]["BASE"] == "1"
        assert box.exec_envs[-1]["LINE"] == "2"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_custom_workspace_root_rebases_cwd():
    box = RecordingSandbox(captures=("*", ),
                           workspace_root="/home/daytona/workspace")
    result = await box.run_line("ls", None, {}, "/data")
    assert result.exit_code == 0
    assert box.execs[-1][2] == "/home/daytona/workspace/data"


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


@pytest.mark.asyncio
async def test_run_raises_sandboxes_take_lines():
    box = RecordingSandbox()
    with pytest.raises(NotImplementedError, match="whole lines"):
        await box.run(RunArgs(code="x", args=[], env={}, stdin=None, flags={}))


def test_config_dict_form_coerces():
    box = RecordingSandbox(config={"env": {"A": "1"}})
    assert box.config == SandboxConfig(env={"A": "1"})


class FailingMountSandbox(FuseSandbox):

    async def exec_line(self, line: str, stdin: bytes | None,
                        env: dict[str, str], cwd: str) -> RunResult:
        if line.startswith("mirage workspace"):
            self.execs.append((line, stdin, cwd))
            self.exec_envs.append(dict(env))
            return RunResult(stdout=b"",
                             stderr=b"mirage: command not found",
                             exit_code=127)
        return await super().exec_line(line, stdin, env, cwd)


@pytest.mark.asyncio
async def test_mount_failure_points_at_the_image():
    box = FailingMountSandbox(captures=("python3", ))
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    _attach_specs(box, {"/data": FAKE_SPEC})
    try:
        io = await ws.execute("python3 x")
        assert io.exit_code != 0
        stderr = await materialize(io.stderr)
        assert b"mirage-python-fuse" in stderr
        assert b"command not found" in stderr
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_mount_rejects_unmountable_mounts():
    box = FuseSandbox(captures=("python3", ))
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    try:
        io = await ws.execute("python3 x")
        assert io.exit_code != 0
        stderr = await materialize(io.stderr)
        assert b"not remotely mountable" in stderr
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
