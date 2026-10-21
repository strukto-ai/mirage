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
from mirage.context import (
    current_caller,
    get_admission,
    get_current_session,
    line_running,
)
from mirage.runtime.sandbox import mounts
from mirage.runtime.sandbox.base import RemoteSandbox
from mirage.runtime.sandbox.constants import SSHFS_OPTIONS
from mirage.runtime.sandbox.mounts import mount_table, top_prefixes
from mirage.runtime.types import RunResult, SandboxPipe
from mirage.types import Limit


class Sink:
    def write(self, data: bytes) -> None:
        return None

    def close(self) -> None:
        return None


async def lent_a_line() -> bool:
    return current_caller().stop is not None


class Drain:
    """A served prefix's server that reads its pipe to the end."""

    def __init__(self, files, session, run):
        self.files = files
        self.session = session
        self.run = run

    async def serve(self, reader, writer):
        await reader.read()

    async def sync(self):
        return None


class FakeSandbox(RemoteSandbox):
    """A sandbox that answers its mount table and takes sshfs pipes."""

    name = "fake"

    def __init__(self, mount_type, own=(), sshfs=True, sshfs_mounts=True):
        super().__init__(captures=["python3"])
        self._serve_mounts(mount_type)
        self.table = {prefix: "tmpfs" for prefix in own}
        self.sshfs = sshfs
        self.sshfs_mounts = sshfs_mounts
        self.fail_unmount = False
        self.commands: list[str] = []
        self.pipes: list[str] = []
        self.requests: dict[str, asyncio.StreamReader] = {}
        self.stopped: list[str] = []

    async def connect(self) -> None:
        return None

    async def exec_line(self, line, stdin, env, cwd):
        self.commands.append(line)
        if line == "cat /proc/mounts":
            rows = "".join(
                f"src {p.replace(' ', chr(92) + '040')} {kind} rw 0 0\n"
                for p, kind in self.table.items()
            )
            return RunResult(stdout=rows.encode(), stderr=None, exit_code=0)
        if line == "command -v sshfs":
            return RunResult(
                stdout=b"", stderr=None, exit_code=0 if self.sshfs else 1
            )
        if line == "python3 slow.py":
            await asyncio.Event().wait()
        if line.startswith("fusermount3 -uz "):
            if self.fail_unmount:
                raise RuntimeError("the sandbox went away")
            self.table.pop(shlex.split(line)[2], None)
        return RunResult(stdout=b"ran\n", stderr=None, exit_code=0)

    async def open_pipe(self, command):
        self.pipes.append(command)
        prefix = shlex.split(command)[6]
        if self.sshfs_mounts:
            self.table[prefix] = "fuse.sshfs"
        requests = asyncio.StreamReader()
        self.requests[prefix] = requests

        async def stop() -> None:
            self.stopped.append(prefix)
            requests.feed_eof()

        return SandboxPipe(requests, Sink(), stop)


def workspace(runtime, hide=(), modes=None, **options):
    profile = {"paths": {"hide": list(hide)}}
    if modes is not None:
        profile["mounts"] = modes
    return Workspace(
        {
            "/": RAMVFS(),
            "/data": RAMVFS(),
            "/data/sub": RAMVFS(),
            "/my notes": RAMVFS(),
        },
        mode=MountMode.WRITE,
        profiles={"agent": profile},
        runtimes=[runtime, "workspace"],
        **options,
    )


def served(sandbox):
    return [shlex.split(p)[6] for p in sandbox.pipes]


def test_mount_table_unescapes_paths_and_keeps_the_top_entry():
    table = mount_table(
        "tmpfs /data tmpfs rw 0 0\n"
        "mirage:/data /data fuse.sshfs rw 0 0\n"
        "x /my\\040notes tmpfs rw 0 0\n"
    )
    assert table == {"/data": "fuse.sshfs", "/my notes": "tmpfs"}


def test_top_prefixes_leave_out_the_root_devices_and_nested_mounts():
    prefixes = ["/", "/dev/", "/data/", "/data/sub/", "/database/", "/a/b/"]
    assert top_prefixes(prefixes) == ["/a/b", "/data", "/database"]


