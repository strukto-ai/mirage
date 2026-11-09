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
import contextlib
import errno
import io
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.context import (
    current_caller,
    get_admission,
    get_current_session,
    line_running,
)
from mirage.errors.types import QuotaExceededError
from mirage.io.types import materialize
from mirage.machine import mounts
from mirage.machine.constants import (
    MOUNT_GUARD,
    PIPE_SERVER_HINT,
    SSHFS_OPTIONS,
    is_run,
)
from mirage.machine.handle import MachineHandle
from mirage.machine.mixin import PipeTransportMixin
from mirage.machine.mounts import (
    mount_table,
    running_line,
    top_prefixes,
)
from mirage.machine.types import MachinePipe
from mirage.runtime.types import RunResult
from mirage.types import Limit
from tests.fixtures.machine import on


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
        return []


class FakeMachine(MachineHandle, PipeTransportMixin):
    """A sandbox that answers its mount table and takes sshfs pipes."""

    provider = "fake"

    def __init__(self, mount_type, own=(), sshfs=True, sshfs_mounts=True):
        super().__init__("box", config={"mount_type": mount_type})
        self.captures = ["python3"]
        self.table = {prefix: ("tmpfs", "tmpfs") for prefix in own}
        self.running: set[str] = set()
        self.sshfs = sshfs
        self.sshfs_mounts = sshfs_mounts
        self.fail_unmount = False
        self.fail_table = False
        self.fail_check = False
        self.commands: list[str] = []
        self.pipes: list[str] = []
        self.requests: dict[str, asyncio.StreamReader] = {}
        self.stopped: list[str] = []
        self.guards: list[tuple[str, ...]] = []

    async def connect(self) -> None:
        return None

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        if is_run(argv):
            argv = argv[7:]
        if argv[2:3] == (MOUNT_GUARD,):
            checked = await self.run_guard(argv)
            if checked.exit_code != 0:
                return checked
            argv = argv[argv.index("--", 5) + 1 :]
        line = argv[2] if argv[:2] == ("/bin/sh", "-c") else shlex.join(argv)
        data = await materialize(stdin) if stdin is not None else None
        return await self.exec_line(line, data, env, cwd)

    async def exec_line(self, line, stdin, env, cwd):
        self.commands.append(line)
        if line == "cat /proc/mounts" and self.fail_table:
            return RunResult(stdout=b"", stderr=b"gone\n", exit_code=1)
        if line == "cat /proc/mounts":
            return RunResult(
                stdout=self.rows().encode(), stderr=None, exit_code=0
            )
        if line.startswith("cat /proc/[0-9]*/cmdline") and self.fail_check:
            return RunResult(stdout=b"", stderr=b"", exit_code=2)
        if line.startswith("cat /proc/[0-9]*/cmdline"):
            source = next(
                w[2:] for w in shlex.split(line) if w.startswith("S=")
            )
            return RunResult(
                stdout=b"",
                stderr=None,
                exit_code=0 if source in self.running else 1,
            )
        if line == "command -v sshfs":
            return RunResult(
                stdout=b"", stderr=None, exit_code=0 if self.sshfs else 1
            )
        if line == "python3 slow.py":
            await asyncio.Event().wait()
        if line == "python3 fails.py":
            return RunResult(stdout=b"", stderr=b"boom\n", exit_code=3)
        if line.startswith("fusermount3 -uz "):
            if self.fail_unmount:
                raise RuntimeError("the machine went away")
            source, _ = self.table.pop(shlex.split(line)[2], (None, None))
            self.running.discard(source)
        return RunResult(stdout=b"ran\n", stderr=None, exit_code=0)

    def rows(self):
        return "".join(
            f"{escaped(source, '#')} {escaped(p)} {kind} rw 0 0\n"
            for p, (source, kind) in self.table.items()
        )

    async def run_guard(self, argv):
        """Run a line's mount guard through /bin/sh over this table."""
        entries = argv[5 : argv.index("--", 5)]
        self.guards.append(entries)
        fd, path = tempfile.mkstemp()
        with os.fdopen(fd, "w") as table:
            table.write(self.rows())
        try:
            done = await asyncio.create_subprocess_exec(
                *argv[:4],
                path,
                *entries,
                "--",
                "true",
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            out, err = await done.communicate()
        finally:
            os.unlink(path)
        return RunResult(stdout=out, stderr=err, exit_code=done.returncode)

    async def open_pipe(self, command):
        self.pipes.append(command)
        source, prefix = shlex.split(command)[5:7]
        if self.sshfs_mounts:
            self.table[prefix] = (source, "fuse.sshfs")
            self.running.add(source)
        requests = asyncio.StreamReader()
        self.requests[prefix] = requests

        async def stop() -> None:
            self.stopped.append(prefix)
            requests.feed_eof()

        return MachinePipe(requests, Sink(), stop)

    def sshfs_exits(self, prefix):
        """End ``prefix``'s server: its sshfs then unmounts itself."""
        self.requests[prefix].feed_eof()
        source, _ = self.table.pop(prefix)
        self.running.discard(source)


def escaped(text, more=""):
    """``text`` as the kernel writes a mount field: a space, and ``more``,
    as octal escapes."""
    return "".join(f"\\{ord(c):03o}" if c in " " + more else c for c in text)


def sharing(sandbox, mount_type):
    """Another workspace's runtime on the same sandbox."""
    other = FakeMachine(mount_type)
    other.table = sandbox.table
    other.running = sandbox.running
    return other


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
        **on(runtime, "workspace"),
        **options,
    )


