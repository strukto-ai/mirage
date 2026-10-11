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
import shlex

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.runtime.sandbox.base import RemoteSandbox
from mirage.runtime.sandbox.constants import SSHFS_OPTIONS
from mirage.runtime.sandbox.mounts import mount_table, top_prefixes
from mirage.runtime.types import RunResult, SandboxPipe


class Feed:
    def __init__(self, reader: asyncio.StreamReader) -> None:
        self.reader = reader

    def write(self, data: bytes) -> None:
        self.reader.feed_data(data)

    def write_eof(self) -> None:
        self.reader.feed_eof()

    def close(self) -> None:
        self.reader.feed_eof()


class FakeSandbox(RemoteSandbox):
    """A sandbox that answers its mount table and takes sshfs pipes."""

    name = "fake"

    def __init__(self, mount_type, own=(), sshfs=True):
        super().__init__(captures=["python3"])
        self.serve_mounts(mount_type)
        self.table = {prefix: "tmpfs" for prefix in own}
        self.sshfs = sshfs
        self.commands: list[str] = []
        self.pipes: list[str] = []

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
        if line.startswith("fusermount3 -uz "):
            self.table.pop(shlex.split(line)[2], None)
        return RunResult(stdout=b"ran\n", stderr=None, exit_code=0)

    async def open_pipe(self, command):
        self.pipes.append(command)
        self.table[shlex.split(command)[6]] = "fuse.sshfs"
        requests = asyncio.StreamReader()

        async def stop() -> None:
            requests.feed_eof()

        return SandboxPipe(requests, Feed(asyncio.StreamReader()), stop)


def workspace(runtime, hide=()):
    return Workspace(
        {
            "/": RAMVFS(),
            "/data": RAMVFS(),
            "/data/sub": RAMVFS(),
            "/my notes": RAMVFS(),
        },
        mode=MountMode.WRITE,
        profiles={"agent": {"paths": {"hide": list(hide)}}},
        runtimes=[runtime, "workspace"],
    )


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
async def test_both_serves_what_the_sandbox_does_not_mount_itself():
    sandbox = FakeSandbox("both", own=["/data"])
    ws = workspace(sandbox, hide=["/my notes/secret"])
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    assert [shlex.split(p)[6] for p in sandbox.pipes] == ["/my notes"]
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
    assert result.exit_code == 1
    assert await result.stderr_str() == (
        "fake: /data is served by the sandbox itself, out of reach of this "
        "session's rules\n"
    )
    assert "python3 job.py" not in sandbox.commands
    await ws.close()


@pytest.mark.asyncio
async def test_a_sandbox_served_nothing_takes_any_session():
    sandbox = FakeSandbox("fuse", own=["/data"])
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    other = await ws.session("other")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    assert (await other.shell("python3 job.py")).exit_code == 0
    await ws.close()


@pytest.mark.asyncio
async def test_fuse_serves_nothing_from_the_host():
    sandbox = FakeSandbox("fuse", own=["/data"])
    ws = workspace(sandbox, hide=["/my notes/secret"])
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
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
        "fake: serving the workspace into a sandbox needs sshfs there; "
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