@pytest.mark.asyncio
async def test_ssh_serves_every_prefix_the_session_sees():
    sandbox = FakeSandbox("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert (result.exit_code, await result.stdout_str()) == (0, "ran\n")
    assert [p.split(" 2>")[0] for p in sandbox.pipes] == [
        f"exec sshfs -f -o {SSHFS_OPTIONS} 'mirage:/data' '/data'",
        f"exec sshfs -f -o {SSHFS_OPTIONS} 'mirage:/my notes' '/my notes'",
    ]
    await agent.shell("python3 again.py")
    assert len(sandbox.pipes) == 2
    await ws.close()
    assert sandbox.table == {}


@pytest.mark.asyncio
async def test_a_second_session_is_refused_rather_than_shown_the_first_view():
    sandbox = FakeSandbox("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    other = await ws.session("other")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    result = await other.shell("python3 job.py")
    assert result.exit_code == 1
    assert await result.stderr_str() == (
        "fake: this sandbox shows session agent's view of the workspace; "
        "give session other a sandbox of its own\n"
    )
    await ws.close()


@pytest.mark.asyncio
async def test_a_session_made_again_under_its_id_is_refused():
    sandbox = FakeSandbox("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    await ws.close_session("agent")
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 1
    assert await result.stderr_str() == (
        "fake: this sandbox shows an earlier session agent's view of the "
        "workspace; give session agent a sandbox of its own\n"
    )
    assert len(sandbox.pipes) == 2
    await ws.close()


@pytest.mark.asyncio
async def test_hidden_unserved_mounts_refuse_without_claiming_the_sandbox():
    sandbox = FakeSandbox("ssh")
    ws = workspace(sandbox, hide=["/data", "/my notes"])
    agent = await ws.session("agent", profile="agent")
    other = await ws.session("other")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 126
    assert await result.stderr_str() == "fake: Permission denied\n"
    assert sandbox.pipes == []
    assert (await other.shell("python3 job.py")).exit_code == 0
    assert len(sandbox.pipes) == 2
    await ws.close()


@pytest.mark.asyncio
async def test_a_refused_line_leaves_the_sandbox_free():
    sandbox = FakeSandbox("both", own=["/data", "/my notes"])
    ws = workspace(sandbox, hide=["/data"])
    agent = await ws.session("agent", profile="agent")
    other = await ws.session("other")
    assert (await agent.shell("python3 job.py")).exit_code == 126
    assert (await other.shell("python3 job.py")).exit_code == 0
    await ws.close()


@pytest.mark.asyncio
async def test_both_serves_what_the_sandbox_does_not_mount_itself():
    sandbox = FakeSandbox("both", own=["/data"])
    ws = workspace(sandbox, hide=["/my notes/secret"])
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    assert served(sandbox) == ["/my notes"]
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("mount_type", ["both", "fuse"])
async def test_a_rule_under_a_prefix_the_sandbox_serves_refuses_the_line(
    mount_type,
):
    sandbox = FakeSandbox(mount_type, own=["/data"])
    ws = workspace(sandbox, hide=["/data/secret.csv"])
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 126
    assert await result.stderr_str() == "fake: Permission denied\n"
    assert "python3 job.py" not in sandbox.commands
    await ws.close()


@pytest.mark.asyncio
async def test_a_mount_the_sandbox_makes_later_under_a_rule_refuses_the_line():
    sandbox = FakeSandbox("fuse")
    ws = workspace(sandbox, hide=["/data/secret.csv"])
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 126
    sandbox.table["/data"] = "fuse"
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 126
    assert await result.stderr_str() == "fake: Permission denied\n"
    await ws.close()


@pytest.mark.asyncio
async def test_fuse_serves_nothing_from_the_host_and_takes_any_session():
    sandbox = FakeSandbox("fuse", own=["/data"])
    ws = workspace(sandbox, hide=["/my notes/secret"])
    agent = await ws.session("agent", profile="agent")
    other = await ws.session("other")
    assert (await agent.shell("python3 job.py")).exit_code == 126
    assert (await other.shell("python3 job.py")).exit_code == 0
    assert sandbox.pipes == []
    await ws.close()


@pytest.mark.asyncio
async def test_a_sandbox_without_sshfs_fails_loud():
    sandbox = FakeSandbox("ssh", sshfs=False)
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 1
    assert await result.stderr_str() == (
        "python3: fake: serving the workspace into a sandbox needs sshfs there; "
        "install it in the image (apt-get install sshfs)\n"
    )
    assert sandbox.pipes == []
    await ws.close()


@pytest.mark.asyncio
async def test_a_stale_sshfs_mount_is_dropped_before_serving():
    sandbox = FakeSandbox("ssh")
    sandbox.table["/data"] = "fuse.sshfs"
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    drop = "fusermount3 -uz '/data' || fusermount -uz '/data'"
    assert sandbox.commands.index(drop) < sandbox.commands.index(
        "mkdir -p '/data' 2>/dev/null || { sudo -n mkdir -p '/data' && "
        "sudo -n chown \"$(id -u):$(id -g)\" '/data'; }"
    )
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("mount_type", ["both", "fuse"])
async def test_a_hidden_mount_the_sandbox_serves_refuses_the_line(mount_type):
    sandbox = FakeSandbox(mount_type, own=["/data"])
    ws = workspace(sandbox, hide=["/data"])
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 126
    assert await result.stderr_str() == "fake: Permission denied\n"
    assert result.refusal is not None
    assert result.refusal.reason == (
        "a mount this session restricts is not served through the dispatcher"
    )
    await ws.close()


@pytest.mark.asyncio
async def test_a_mode_cap_on_a_mount_the_sandbox_serves_refuses_the_line():
    sandbox = FakeSandbox("both", own=["/data"])
    ws = workspace(sandbox, modes={"/data/sub": "r"})
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 126
    assert await result.stderr_str() == "fake: Permission denied\n"
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("mount_type", ["both", "fuse"])
async def test_a_shown_read_only_path_on_a_sandbox_owned_mount_refuses(
    mount_type,
):
    sandbox = FakeSandbox(mount_type, own=["/data"])
    ws = workspace(sandbox)
    try:
        agent = await ws.session(
            "agent", profile={"paths": {"show": {"/data/locked": "r"}}}
        )
        result = await agent.shell("python3 job.py")
        assert result.exit_code == 126
        assert await result.stderr_str() == "fake: Permission denied\n"
        assert "python3 job.py" not in sandbox.commands
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_line_with_its_own_cwd_serves_the_live_session(monkeypatch):
    sessions = []

    class Server(Drain):
        async def serve(self, reader, writer):
            sessions.append(self.session)
            await super().serve(reader, writer)

    monkeypatch.setattr(mounts, "PipeServer", Server)
    sandbox = FakeSandbox("ssh")
    ws = workspace(sandbox)
    await ws.session("agent", profile="agent")
    result = await ws.shell("python3 job.py", session_id="agent", cwd="/data")
    assert result.exit_code == 0
    assert len(sessions) == 2
    assert all(s is ws.get_session("agent") for s in sessions)
    await ws.close()


@pytest.mark.asyncio
async def test_a_server_runs_outside_the_line_that_started_it(monkeypatch):
    bound = []

    class Server(Drain):
        async def serve(self, reader, writer):
            bound.append(
                (get_current_session(), get_admission(), line_running())
            )
            await super().serve(reader, writer)

    monkeypatch.setattr(mounts, "PipeServer", Server)
    sandbox = FakeSandbox("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    assert bound == [(None, None, False), (None, None, False)]
    await ws.close()


@pytest.mark.asyncio
async def test_a_line_returns_once_every_server_has_landed(monkeypatch):
    # sshfs sends the close that lands a line's writes after the line has
    # ended, so the line lands them itself, one server at a time, outside
    # the line but with its write admission: a capture waiting for the
    # line lets those writes through. Served requests run on that
    # admission until the line has landed them, the line waits out the
    # ones still running, and none run on it after.
    held = asyncio.Queue()
    landed = []

    class Server(Drain):
        async def sync(self):
            go = asyncio.Event()
            await held.put((go, self))
            await go.wait()
            await self.files.write("/data/landed.txt", b"x")
            landed.append((line_running(), await self.run(lent_a_line())))

    monkeypatch.setattr(mounts, "PipeServer", Server)
    ws = workspace(FakeSandbox("ssh"))
    agent = await ws.session("agent", profile="agent")
    line = asyncio.create_task(agent.shell("python3 job.py"))
    first, server = await asyncio.wait_for(held.get(), 5)
    capture = asyncio.create_task(ws.snapshot(io.BytesIO()))
    while ws._admitting.is_set():
        await asyncio.sleep(0)
    first.set()
    second, _ = await asyncio.wait_for(held.get(), 5)
    assert not line.done()
    still = asyncio.Event()
    borrowed = asyncio.create_task(server.run(still.wait()))
    await asyncio.sleep(0)
    second.set()
    await asyncio.sleep(0.05)
    assert not line.done()
    still.set()
    assert (await asyncio.wait_for(line, 5)).exit_code == 0
    await asyncio.wait_for(capture, 5)
    await borrowed
    assert landed == [(False, True), (False, True)]
    assert not await server.run(lent_a_line())
    await ws.close()


@pytest.mark.asyncio
async def test_a_line_that_times_out_still_lands_its_writes(monkeypatch):
    synced = []

    class Server(Drain):
        async def sync(self):
            synced.append(line_running())

    monkeypatch.setattr(mounts, "PipeServer", Server)
    ws = workspace(
        FakeSandbox("ssh"),
        command_limits={"python3": Limit(timeout_seconds=0.05)},
    )
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 slow.py")).exit_code == 124
    assert synced == [False, False]
    await ws.close()


@pytest.mark.asyncio
async def test_a_mount_of_its_own_under_a_served_prefix_fails_loud():
    sandbox = FakeSandbox("both", own=["/data/sub"])
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 1
    assert await result.stderr_str() == (
        "python3: fake: the sandbox mounts /data/sub itself, and serving /data would "
        "cover it\n"
    )
    assert sandbox.pipes == []
    await ws.close()


@pytest.mark.asyncio
async def test_a_mount_added_later_is_served_on_the_next_line():
    sandbox = FakeSandbox("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    ws.add_mount("/extra", RAMVFS(), mode=MountMode.WRITE)
    assert (await agent.shell("python3 job.py")).exit_code == 0
    assert served(sandbox) == ["/data", "/my notes", "/extra"]
    await ws.close()


@pytest.mark.asyncio
async def test_a_server_that_ended_is_started_again():
    sandbox = FakeSandbox("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    sandbox.requests["/data"].feed_eof()
    for _ in range(5):
        await asyncio.sleep(0)
    assert (await agent.shell("python3 job.py")).exit_code == 0
    assert served(sandbox) == ["/data", "/my notes", "/data"]
    await ws.close()


@pytest.mark.asyncio
async def test_a_failed_unmount_still_stops_its_pipe():
    sandbox = FakeSandbox("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    sandbox.fail_unmount = True
    await ws.close()
    assert sandbox.stopped == ["/data", "/my notes"]


@pytest.mark.asyncio
async def test_a_server_that_fails_says_why(monkeypatch):
    class Server(Drain):
        async def serve(self, reader, writer):
            raise RuntimeError("no server here")

    monkeypatch.setattr(mounts, "PipeServer", Server)
    sandbox = FakeSandbox("ssh", sshfs_mounts=False)
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 1
    assert "the SFTP server failed: no server here" in (
        await result.stderr_str()
    )
    await ws.close()


async def _refused_by_the_cli() -> str:
    return "CLI refused: sandbox is not running"


@pytest.mark.asyncio
async def test_a_failed_mount_keeps_pipe_diagnostics_when_the_guest_is_gone():
    class UnavailableSandbox(FakeSandbox):
        async def exec_line(self, line, stdin, env, cwd):
            if self.pipes and line == "cat /proc/mounts":
                raise RuntimeError("guest unavailable")
            return await super().exec_line(line, stdin, env, cwd)

        async def open_pipe(self, command):
            pipe = await super().open_pipe(command)
            return SandboxPipe(
                pipe.reader,
                pipe.writer,
                pipe.stop,
                _refused_by_the_cli,
            )

    ws = workspace(UnavailableSandbox("ssh", sshfs_mounts=False))
    try:
        result = await ws.shell("python3 job.py")
        assert result.exit_code == 1
        said = await result.stderr_str()
        assert "guest unavailable" in said
        assert "CLI: CLI refused: sandbox is not running" in said
    finally:
        await ws.close()