LOST = (
    "fake: /data/a.bin: Disk quota exceeded\n"
    "fake: /my notes/b.txt: Disk quota exceeded\n"
)


def served(sandbox):
    return [shlex.split(p)[6] for p in sandbox.pipes]


def test_mount_table_unescapes_paths_and_keeps_the_top_entry():
    table = mount_table(
        "tmpfs /data tmpfs rw 0 0\n"
        "mirage-ab:/data /data fuse.sshfs rw 0 0\n"
        "mirage-ab:/my\\040notes /my\\040notes fuse.sshfs rw 0 0\n"
    )
    assert table == {
        "/data": ("mirage-ab:/data", "fuse.sshfs"),
        "/my notes": ("mirage-ab:/my notes", "fuse.sshfs"),
    }


# A program carrying the source as an argument serves it, as sshfs does;
# a shorter or another source is not it.
@pytest.mark.skipif(not os.path.isdir("/proc/self"), reason="needs /proc")
def test_the_running_line_finds_a_program_carrying_the_source():
    program = subprocess.Popen(
        [
            "/bin/sh",
            "-c",
            "echo ready; while :; do sleep 1; done",
            "sh",
            "mirage-x:/my notes",
            "mirage-x:/new\nline",
        ],
        stdout=subprocess.PIPE,
    )
    assert program.stdout is not None
    try:
        assert program.stdout.readline() == b"ready\n"
        codes = [
            subprocess.run(
                ["/bin/sh", "-c", running_line(source)],
                check=False,
                timeout=10,
            ).returncode
            for source in (
                "mirage-x:/my notes",
                "mirage-x:/new\nline",
                "mirage-x:/my",
                "mirage-x:/new",
                "mirage-y:/data",
            )
        ]
        assert codes == [0, 0, 1, 1, 1]
    finally:
        program.kill()
        program.wait()
        program.stdout.close()


# With no process to read, the line cannot tell rather than answer that
# nothing serves the source.
def test_the_running_line_cannot_tell_without_a_process_list(tmp_path):
    for tool in ("tr", "awk"):
        os.symlink(shutil.which(tool), tmp_path / tool)
    done = subprocess.run(
        ["/bin/sh", "-c", running_line("mirage-x:/data")],
        env={"PATH": str(tmp_path)},
        check=False,
        timeout=10,
    )
    assert done.returncode == 2


def test_top_prefixes_leave_out_the_root_devices_and_nested_mounts():
    prefixes = ["/", "/dev/", "/data/", "/data/sub/", "/database/", "/a/b/"]
    assert top_prefixes(prefixes) == ["/a/b", "/data", "/database"]


