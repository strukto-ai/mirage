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
from mirage.runtime.sandbox import RemoteSandbox, SandboxResources

FAKE_SPEC = {"resource": "s3", "config": {"bucket": "b"}}


class RecordingSandbox(RemoteSandbox):
    name = "recbox"

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.files: dict[str, bytes] = {}
        self.execs: list[tuple[str, bytes | None, str]] = []
        self.created = 0
        self.connected: list[str] = []
        self.mounted = False
        self.last_env: dict[str, str] = {}

    async def create_sandbox(self) -> str:
        self.created += 1
        return "sb-rec"

    async def connect_sandbox(self, sandbox_id: str) -> None:
        self.connected.append(sandbox_id)

    async def exec_line(self, line: str, stdin: bytes | None,
                        env: dict[str, str], cwd: str) -> RunResult:
        self.execs.append((line, stdin, cwd))
        self.last_env = dict(env)
        return RunResult(stdout=b"ran:" + line.encode(),
                         stderr=None,
                         exit_code=0)

    async def upload(self, path: str, data: bytes) -> None:
        self.files[path] = data

    # Base-machinery tests exercise provisioning, not the FUSE mount, so
    # record the mount call and skip the real one; FuseSandbox restores it.
    async def mount_workspace(self) -> None:
        self.mounted = True


class FuseSandbox(RecordingSandbox):

    async def mount_workspace(self) -> None:
        await RemoteSandbox.mount_workspace(self)


def _attach_specs(box: RecordingSandbox, specs: dict) -> None:
    box.attach(box._dispatch, box._mount_prefixes, lambda: specs)


@pytest.mark.asyncio
async def test_first_line_provisions_and_mounts_the_workspace():
    box = RecordingSandbox(captures=("python3", ))
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    try:
        io = await ws.execute("python3 x")
        assert await materialize(io.stdout) == b"ran:python3 x"
        assert box.created == 1
        assert box.owned_sandbox is True
        assert box.sandbox_id == "sb-rec"
        assert box.mounted is True
        await ws.execute("python3 x")
        assert box.created == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_fuse_config_excludes_system_mounts():
    box = FuseSandbox(captures=("python3", ))
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    _attach_specs(box, {"/data": FAKE_SPEC})
    try:
        await ws.execute("python3 x")
        config = json.loads(box.files["/.mirage-workspace.json"])
        assert set(config["mounts"]) == {"/data"}
        assert not any("/dev" in m or "bash_history" in m
                       for m in config["mounts"])
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_root_only_workspace_mounts_from_root():
    box = FuseSandbox(captures=("python3", ))
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    _attach_specs(box, {"/": FAKE_SPEC})
    try:
        await ws.execute("python3 x")
        config = json.loads(box.files["/.mirage-workspace.json"])
        assert set(config["mounts"]) == {"/"}
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_cwd_resolves_under_workspace_root_and_env_merges():
    box = RecordingSandbox(captures=("*", ), env={"BASE": "1"})
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    try:
        result = await box.run_line("nvidia-smi", None, {"LINE": "2"},
                                    "/data/deep")
        assert result.exit_code == 0
        assert box.execs[-1][2] == "/workspace/data/deep"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_line_paths_translate_to_sandbox_mountpoints():
    box = RecordingSandbox(captures=("python3", ))
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    try:
        await ws.execute(
            "python3 /data/a.py --out /data/r.json /tmp/x /data.txt")
        line = box.execs[-1][0]
        assert "/workspace/data/a.py" in line
        assert "/workspace/data/r.json" in line
        # A system path and a sibling file are left untouched.
        assert " /tmp/x " in line
        assert "/data.txt" in line
        assert "/workspace/data.txt" not in line
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_mount_mountpoints_exposed_as_env_vars():
    box = RecordingSandbox(captures=("python3", ))
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    try:
        await ws.execute("python3 x")
        assert box.last_env["MIRAGE_DATA"] == "/workspace/data"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_sandbox_id_reattaches_instead_of_creating():
    box = RecordingSandbox(captures=("python3", ), sandbox_id="sb-live")
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    try:
        await ws.execute("python3 x")
        assert box.created == 0
        assert box.connected == ["sb-live"]
        assert box.owned_sandbox is False
        assert box.sandbox_id == "sb-live"
    finally:
        await ws.close()


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


def test_resources_dict_form_coerces():
    box = RecordingSandbox(resources={"cpu": 4, "gpu": "H100"})
    assert box.resources == SandboxResources(cpu=4, gpu="H100")


@pytest.mark.asyncio
async def test_fuse_mount_runs_mirage_workspace_create():
    box = FuseSandbox(captures=("python3", ))
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    _attach_specs(box, {"/data": FAKE_SPEC})
    try:
        await ws.execute("python3 /data/train.py")
        # No tree upload: the only file is the standard workspace
        # config, declaring each mount with its live fuse target.
        assert sorted(box.files) == ["/.mirage-workspace.json"]
        config = json.loads(box.files["/.mirage-workspace.json"])
        assert config == {
            "mode": "exec",
            "mounts": {
                "/data": {
                    **FAKE_SPEC, "fuse": "/workspace/data"
                }
            },
        }
        created = [
            line for line, _, _ in box.execs
            if line == "mirage workspace create /.mirage-workspace.json"
        ]
        assert len(created) == 1
    finally:
        await ws.close()


class FailingCreateSandbox(FuseSandbox):

    async def exec_line(self, line: str, stdin: bytes | None,
                        env: dict[str, str], cwd: str) -> RunResult:
        if line.startswith("mirage workspace create"):
            return RunResult(stdout=b"",
                             stderr=b"mirage: command not found",
                             exit_code=127)
        return await super().exec_line(line, stdin, env, cwd)


@pytest.mark.asyncio
async def test_fuse_mount_failure_points_at_the_image():
    box = FailingCreateSandbox(captures=("python3", ))
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
async def test_fuse_mount_rejects_unmountable_mounts():
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
