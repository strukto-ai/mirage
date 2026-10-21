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
import io
import shlex

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.runtime.sandbox import cli
from mirage.runtime.sandbox.docker import DockerRuntime
from mirage.runtime.types import SandboxPipe


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
    result = await runtime.exec_line(
        "wc -l", b"a\nb\n", {"E": "1"}, "/root/workspace"
    )
    assert result.exit_code == 0
    assert result.stdout == b"out:wc -l"
    assert result.stderr == b"warn"
    args, stdin = runtime.calls[-1]
    assert args == [
        "exec",
        "-i",
        "-w",
        "/",
        "-e",
        "E=1",
        "cid-42",
        "sh",
        "-c",
        'CDPATH= cd -- "$1" || exit 126; shift; exec "$@"',
        "sh",
        "/root/workspace",
        "sh",
        "-c",
        "wc -l",
    ]
    assert stdin == b"a\nb\n"


def test_mount_type_is_one_of_ssh_fuse_both():
    with pytest.raises(ValueError, match="docker mount_type must be one of"):
        DockerRuntime(config={"container": "c", "mount_type": "nfs"})
    DockerRuntime(config={"container": "c", "mount_type": "ssh"})


@pytest.mark.asyncio
async def test_a_pipe_holds_docker_exec_open_byte_for_byte(monkeypatch):
    spawned: list[tuple[str, ...]] = []
    spawn = cli._spawn

    async def as_cat(executable, args, **kwargs):
        spawned.append((executable, *args))
        return await spawn("cat", [], **kwargs)

    monkeypatch.setattr(cli, "_spawn", as_cat)
    runtime = DockerRuntime(config={"container": "cid-42"})
    pipe = await runtime.open_pipe("exec sshfs x y")
    assert spawned == [
        ("docker", "exec", "-i", "cid-42", "sh", "-c", "exec sshfs x y")
    ]
    payload = bytes(range(256))
    pipe.writer.write(payload)
    assert await pipe.reader.readexactly(256) == payload
    await pipe.stop()


class MountingDockerRuntime(FakeDockerRuntime):
    """A container that answers its mount table and takes sshfs pipes."""

    def __init__(self, **options):
        super().__init__(**options)
        self.table: dict[str, str] = {}

    async def _docker(self, args, stdin=None):
        if args[-1] == "cat /proc/mounts":
            self.calls.append((list(args), stdin))
            rows = "".join(
                f"src {p} {t} rw 0 0\n" for p, t in self.table.items()
            )
            return rows.encode(), b"", 0
        return await super()._docker(args, stdin)

    async def open_pipe(self, command):
        self.table[shlex.split(command)[6]] = "fuse.sshfs"
        requests = asyncio.StreamReader()

        async def stop() -> None:
            requests.feed_eof()

        return SandboxPipe(requests, io.BytesIO(), stop)


RESTRICTIONS = [
    {"paths": {"hide": ["/data/secret"]}},
    {"commands": {"deny": [{"paths": ["/data/secret"], "reason": "sealed"}]}},
    {"mounts": {"/data": "r"}},
]


def restricted(runtime, profile):
    return Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"agent": profile},
        runtimes=[runtime, "workspace"],
    )


def ran(runtime, line):
    return any(args[-1] == line for args, _ in runtime.calls)


@pytest.mark.asyncio
@pytest.mark.parametrize("profile", RESTRICTIONS)
async def test_a_session_restriction_refuses_a_line_with_no_mount_type(
    profile,
):
    runtime = FakeDockerRuntime(config={"container": "c"})
    ws = restricted(runtime, profile)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("tool run")
    assert (result.exit_code, result.stderr) == (
        126,
        b"docker: Permission denied\n",
    )
    assert runtime.calls == []
    assert (await (await ws.session("other")).shell("tool run")).exit_code == 0
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("profile", RESTRICTIONS)
async def test_a_session_restriction_refuses_a_line_on_fuse_mounts(profile):
    runtime = MountingDockerRuntime(
        config={"container": "c", "mount_type": "fuse"}
    )
    ws = restricted(runtime, profile)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("tool run")
    assert (result.exit_code, result.stderr) == (
        126,
        b"docker: Permission denied\n",
    )
    assert not ran(runtime, "tool run")
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("profile", RESTRICTIONS)
async def test_ssh_mounts_serve_a_restricted_session_its_files(profile):
    runtime = MountingDockerRuntime(
        config={"container": "c", "mount_type": "ssh"}
    )
    ws = restricted(runtime, profile)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("tool run")
    assert result.exit_code == 0
    assert runtime.table == {"/data": "fuse.sshfs"}
    assert ran(runtime, "tool run")
    await ws.close()