@pytest.mark.asyncio
async def test_ssh_serves_every_prefix_the_session_sees():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert (result.exit_code, await result.stdout_str()) == (0, "ran\n")
    name = shlex.split(sandbox.pipes[0])[5].split(":")[0]
    assert re.fullmatch("mirage-[0-9a-f]{32}", name)
    assert [p.split(" 2>")[0] for p in sandbox.pipes] == [
        f"exec sshfs -f -o {SSHFS_OPTIONS} '{name}:/data' '/data'",
        f"exec sshfs -f -o {SSHFS_OPTIONS} '{name}:/my notes' '/my notes'",
    ]
    await agent.shell("python3 again.py")
    assert len(sandbox.pipes) == 2
    await ws.close()
    assert sandbox.table == {}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cwd, ran", [("/notes", False), ("/data", True), ("/", True)]
)
async def test_ssh_refuses_a_line_from_a_cwd_it_cannot_see(cwd, ran):
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    assert (await ws.shell("mkdir -p /notes")).exit_code == 0
    result = await ws.shell(f"cd {cwd} && python3 job.py")
    said = (result.exit_code, await result.stderr_str())
    if ran:
        assert said == (0, "")
    else:
        assert said == (
            126,
            "fake: the machine cannot see the working directory /notes; "
            "cd into a mount first\n",
        )
        assert (sandbox.commands, sandbox.pipes) == ([], [])
        assert sandbox._mounts._lines == []
    await ws.close()


@pytest.mark.asyncio
async def test_a_branch_refused_for_its_cwd_leaves_a_running_branch_admitted():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    assert (await ws.shell("mkdir -p /notes")).exit_code == 0
    line = asyncio.create_task(
        ws.shell("cd /data && python3 slow.py | (cd /notes && python3 job.py)")
    )
    for _ in range(500):
        if "python3 slow.py" in sandbox.commands:
            break
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.2)
    assert len(sandbox._mounts._lines) == 1
    line.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await line
    await ws.close()


@pytest.mark.asyncio
async def test_a_second_session_is_refused_rather_than_shown_the_first_view():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    other = await ws.session("other")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    result = await other.shell("python3 job.py")
    assert result.exit_code == 1
    assert await result.stderr_str() == (
        "fake: this machine shows session agent's view of the workspace; "
        "give session other a machine of its own\n"
    )
    await ws.close()


@pytest.mark.asyncio
async def test_a_session_made_again_under_its_id_is_refused():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    await ws.close_session("agent")
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 1
    assert await result.stderr_str() == (
        "fake: this machine shows an earlier session agent's view of the "
        "workspace; give session agent a machine of its own\n"
    )
    assert len(sandbox.pipes) == 2
    await ws.close()


@pytest.mark.asyncio
async def test_hidden_unserved_mounts_refuse_without_claiming_the_sandbox():
    sandbox = FakeMachine("ssh")
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
    sandbox = FakeMachine("both", own=["/data", "/my notes"])
    ws = workspace(sandbox, hide=["/data"])
    agent = await ws.session("agent", profile="agent")
    other = await ws.session("other")
    assert (await agent.shell("python3 job.py")).exit_code == 126
    assert (await other.shell("python3 job.py")).exit_code == 0
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["tmpfs", "mirage-cache"])
async def test_both_serves_what_the_sandbox_does_not_mount_itself(source):
    sandbox = FakeMachine("both")
    sandbox.table["/data"] = (source, "tmpfs")
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
    sandbox = FakeMachine(mount_type, own=["/data"])
    ws = workspace(sandbox, hide=["/data/secret.csv"])
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 126
    assert await result.stderr_str() == "fake: Permission denied\n"
    assert "python3 job.py" not in sandbox.commands
    await ws.close()


@pytest.mark.asyncio
async def test_a_mount_the_sandbox_makes_later_under_a_rule_refuses_the_line():
    sandbox = FakeMachine("fuse")
    ws = workspace(sandbox, hide=["/data/secret.csv"])
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 126
    sandbox.table["/data"] = ("x", "fuse")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 126
    assert await result.stderr_str() == "fake: Permission denied\n"
    await ws.close()


@pytest.mark.asyncio
async def test_fuse_serves_nothing_from_the_host_and_takes_any_session():
    sandbox = FakeMachine("fuse", own=["/data"])
    ws = workspace(sandbox, hide=["/my notes/secret"])
    agent = await ws.session("agent", profile="agent")
    other = await ws.session("other")
    assert (await agent.shell("python3 job.py")).exit_code == 126
    assert (await other.shell("python3 job.py")).exit_code == 0
    assert sandbox.pipes == []
    await ws.close()


