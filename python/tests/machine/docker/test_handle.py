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
from mirage.io.types import materialize
from mirage.machine import program
from mirage.machine.docker import DockerMachine
from mirage.machine.types import MachinePipe
from mirage.runtime.types import RunResult
from tests.fixtures.machine import on


class FakeDockerMachine(DockerMachine):
    def __init__(
        self,
        running: bool = True,
        captures=None,
        name="box",
        state: str | None = None,
        **options,
    ):
        super().__init__(name, **options)
        self.captures = captures
        self.state = state or ("running" if running else "exited")
        self.refusal: bytes | None = None
        self.calls: list[tuple[list[str], bytes | None]] = []

    async def _exec_program(self, args, stdin=None, output=None, errors=None):
        stdin = await materialize(stdin) if stdin is not None else None
        self.calls.append((list(args), stdin))
        if args[0] == "inspect":
            state = self.state.encode()
            return RunResult(b'{"Status": "' + state + b'"}', None, 0)
        if args[0] in ("pause", "unpause"):
            if self.refusal is not None:
                return RunResult(b"", self.refusal, 1)
            return RunResult(b"", b"", 0)
        script = args[-1]
        if output is not None:
            await output(f"out:{script}".encode())
            return RunResult(b"", b"warn", 0)
        return RunResult(f"out:{script}".encode(), b"warn", 0)


@pytest.mark.asyncio
async def test_connect_checks_the_users_container_is_running():
    runtime = FakeDockerMachine(config={"container": "cid-42"})
    await runtime.connect()
    args, _ = runtime.calls[0]
    assert args == ["inspect", "--format", "{{json .State}}", "cid-42"]


@pytest.mark.asyncio
async def test_connect_fails_loud_on_a_stopped_container():
    runtime = FakeDockerMachine(running=False, config={"container": "cid-42"})
    with pytest.raises(RuntimeError, match="not running"):
        await runtime.connect()


@pytest.mark.asyncio
async def test_connect_unpauses_a_paused_container():
    runtime = FakeDockerMachine(state="paused", config={"container": "c-1"})
    await runtime.connect()
    assert runtime.calls[-1] == (["unpause", "c-1"], None)


@pytest.mark.asyncio
async def test_connect_fails_loud_when_the_unpause_fails():
    runtime = FakeDockerMachine(state="paused", config={"container": "c-1"})
    runtime.refusal = b"Error response from daemon: cgroup busy"
    with pytest.raises(
        RuntimeError, match="docker unpause c-1 failed: .*busy"
    ):
        await runtime.connect()


async def _reached(**config) -> FakeDockerMachine:
    runtime = FakeDockerMachine(config={"container": "c-1", **config})
    await runtime.connect()
    await runtime.close()
    return runtime


@pytest.mark.asyncio
async def test_pause_pauses_the_container_it_reached():
    runtime = await _reached()
    await runtime.pause()
    assert runtime.calls[-1] == (["pause", "c-1"], None)


@pytest.mark.asyncio
async def test_pause_leaves_alone_a_container_it_never_reached():
    runtime = FakeDockerMachine(config={"container": "c-1"})
    await runtime.pause()
    assert runtime.calls == []


@pytest.mark.asyncio
async def test_a_container_already_gone_counts_as_paused():
    runtime = await _reached()
    runtime.refusal = b"Error response from daemon: No such container: c-1"
    await runtime.pause()


@pytest.mark.asyncio
async def test_any_other_pause_failure_is_raised():
    runtime = await _reached()
    runtime.refusal = b"Error response from daemon: container is not running"
    with pytest.raises(RuntimeError, match="docker pause c-1 failed"):
        await runtime.pause()


def _asks(**config) -> bool:
    return DockerMachine(
        "box", config={"container": "c", **config}
    ).config_asks_to_pause()


def test_only_on_pause_pause_asks_the_workspace_to_pause_it():
    assert (_asks(on_pause="pause"), _asks()) == (True, False)
    with pytest.raises(ValueError, match="docker on_pause must be one of"):
        DockerMachine("box", config={"container": "c", "on_pause": "stop"})


def test_container_is_required():
    with pytest.raises(TypeError, match="container"):
        DockerMachine("box", config={})


@pytest.mark.asyncio
async def test_exec_line_threads_cwd_env_stdin_and_real_stderr():
    runtime = FakeDockerMachine(config={"container": "cid-42"})
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
        "/bin/sh",
        "-c",
        'CDPATH= cd -- "$1" || exit 126; shift; exec "$@"',
        "sh",
        "/root/workspace",
        "/bin/sh",
        "-c",
        "wc -l",
    ]
    assert stdin == b"a\nb\n"


def test_mount_type_is_one_of_ssh_fuse_both():
    with pytest.raises(ValueError, match="docker mount_type must be one of"):
        DockerMachine("box", config={"container": "c", "mount_type": "nfs"})
    DockerMachine("box", config={"container": "c", "mount_type": "ssh"})


@pytest.mark.asyncio
async def test_a_pipe_holds_docker_exec_open_byte_for_byte(monkeypatch):
    spawned: list[tuple[str, ...]] = []
    spawn = program._spawn

    async def as_cat(executable, args, **kwargs):
        spawned.append((executable, *args))
        return await spawn("cat", [], **kwargs)

    monkeypatch.setattr(program, "_spawn", as_cat)
    runtime = DockerMachine("box", config={"container": "cid-42"})
    pipe = await runtime.open_pipe("exec sshfs x y")
    assert spawned == [
        (
            "docker",
            "exec",
            "-i",
            "-w",
            "/",
            "cid-42",
            "/bin/sh",
            "-c",
            "exec sshfs x y",
        )
    ]
    payload = bytes(range(256))
    pipe.writer.write(payload)
    assert await pipe.reader.readexactly(256) == payload
    await pipe.stop()


class MountingDockerMachine(FakeDockerMachine):
    """A container that answers its mount table and takes sshfs pipes."""

    def __init__(self, captures=None, name="box", **options):
        super().__init__(name, **options)
        self.captures = captures
        self.table: dict[str, tuple[str, str]] = {}

    async def _exec_program(self, args, stdin=None, output=None, errors=None):
        if args[-1] == "cat /proc/mounts":
            self.calls.append((list(args), stdin))
            rows = "".join(
                f"{source} {p} {t} rw 0 0\n"
                for p, (source, t) in self.table.items()
            )
            return RunResult(rows.encode(), None, 0)
        return await super()._exec_program(args, stdin, output)

    async def open_pipe(self, command):
        source, prefix = shlex.split(command)[5:7]
        self.table[prefix] = (source, "fuse.sshfs")
        requests = asyncio.StreamReader()

        async def stop() -> None:
            requests.feed_eof()

        return MachinePipe(requests, io.BytesIO(), stop)


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
        **on(runtime, "workspace"),
    )


def ran(runtime, line):
    words = line.split()
    return any(args[-len(words) :] == words for args, _ in runtime.calls)


@pytest.mark.asyncio
@pytest.mark.parametrize("profile", RESTRICTIONS)
async def test_a_session_restriction_refuses_a_line_with_no_mount_type(
    profile,
):
    runtime = FakeDockerMachine(config={"container": "c"})
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
    runtime = MountingDockerMachine(
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
    runtime = MountingDockerMachine(
        config={"container": "c", "mount_type": "ssh"}
    )
    ws = restricted(runtime, profile)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("tool run")
    assert result.exit_code == 0
    assert [kind for _, kind in runtime.table.values()] == ["fuse.sshfs"]
    assert list(runtime.table) == ["/data"]
    assert ran(runtime, "tool run")
    await ws.close()