@pytest.mark.asyncio
async def test_a_sandbox_without_sshfs_fails_loud():
    sandbox = FakeMachine("ssh", sshfs=False)
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 1
    assert await result.stderr_str() == (
        "python3: fake: serving the workspace into a machine needs sshfs there; "
        "install it in the image (apt-get install sshfs)\n"
    )
    assert sandbox.pipes == []
    await ws.close()


@pytest.mark.asyncio
async def test_a_dead_sshfs_mount_is_dropped_before_serving():
    sandbox = FakeMachine("ssh")
    sandbox.table["/data"] = ("mirage-gone:/data", "fuse.sshfs")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    drop = "fusermount3 -uz '/data' || fusermount -uz '/data'"
    assert sandbox.commands.index(drop) < sandbox.commands.index(
        "mkdir -p '/data' 2>/dev/null || { sudo -n mkdir -p '/data' && "
        "sudo -n chown \"$(id -u):$(id -g)\" '/data'; }"
    )
    await ws.close()


FOREIGN = (
    "fake: another sshfs serves /data in this machine; "
    "give this workspace a machine of its own\n"
)


@pytest.mark.asyncio
async def test_a_second_workspace_on_the_sandbox_unmounts_nothing():
    first = FakeMachine("ssh")
    second = sharing(first, "ssh")
    ws1, ws2 = workspace(first), workspace(second)
    one = await ws1.session("agent", profile="agent")
    two = await ws2.session("agent", profile="agent")
    assert (await one.shell("python3 job.py")).exit_code == 0
    mounted = dict(first.table)
    result = await two.shell("python3 job.py")
    assert result.exit_code == 1
    assert await result.stderr_str() == FOREIGN
    assert second.pipes == []
    assert first.table == mounted
    assert (await one.shell("python3 job.py")).exit_code == 0
    await ws2.close()
    assert first.table == mounted
    await ws1.close()
    assert first.table == {}


@pytest.mark.asyncio
async def test_dropping_an_ended_server_leaves_the_mount_that_replaced_it():
    first = FakeMachine("ssh")
    second = sharing(first, "ssh")
    ws1, ws2 = workspace(first), workspace(second)
    one = await ws1.session("agent", profile="agent")
    two = await ws2.session("agent", profile="agent")
    assert (await one.shell("python3 job.py")).exit_code == 0
    first.sshfs_exits("/data")
    first.sshfs_exits("/my notes")
    assert (await two.shell("python3 job.py")).exit_code == 0
    mounted = dict(first.table)
    for _ in range(2):
        result = await one.shell("python3 job.py")
        assert result.exit_code == 1
        assert await result.stderr_str() == FOREIGN
    assert first.table == mounted
    await ws1.close()
    assert first.table == mounted
    await ws2.close()


@pytest.mark.asyncio
async def test_a_check_that_fails_leaves_the_next_line_checking():
    first = FakeMachine("ssh")
    second = sharing(first, "ssh")
    ws1, ws2 = workspace(first), workspace(second)
    one = await ws1.session("agent", profile="agent")
    two = await ws2.session("agent", profile="agent")
    assert (await one.shell("python3 job.py")).exit_code == 0
    first.sshfs_exits("/data")
    first.sshfs_exits("/my notes")
    assert (await two.shell("python3 job.py")).exit_code == 0
    first.fail_check = True
    failed = await one.shell("python3 job.py")
    assert failed.exit_code == 1
    assert "cannot tell whether" in await failed.stderr_str()
    first.fail_check = False
    result = await one.shell("python3 job.py")
    assert result.exit_code == 1
    assert await result.stderr_str() == FOREIGN
    await ws1.close()
    await ws2.close()


@pytest.mark.asyncio
async def test_both_takes_no_other_workspaces_sshfs_for_its_own():
    first = FakeMachine("ssh")
    second = sharing(first, "both")
    ws1, ws2 = workspace(first), workspace(second)
    one = await ws1.session("agent", profile="agent")
    two = await ws2.session("agent", profile="agent")
    assert (await one.shell("python3 job.py")).exit_code == 0
    result = await two.shell("python3 job.py")
    assert result.exit_code == 1
    assert await result.stderr_str() == FOREIGN
    await ws2.close()
    await ws1.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("mount_type", ["both", "fuse"])
async def test_a_hidden_mount_the_sandbox_serves_refuses_the_line(mount_type):
    sandbox = FakeMachine(mount_type, own=["/data"])
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
    sandbox = FakeMachine("both", own=["/data"])
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
    sandbox = FakeMachine(mount_type, own=["/data"])
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

    monkeypatch.setattr(mounts, "pipe_server", lambda: Server)
    sandbox = FakeMachine("ssh")
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

    monkeypatch.setattr(mounts, "pipe_server", lambda: Server)
    sandbox = FakeMachine("ssh")
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
    # ones still running, and none run on it after. It lands at its
    # program's exit (held here), and again as it ends.
    held = asyncio.Queue()
    landed = []

    class Server(Drain):
        async def sync(self):
            if len(landed) < 2:
                go = asyncio.Event()
                await held.put((go, self))
                await go.wait()
            await self.files.write("/data/landed.txt", b"x")
            landed.append((line_running(), await self.run(lent_a_line())))
            return []

    monkeypatch.setattr(mounts, "pipe_server", lambda: Server)
    ws = workspace(FakeMachine("ssh"))
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
    assert landed == [(False, True)] * 4
    assert not await server.run(lent_a_line())
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("line", "lost", "status", "stderr"),
    [
        ("python3 job.py", True, 1, LOST),
        ("python3 fails.py", True, 3, "boom\n" + LOST),
        ("python3 job.py", False, 0, ""),
    ],
)
async def test_a_landing_that_fails_fails_the_line_with_its_error(
    monkeypatch, line, lost, status, stderr
):
    # sshfs lands a file's writes after close(2) told the program they
    # were done, so the line reports each landing that failed, on every
    # served prefix, keeping a failing program's own status.
    failures = [
        [("/my notes/b.txt", QuotaExceededError(errno.EDQUOT, ""))],
        [("/data/a.bin", QuotaExceededError(errno.EDQUOT, ""))],
    ]

    class Server(Drain):
        async def sync(self):
            return failures.pop() if lost and failures else []

    monkeypatch.setattr(mounts, "pipe_server", lambda: Server)
    ws = workspace(FakeMachine("ssh"))
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell(line)
    assert (result.exit_code, await result.stderr_str()) == (status, stderr)
    assert (await agent.shell("python3 job.py")).exit_code == 0
    await ws.close()


@pytest.mark.asyncio
async def test_a_line_that_times_out_still_lands_its_writes(
    monkeypatch, caplog
):
    # Its status stays the timeout's; a landing that fails is logged.
    synced = []

    class Server(Drain):
        async def sync(self):
            synced.append(line_running())
            if len(synced) > 1:
                return []
            return [("/data/a.bin", QuotaExceededError(errno.EDQUOT, ""))]

    monkeypatch.setattr(mounts, "pipe_server", lambda: Server)
    ws = workspace(
        FakeMachine("ssh"),
        command_limits={"@line": Limit(timeout_seconds=0.05)},
    )
    agent = await ws.session("agent", profile="agent")
    with caplog.at_level("WARNING"):
        result = await agent.shell("python3 slow.py")
    assert result.exit_code == 124
    assert "Disk quota exceeded" not in await result.stderr_str()
    assert synced == [False, False]
    assert "fake: /data/a.bin: Disk quota exceeded" in caplog.text
    await ws.close()


@pytest.mark.asyncio
async def test_a_landing_the_deadline_stops_logs_what_failed_before_it(
    monkeypatch, caplog
):
    # One prefix's landing failed and the next one ran out the deadline:
    # the line hears of neither, so the failure that came back is logged.
    calls = []

    class Server(Drain):
        async def sync(self):
            calls.append(self)
            if len(calls) == 1:
                return [("/data/a.bin", QuotaExceededError(errno.EDQUOT, ""))]
            if len(calls) == 2:
                await asyncio.sleep(5)
            return []

    monkeypatch.setattr(mounts, "pipe_server", lambda: Server)
    ws = workspace(
        FakeMachine("ssh"),
        command_limits={"@line": Limit(timeout_seconds=0.05)},
    )
    agent = await ws.session("agent", profile="agent")
    with caplog.at_level("WARNING"):
        assert (await agent.shell("python3 job.py")).exit_code == 124
    assert "fake: /data/a.bin: Disk quota exceeded" in caplog.text
    await ws.close()


@pytest.mark.asyncio
async def test_a_landing_stopped_as_a_sync_returns_logs_its_failure(caplog):
    # The stop arrives once the sync has finished, so its failure comes
    # back with the stop instead of the result, and is logged.
    landing: list[asyncio.Task[list[str]]] = []

    class Server(Drain):
        async def sync(self):
            asyncio.get_running_loop().call_soon(landing[0].cancel)
            return [("/data/a.bin", QuotaExceededError(errno.EDQUOT, ""))]

    held = mounts.MachineMounts("fake", "ssh", None, None)
    held._served["/data"] = (None, None, Server(None, None, None))
    landing.append(asyncio.create_task(held.land()))
    with caplog.at_level("WARNING"):
        await asyncio.wait(landing)
    assert landing[0].cancelled()
    assert "fake: /data/a.bin: Disk quota exceeded" in caplog.text


@pytest.mark.asyncio
async def test_a_line_whose_deadline_stops_its_landing_still_lands(
    monkeypatch,
):
    # The landing at the program's exit counts against the line's
    # deadline; one the deadline stops is landed again before the line
    # returns.
    synced = []

    class Server(Drain):
        async def sync(self):
            synced.append(line_running())
            if len(synced) == 1:
                await asyncio.sleep(5)
            return []

    monkeypatch.setattr(mounts, "pipe_server", lambda: Server)
    ws = workspace(
        FakeMachine("ssh"),
        command_limits={"@line": Limit(timeout_seconds=0.05)},
    )
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 124
    assert synced == [False, False, False]
    await ws.close()


@pytest.mark.asyncio
async def test_a_mount_of_its_own_under_a_served_prefix_fails_loud():
    sandbox = FakeMachine("both", own=["/data/sub"])
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 1
    assert await result.stderr_str() == (
        "python3: fake: the machine mounts /data/sub itself, and serving /data would "
        "cover it\n"
    )
    assert sandbox.pipes == []
    await ws.close()


@pytest.mark.asyncio
async def test_a_mount_added_later_is_served_on_the_next_line():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    ws.add_mount("/extra", RAMVFS(), mode=MountMode.WRITE)
    assert (await agent.shell("python3 job.py")).exit_code == 0
    assert served(sandbox) == ["/data", "/my notes", "/extra"]
    await ws.close()


@pytest.mark.asyncio
async def test_a_server_that_ended_is_started_again():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    sandbox.requests["/data"].feed_eof()
    for _ in range(5):
        await asyncio.sleep(0)
    assert (await agent.shell("python3 job.py")).exit_code == 0
    assert served(sandbox) == ["/data", "/my notes", "/data"]
    await ws.close()


def lost(prefix):
    return (
        f"fake: {prefix} is no longer mounted in the machine (did it "
        "restart?); the line did not run\n"
    )


# A restart after the line was admitted took the machine's mounts while
# the host still serves them: the line never runs over the bare
# directories, and the next one serves them again.
@pytest.mark.asyncio
async def test_a_line_over_mounts_the_sandbox_lost_never_runs():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    sandbox.table.clear()
    sandbox.running.clear()
    result = await agent.shell("python3 lost.py")
    assert (result.exit_code, await result.stderr_str()) == (
        126,
        lost("/data"),
    )
    assert "python3 lost.py" not in sandbox.commands
    assert (await agent.shell("python3 job.py")).exit_code == 0
    assert served(sandbox) == ["/data", "/my notes", "/data", "/my notes"]
    await ws.close()


# A mount the machine put over a served prefix is left alone: ending the
# sshfs under it would take it down too.
@pytest.mark.asyncio
async def test_a_mount_over_a_served_prefix_is_left_alone():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    ours = sandbox.table["/data"]
    sandbox.table["/data"] = (ours[0], "fuse")
    first = await agent.shell("python3 covered.py")
    assert (first.exit_code, await first.stderr_str()) == (126, lost("/data"))
    second = await agent.shell("python3 covered.py")
    assert (second.exit_code, await second.stderr_str()) == (
        1,
        "fake: another mount covers /data in this machine; the line did "
        "not run\n",
    )
    assert "python3 covered.py" not in sandbox.commands
    assert sandbox.stopped == []
    assert served(sandbox) == ["/data", "/my notes"]
    sandbox.table["/data"] = ours
    assert (await agent.shell("python3 job.py")).exit_code == 0
    await ws.close()


# The sandbox mounts its own prefix again once it is back (its entrypoint
# does): serving it meanwhile would leave the host's sshfs under that mount.
@pytest.mark.asyncio
@pytest.mark.parametrize("mount_type", ["fuse", "both"])
async def test_lines_wait_for_a_mount_of_the_sandboxs_own_it_lost(mount_type):
    sandbox = FakeMachine(mount_type, own=["/data"])
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    pipes = list(sandbox.pipes)
    del sandbox.table["/data"]
    for _ in range(2):
        result = await agent.shell("python3 lost.py")
        assert (result.exit_code, await result.stderr_str()) == (
            126,
            lost("/data"),
        )
    assert "python3 lost.py" not in sandbox.commands
    assert sandbox.pipes == pipes
    sandbox.table["/data"] = ("tmpfs", "tmpfs")
    assert (await agent.shell("python3 back.py")).exit_code == 0
    assert "python3 back.py" in sandbox.commands
    assert sandbox.pipes == pipes
    await ws.close()


@pytest.mark.asyncio
async def test_a_prefix_with_a_hash_is_served_and_its_lines_run():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    ws.add_mount("/a#b", RAMVFS(), mode=MountMode.WRITE)
    agent = await ws.session("agent", profile="agent")
    for _ in range(2):
        assert (await agent.shell("python3 job.py")).exit_code == 0
    assert "/a#b" in served(sandbox)
    await ws.close()


# Under fuse the mounts are read again on each line until the machine holds
# every prefix, so one it mounts late is guarded too; then once per change.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("own", "reads"), [(["/data", "/my notes"], 1), (["/data"], 3)]
)
async def test_fuse_reads_the_mounts_until_the_sandbox_holds_them_all(
    own, reads
):
    sandbox = FakeMachine("fuse", own=own)
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    for _ in range(3):
        assert (await agent.shell("python3 job.py")).exit_code == 0
    assert sandbox.commands.count("cat /proc/mounts") == reads
    await ws.close()


@pytest.mark.asyncio
async def test_fuse_guards_a_mount_the_sandbox_lays_after_the_first_line():
    sandbox = FakeMachine("fuse")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    sandbox.table["/data"] = ("tmpfs", "tmpfs")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    del sandbox.table["/data"]
    result = await agent.shell("python3 lost.py")
    assert (result.exit_code, await result.stderr_str()) == (
        126,
        lost("/data"),
    )
    assert "python3 lost.py" not in sandbox.commands
    await ws.close()


# A cover over a served prefix whose server ended is left alone too: serving
# again would mount the host's sshfs over the machine's mount.
@pytest.mark.asyncio
async def test_a_cover_over_an_ended_server_is_left_alone():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    sandbox.requests["/data"].feed_eof()
    sandbox.table["/data"] = ("tmpfs", "tmpfs")
    for _ in range(5):
        await asyncio.sleep(0)
    result = await agent.shell("python3 covered.py")
    assert (result.exit_code, await result.stderr_str()) == (
        1,
        "fake: another mount covers /data in this machine; the line did "
        "not run\n",
    )
    assert sandbox.table["/data"] == ("tmpfs", "tmpfs")
    assert served(sandbox) == ["/data", "/my notes"]
    await ws.close()


# A mount the machine held at a prefix before it was served is no cover:
# once the server ends it shows again, and the prefix is served over it.
@pytest.mark.asyncio
async def test_a_prefix_served_over_a_mount_of_the_sandboxs_is_served_again():
    sandbox = FakeMachine("ssh")
    sandbox.table["/data"] = ("vol", "ext4")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    sandbox.requests["/data"].feed_eof()
    sandbox.table["/data"] = ("vol", "ext4")
    for _ in range(5):
        await asyncio.sleep(0)
    assert (await agent.shell("python3 again.py")).exit_code == 0
    assert served(sandbox) == ["/data", "/my notes", "/data"]
    await ws.close()


# While its server still runs, a mount laid over a prefix is a cover even
# when it looks like the one the prefix was served over.
@pytest.mark.asyncio
async def test_a_cover_like_the_mount_under_a_live_server_is_left_alone():
    sandbox = FakeMachine("ssh")
    sandbox.table["/data"] = ("tmpfs", "tmpfs")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    sandbox.table["/data"] = ("tmpfs", "tmpfs")
    first = await agent.shell("python3 covered.py")
    assert (first.exit_code, await first.stderr_str()) == (126, lost("/data"))
    second = await agent.shell("python3 covered.py")
    assert second.exit_code == 1
    assert sandbox.stopped == []
    assert served(sandbox) == ["/data", "/my notes"]
    await ws.close()


# A covered prefix the workspace no longer mounts is dropped, not refused.
@pytest.mark.asyncio
async def test_a_covered_prefix_the_workspace_dropped_is_not_refused():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    sandbox.table["/my notes"] = (sandbox.table["/my notes"][0], "fuse")
    await ws.unmount("/my notes")
    for _ in range(2):
        assert (await agent.shell("python3 job.py")).exit_code == 0
    await ws.close()


# A mount the workspace dropped is no longer the machine's to wait for, and
# one added again at that prefix starts afresh.
@pytest.mark.asyncio
@pytest.mark.parametrize("mount_type", ["fuse", "both"])
async def test_a_mount_the_workspace_dropped_is_not_waited_for(mount_type):
    sandbox = FakeMachine(mount_type, own=["/my notes"])
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    del sandbox.table["/my notes"]
    await ws.unmount("/my notes")
    assert (await agent.shell("python3 gone.py")).exit_code == 0
    ws.add_mount("/my notes", RAMVFS(), mode=MountMode.WRITE)
    assert (await agent.shell("python3 again.py")).exit_code == 0
    await ws.close()


@pytest.mark.asyncio
async def test_a_sandbox_holding_no_mount_runs_its_lines_unguarded():
    sandbox = FakeMachine("fuse")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    assert sandbox.guards == []
    await ws.close()


@pytest.mark.asyncio
async def test_a_failed_unmount_still_stops_its_pipe():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    sandbox.fail_unmount = True
    await ws.close()
    assert sandbox.stopped == ["/data", "/my notes"]


@pytest.mark.asyncio
async def test_close_unmounts_when_the_mount_table_cannot_be_read():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    sandbox.fail_table = True
    await ws.close()
    assert sandbox.table == {}
    assert sandbox.stopped == ["/data", "/my notes"]


@pytest.mark.asyncio
async def test_a_server_that_fails_says_why(monkeypatch):
    class Server(Drain):
        async def serve(self, reader, writer):
            raise RuntimeError("no server here")

    monkeypatch.setattr(mounts, "pipe_server", lambda: Server)
    sandbox = FakeMachine("ssh", sshfs_mounts=False)
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 1
    assert "the SFTP server failed: no server here" in (
        await result.stderr_str()
    )
    await ws.close()


async def _refused_by_the_cli() -> str:
    return "msb refused: sandbox is not running"


@pytest.mark.asyncio
async def test_a_failed_mount_keeps_pipe_diagnostics_when_the_guest_is_gone():
    class UnavailableMachine(FakeMachine):
        async def exec_line(self, line, stdin, env, cwd):
            if self.pipes and line == "cat /proc/mounts":
                raise RuntimeError("guest unavailable")
            return await super().exec_line(line, stdin, env, cwd)

        async def open_pipe(self, command):
            pipe = await super().open_pipe(command)
            return MachinePipe(
                pipe.reader,
                pipe.writer,
                pipe.stop,
                _refused_by_the_cli,
            )

    ws = workspace(UnavailableMachine("ssh", sshfs_mounts=False))
    try:
        result = await ws.shell("python3 job.py")
        assert result.exit_code == 1
        said = await result.stderr_str()
        assert "guest unavailable" in said
        assert "helper said: msb refused: sandbox is not running" in said
    finally:
        await ws.close()


def test_a_missing_ssh_extra_says_how_to_install_it(monkeypatch):
    monkeypatch.setitem(sys.modules, "asyncssh", None)
    monkeypatch.delitem(sys.modules, "mirage.mount.sftp", raising=False)
    with pytest.raises(ImportError, match=r"mirage-ai\[ssh\]") as raised:
        mounts.pipe_server()
    assert str(raised.value) == PIPE_SERVER_HINT


def test_a_broken_sftp_module_is_not_blamed_on_the_extra(monkeypatch):
    monkeypatch.setitem(sys.modules, "mirage.mount.sftp", None)
    with pytest.raises(ImportError) as raised:
        mounts.pipe_server()
    assert str(raised.value) != PIPE_SERVER_HINT
