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
import json
import os
import re
import shlex
import shutil
import struct
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
from mirage.core.posix.constants import FIND
from mirage.errors.types import QuotaExceededError
from mirage.io.types import materialize
from mirage.machine import mounts
from mirage.machine.constants import (
    DARWIN_ADMIN_STATUS,
    DARWIN_MOUNT_GUARD,
    DARWIN_PATH,
    DARWIN_POINT_MARK,
    MIRAGE_FUSE_LINE,
    MOUNT_GUARD,
    PIPE_SERVER_HINT,
    RUN_PROGRAM_AT,
    SSHFS_HINT,
    SSHFS_LINE,
    SSHFS_LINKS_OPTION,
    SSHFS_OPTIONS,
    is_run,
)
from mirage.machine.handle import MachineHandle
from mirage.machine.mixin import PipeTransportMixin
from mirage.machine.mounts import (
    darwin_admin_hint,
    darwin_left,
    darwin_mount_table,
    darwin_table_line,
    kill_line,
    mirage_source,
    mount_table,
    running_line,
    served_prefixes,
    source_name,
    sshfs_line,
    top_prefixes,
)
from mirage.machine.types import MachinePipe
from mirage.mount.changes import SERVED_BY
from mirage.mount.fsproto import encode_frame
from mirage.runtime.types import RunAnswer, RunResult
from mirage.types import Limit
from mirage.utils.clock import ManualClock
from tests.fixtures.machine import on


class Sink:
    def write(self, data: bytes) -> None:
        return None

    def close(self) -> None:
        return None


class Barriers(Sink):
    """A mirage-fuse end that answers each barrier its server sends."""

    def __init__(self, requests: asyncio.StreamReader) -> None:
        self.requests = requests
        self.got = b""
        self.done = False

    def close(self) -> None:
        self.done = True

    def write(self, data: bytes) -> None:
        self.got += data
        while not self.done and len(self.got) >= 4:
            (total,) = struct.unpack(">I", self.got[:4])
            if len(self.got) < 4 + total:
                return
            frame, self.got = self.got[4 : 4 + total], self.got[4 + total :]
            (length,) = struct.unpack(">I", frame[:4])
            head = json.loads(frame[4 : 4 + length])
            if head.get("op") == "begin":
                self.requests.feed_data(encode_frame({"hid": head["hid"]}))


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

    def __init__(
        self, mount_type, own=(), sshfs=True, sshfs_mounts=True, name="box"
    ):
        super().__init__(name, config={"mount_type": mount_type})
        self.captures = ["python3"]
        self.table = {prefix: ("tmpfs", "tmpfs") for prefix in own}
        self.running: set[str] = set()
        self.sshfs = sshfs
        self.sshfs_mounts = sshfs_mounts
        self.fail_unmount = False
        self.refuse_unmount = False
        self.fail_table = False
        self.fail_check = False
        self.fail_kill = False
        self.hang_kill = False
        # Kills that never answered and were let go.
        self.kills_stopped = 0
        self.commands: list[str] = []
        self.pipes: list[str] = []
        self.ends: dict[str, Sink] = {}
        self.requests: dict[str, asyncio.StreamReader] = {}
        self.stopped: list[str] = []
        self.guards: list[tuple[str, ...]] = []
        # How long the kill line takes to land.
        self.kill_seconds = 0.0

    async def connect(self) -> None:
        return None

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        done = await self._answer(argv, stdin, env, cwd)
        if done.stdout:
            await output(done.stdout)
        if done.stderr:
            await errors(done.stderr)
        return RunResult(exit_code=done.exit_code)

    async def _answer(self, argv, stdin, env, cwd) -> RunAnswer:
        if is_run(argv):
            argv = argv[RUN_PROGRAM_AT:]
        if argv[2:3] == (MOUNT_GUARD,):
            checked = await self.run_guard(argv)
            if checked.exit_code != 0:
                return checked
            argv = argv[argv.index("--", 5) + 1 :]
        line = argv[2] if argv[:2] == ("/bin/sh", "-c") else shlex.join(argv)
        data = await materialize(stdin) if stdin is not None else None
        return await self.exec_line(line, data, env, cwd)

    async def exec_line(
        self, line, stdin, env, cwd, *, bounded=False
    ) -> RunAnswer:
        self.commands.append(line)
        if line.startswith(FIND + " "):
            return RunAnswer(0, b"d 1777 4096 0 0 0 0 2 8 \0")
        if line == "cat /proc/mounts" and self.fail_table:
            return RunAnswer(1, b"", b"gone\n")
        if line == "cat /proc/mounts":
            await asyncio.sleep(0)
            return RunAnswer(0, self.rows().encode())
        if line.startswith("for p in /proc/[0-9]*") and self.kill_seconds:
            await asyncio.sleep(self.kill_seconds)
        if line.startswith("for p in /proc/[0-9]*") and self.hang_kill:
            try:
                await asyncio.Event().wait()
            finally:
                self.kills_stopped += 1
        if line.startswith("for p in /proc/[0-9]*") and self.fail_kill:
            raise RuntimeError("the machine went away")
        if line.startswith("for p in /proc/[0-9]*"):
            self.running.discard(
                next(w[2:] for w in shlex.split(line) if w.startswith("S="))
            )
        if line.startswith("cat /proc/[0-9]*/cmdline") and self.fail_check:
            return RunAnswer(2)
        if line.startswith("cat /proc/[0-9]*/cmdline"):
            source = next(
                w[2:] for w in shlex.split(line) if w.startswith("S=")
            )
            return RunAnswer(0 if source in self.running else 1)
        if line.startswith("d=$(PATH="):
            return RunAnswer(0, b"/home/u/.mirage")
        if line in (SSHFS_LINE, MIRAGE_FUSE_LINE):
            return RunAnswer(0 if self.sshfs else 1)
        if line == "python3 slow.py":
            await asyncio.Event().wait()
        if line == "python3 fails.py":
            return RunAnswer(3, b"", b"boom\n")
        if line.startswith("fusermount3 -uz "):
            if self.fail_unmount:
                raise RuntimeError("the machine went away")
            if self.refuse_unmount:
                return RunAnswer(1, b"", b"fusermount: busy\n")
            source, _ = self.table.pop(shlex.split(line)[2], (None, None))
            self.running.discard(source)
        return RunAnswer(0, b"ran\n")

    def rows(self):
        return "".join(
            f"{escaped(source, '#')} {escaped(p)} {kind} rw 0 0\n"
            for p, (source, kind) in self.table.items()
        )

    async def run_guard(self, argv):
        """Run a line's mount guard through /bin/sh over this table."""
        entries = argv[8 : argv.index("--", 8)]
        self.guards.append(entries)
        fd, path = tempfile.mkstemp()
        with os.fdopen(fd, "w") as table:
            table.write(self.rows())
        try:
            done = await asyncio.create_subprocess_exec(
                *argv[:7],
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
        return RunAnswer(done.returncode, out, err)

    async def open_pipe(self, command):
        self.pipes.append(command)
        source, prefix = sshfs_mount(command)
        if self.sshfs_mounts:
            kind = "fuse.mirage" if " serve " in command else "fuse.sshfs"
            self.table[prefix] = (source, kind)
            self.running.add(source)
        requests = asyncio.StreamReader()
        self.requests[prefix] = requests
        writer = Barriers(requests) if " serve " in command else Sink()
        self.ends[prefix] = writer

        async def stop() -> None:
            self.stopped.append(prefix)
            writer.close()
            requests.feed_eof()

        return MachinePipe(requests, writer, stop)

    def sshfs_exits(self, prefix):
        """End ``prefix``'s server: its sshfs then unmounts itself."""
        self.ends[prefix].close()
        self.requests[prefix].feed_eof()
        source, _ = self.table.pop(prefix)
        self.running.discard(source)


class FakeMac(FakeMachine):
    """A Mac: no ``/proc``, a table ``mount`` prints at each mount's real
    path, and a root folder only where a link in ``/etc/synthetic.conf``
    leads it into Mirage's folder (``linked``)."""

    def __init__(self, mount_type, linked=(), **options):
        super().__init__(mount_type, **options)
        self.linked = set(linked)

    def real(self, prefix):
        if prefix in self.linked:
            return f"/home/u/.mirage/mnt{prefix}"
        return prefix

    def mount_rows(self):
        return "".join(
            f"{source} on {point} ({kind}, nodev, nosuid)\n"
            for point, (source, kind) in self.table.items()
        )

    async def _answer(self, argv, stdin, env, cwd) -> RunAnswer:
        if is_run(argv):
            argv = argv[RUN_PROGRAM_AT:]
        if argv[2:3] == (DARWIN_MOUNT_GUARD,):
            checked = await self.run_mac_guard(argv)
            if checked.exit_code != 0:
                return checked
            argv = argv[argv.index("--", 5) + 1 :]
        return await super()._answer(argv, stdin, env, cwd)

    async def exec_line(
        self, line, stdin, env, cwd, *, bounded=False
    ) -> RunAnswer:
        if line == "uname -s":
            self.commands.append(line)
            return RunAnswer(0, b"Darwin\n")
        if line.startswith(f"PATH={DARWIN_PATH}; mount || exit 1;"):
            self.commands.append(line)
            words = line.split("for p in ", 1)[1].split("; do", 1)[0]
            points = "".join(
                f"{DARWIN_POINT_MARK}{p}\t{self.real(p)}\n"
                for p in shlex.split(words)
            )
            return RunAnswer(0, (self.mount_rows() + points).encode())
        if line.startswith(f"PATH={DARWIN_PATH}; p="):
            self.commands.append(line)
            prefix = shlex.split(line)[1][2:-1]
            if prefix.count("/") == 1 and prefix not in self.linked:
                return RunAnswer(DARWIN_ADMIN_STATUS)
            return RunAnswer(0, f"{self.real(prefix)}\n".encode())
        if line.startswith("umount -f "):
            self.commands.append(line)
            source, _ = self.table.pop(shlex.split(line)[2], (None, None))
            self.running.discard(source)
            return RunAnswer(0)
        return await super().exec_line(line, stdin, env, cwd, bounded=bounded)

    async def open_pipe(self, command):
        pipe = await super().open_pipe(command)
        source, point = sshfs_mount(command)
        if point in self.table:
            self.table[point] = (source, "macfuse")
        return pipe

    async def run_mac_guard(self, argv):
        """Run a line's Mac mount guard through /bin/sh, its ``mount``
        printing this table."""
        entries = argv[8 : argv.index("--", 8)]
        self.guards.append(entries)
        fd, path = tempfile.mkstemp()
        with os.fdopen(fd, "w") as script:
            script.write(
                f"#!/bin/sh\nprintf '%s' {shlex.quote(self.mount_rows())}\n"
            )
        os.chmod(path, 0o755)
        try:
            done = await asyncio.create_subprocess_exec(
                argv[0],
                argv[1],
                argv[2].replace("/sbin/mount", path),
                *argv[3:8],
                *entries,
                "--",
                "true",
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            out, err = await done.communicate()
        finally:
            os.unlink(path)
        return RunAnswer(done.returncode, out, err)


def escaped(text, more=""):
    """``text`` as the kernel writes a mount field: a space, and ``more``,
    as octal escapes."""
    return "".join(f"\\{ord(c):03o}" if c in " " + more else c for c in text)


def sharing(sandbox, mount_type, name="box"):
    """Another workspace's runtime on the same sandbox."""
    other = FakeMachine(mount_type, name=name)
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
        **on(runtime),
        **options,
    )


LOST = (
    "fake: /data/a.bin: Disk quota exceeded\n"
    "fake: /my notes/b.txt: Disk quota exceeded\n"
)


def sshfs_mount(command):
    """The source and mountpoint an sshfs or mirage-fuse pipe command
    names."""
    words = shlex.split(command)
    at = words.index("exec")
    if words[at + 2] == "serve":
        return words[at + 3], words[at + 4]
    return words[at + 5], words[at + 6]


def served(sandbox):
    return [sshfs_mount(p)[1] for p in sandbox.pipes]


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


def test_a_macs_mount_table_names_each_prefix_by_its_real_path():
    rows, points = darwin_mount_table(
        "/dev/disk3s1 on / (apfs, local, read-only, journaled)\n"
        "src-1:/data on /home/u/.mirage/mnt/data (macfuse, nodev, nosuid, "
        "synchronous, nobrowse, mounted by u)\n"
        "src-1:/a on /b on /a on /b (macfuse, nodev, mounted by u)\n"
        f"{DARWIN_POINT_MARK}/data\t/home/u/.mirage/mnt/data\n"
        f"{DARWIN_POINT_MARK}/notes\t/notes\n",
        {"/a on /b": "/a on /b"},
    )
    assert rows == {
        "/data": ("src-1:/data", "macfuse"),
        "/a on /b": ("src-1:/a on /b", "macfuse"),
    }
    assert points == {
        "/data": "/home/u/.mirage/mnt/data",
        "/notes": "/notes",
        "/a on /b": "/a on /b",
    }


@pytest.mark.skipif(sys.platform != "darwin", reason="reads a Mac's mount")
def test_a_macs_table_line_follows_a_link_to_its_real_path(tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "link").symlink_to(real)
    done = subprocess.run(
        ["/bin/sh", "-c", darwin_table_line([f"{tmp_path}/link/ws"])],
        capture_output=True,
        text=True,
    )
    _, points = darwin_mount_table(done.stdout, {})
    assert points == {f"{tmp_path}/link/ws": f"{real.resolve()}/ws"}


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


# It kills each program carrying the source as an argument, as sshfs does,
# and no program carrying a shorter or another source, nor itself.
@pytest.mark.skipif(not os.path.exists("/proc/self"), reason="needs /proc")
def test_the_kill_line_kills_only_a_program_carrying_the_source():
    programs = [
        subprocess.Popen(
            [
                "/bin/sh",
                "-c",
                "echo ready; while :; do sleep 1; done",
                "sh",
                source,
            ],
            stdout=subprocess.PIPE,
        )
        for source in (
            "mirage-x:/my notes",
            "mirage-x:/my",
            "mirage-y:/my notes",
        )
    ]
    try:
        for program in programs:
            assert program.stdout is not None
            assert program.stdout.readline() == b"ready\n"
        done = subprocess.run(
            ["/bin/sh", "-c", kill_line("mirage-x:/my notes")],
            check=False,
            timeout=10,
        )
        assert done.returncode == 0
        programs[0].wait(timeout=10)
        assert [p.poll() for p in programs] == [-9, None, None]
    finally:
        for program in programs:
            program.kill()
            program.wait()
            assert program.stdout is not None
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


def test_a_source_name_escapes_what_no_two_workspace_ids_may_share():
    assert source_name("w1-2", "box") == "mirage-w1-2.box"
    assert [
        source_name("a.b", "m"),
        source_name("a_b", "m"),
        source_name("a", "b.m"),
    ] == ["mirage-a_2eb.m", "mirage-a_5fb.m", "mirage-a.b_2em"]
    assert source_name("a:é", "box") == "mirage-a_3a_c3_a9.box"


def test_top_prefixes_leave_out_the_root_devices_and_nested_mounts():
    prefixes = ["/", "/dev/", "/data/", "/data/sub/", "/database/", "/a/b/"]
    assert top_prefixes(prefixes) == ["/a/b", "/data", "/database"]


def test_served_prefixes_leave_out_what_the_machine_holds_itself():
    prefixes = ["/", "/dev/", "/tmp/", "/tmp/cache/", "/data/", "/data/sub/"]
    assert served_prefixes(prefixes, ["/tmp/"]) == ["/data", "/tmp/cache"]
    assert served_prefixes(prefixes) == ["/data", "/tmp"]


FAKE_SSHFS = """#!/bin/sh
if [ "$1" = -h ]; then
    echo "usage: sshfs [user@]host:[dir] mountpoint [options]"
    [ -n "$NAMES_IT" ] && echo "    -o {option} allow all symlink targets"
    exit 0
fi
printf '%s\\n' "$@"
cat
"""


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("names_it", "options"),
    [
        ("1", f"{SSHFS_OPTIONS},{SSHFS_LINKS_OPTION}"),
        ("", SSHFS_OPTIONS),
    ],
)
async def test_sshfs_passes_every_link_target_when_it_knows_how(
    tmp_path, names_it, options
):
    fake = tmp_path / "sshfs"
    fake.write_text(FAKE_SSHFS.format(option=SSHFS_LINKS_OPTION))
    fake.chmod(0o755)
    log = tmp_path / "sshfs.log"
    done = await asyncio.create_subprocess_exec(
        "/bin/sh",
        "-c",
        sshfs_line("mirage-w:/my notes", "/my notes", str(log)),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        env={
            **os.environ,
            "PATH": f"{tmp_path}:{os.environ['PATH']}",
            "NAMES_IT": names_it,
        },
    )
    out, _ = await done.communicate(b"sftp stream")
    assert (done.returncode, out.decode().splitlines()) == (
        0,
        [
            "-f",
            "-o",
            f"{options},uid={os.getuid()},gid={os.getgid()}",
            "mirage-w:/my notes",
            "/my notes",
            "sftp stream",
        ],
    )


@pytest.mark.asyncio
async def test_ssh_serves_every_prefix_the_session_sees():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert (result.exit_code, await result.stdout_str()) == (0, "ran\n")
    name = source_name(ws.workspace_id, "box")
    pipes = [p.rsplit(" 2>", 1)[0] for p in sandbox.pipes]
    found = re.search(r"-([0-9a-f]{8})-1:/data'", pipes[0])
    instance = found.group(1) if found else ""
    assert pipes == [
        sshfs_line(f"{name}-{instance}-1:/data", "/data", "").rsplit(" 2>", 1)[
            0
        ],
        sshfs_line(f"{name}-{instance}-2:/my notes", "/my notes", "").rsplit(
            " 2>", 1
        )[0],
    ]
    await agent.shell("python3 again.py")
    assert len(sandbox.pipes) == 2
    await ws.close()
    assert sandbox.table == {}


@pytest.mark.asyncio
async def test_ssh_leaves_the_machine_its_own_tmp():
    sandbox = FakeMachine("ssh")
    ws = Workspace(
        {"/": RAMVFS(), "/data": RAMVFS()},
        mode=MountMode.WRITE,
        **on(sandbox),
    )
    assert (await ws.shell("python3 job.py")).exit_code == 0
    assert served(sandbox) == ["/data"]
    from_tmp = await ws.shell("cd /tmp && python3 job.py")
    assert (from_tmp.exit_code, await from_tmp.stdout_str()) == (0, "ran\n")
    await ws.close()


@pytest.mark.asyncio
async def test_ssh_serves_a_tmp_the_workspace_mounts_itself():
    sandbox = FakeMachine("ssh")
    ws = Workspace(
        {"/": RAMVFS(), "/data": RAMVFS(), "/tmp": RAMVFS()},
        mode=MountMode.WRITE,
        **on(sandbox),
    )
    assert (await ws.shell("python3 job.py")).exit_code == 0
    assert served(sandbox) == ["/data", "/tmp"]
    await ws.close()


@pytest.mark.asyncio
async def test_ssh_refuses_a_line_while_the_session_restricts_tmp():
    sandbox = FakeMachine("ssh")
    ws = Workspace(
        {"/": RAMVFS(), "/data": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={"agent": {"paths": {"hide": ["/tmp/secret"]}}},
        **on(sandbox),
    )
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 126
    assert result.decision is not None
    assert result.decision.reason == (
        "a mount this session restricts is not served through the dispatcher"
    )
    await ws.close()


@pytest.mark.asyncio
async def test_ssh_leaves_a_file_mounted_at_its_own_path_off_the_machine():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    await ws.vfs_md("/VFS.md")
    result = await ws.shell("python3 job.py")
    assert (result.exit_code, await result.stdout_str()) == (0, "ran\n")
    assert served(sandbox) == [
        "/data",
        "/my notes",
    ]
    await ws.close()


@pytest.mark.asyncio
async def test_ssh_serves_a_directory_mounted_where_a_file_was():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    await ws.vfs_md("/asset")
    assert (await ws.shell("python3 job.py")).exit_code == 0
    assert served(sandbox) == ["/data", "/my notes"]
    await ws.unmount("/asset")
    ws.add_mount("/asset", RAMVFS(), MountMode.WRITE)
    assert (await ws.shell("python3 job.py")).exit_code == 0
    assert served(sandbox) == ["/data", "/my notes", "/asset"]
    await ws.close()


@pytest.mark.asyncio
async def test_both_runs_a_line_on_its_own_prefix_the_workspace_cannot_stat():
    sandbox = FakeMachine("both", ["/data"])
    gone = RAMVFS()

    async def stat(path):
        raise FileNotFoundError(
            errno.ENOENT, os.strerror(errno.ENOENT), path.virtual
        )

    gone.stat = stat
    ws = Workspace(
        {"/": RAMVFS(), "/data": gone, "/my notes": RAMVFS()},
        mode=MountMode.WRITE,
        **on(sandbox),
    )
    assert (await ws.shell("python3 job.py")).exit_code == 0
    assert served(sandbox) == ["/my notes"]
    await ws.close()


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
async def test_sessions_with_one_view_share_the_machine():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    first = await ws.session("first", profile="agent")
    second = await ws.session("second", profile="agent")
    assert (await first.shell("python3 job.py")).exit_code == 0
    pipes = list(sandbox.pipes)
    result = await second.shell("python3 job.py")
    assert (result.exit_code, await result.stderr_str()) == (0, "")
    assert sandbox.pipes == pipes
    await ws.close()


@pytest.mark.asyncio
async def test_the_machine_keeps_the_view_of_the_session_it_first_served():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    first = await ws.session("first", profile="agent")
    second = await ws.session("second", profile="agent")
    assert (await first.shell("python3 job.py")).exit_code == 0
    assert (await second.shell("python3 job.py")).exit_code == 0
    await ws.set_session_profile("second", None)
    moved = await second.shell("python3 job.py")
    assert (moved.exit_code, await moved.stderr_str()) == (
        1,
        "fake: this machine shows session first's view of the workspace; "
        "give session second a machine of its own\n",
    )
    assert (await first.shell("python3 job.py")).exit_code == 0
    await ws.close()


@pytest.mark.asyncio
async def test_sessions_share_whatever_order_their_mounts_were_listed_in():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    first = await ws.session(
        "first", mounts={"/data": "read", "/my notes": "read"}
    )
    second = await ws.session(
        "second", mounts={"/my notes": "read", "/data": "read"}
    )
    assert (await first.shell("python3 job.py")).exit_code == 0
    result = await second.shell("python3 job.py")
    assert (result.exit_code, await result.stderr_str()) == (0, "")
    await ws.close()


@pytest.mark.asyncio
async def test_a_session_made_again_under_its_view_shares_the_machine():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    await ws.close_session("agent")
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert (result.exit_code, await result.stderr_str()) == (0, "")
    await ws.close()


@pytest.mark.asyncio
async def test_a_session_made_again_under_another_view_is_refused():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    await ws.close_session("agent")
    agent = await ws.session("agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 1
    assert await result.stderr_str() == (
        "fake: this machine shows an earlier session agent's view of the "
        "workspace; give session agent a machine of its own\n"
    )
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
@pytest.mark.parametrize("mount_type", ["both", "own"])
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
    sandbox = FakeMachine("own")
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
    sandbox = FakeMachine("own", own=["/data"])
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
    assert await result.stderr_str() == (f"python3: fake: {SSHFS_HINT}\n")
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
async def test_a_restarted_workspace_takes_back_the_sshfs_it_left():
    first = FakeMachine("ssh")
    one = await workspace(first, workspace_id="w 1").session(
        "agent", profile="agent"
    )
    assert (await one.shell("python3 job.py")).exit_code == 0
    stale = first.table["/data"][0]
    assert re.fullmatch(r"mirage-w_201\.box-[0-9a-f]{8}-1:/data", stale)
    # The host restarted: the first instance never closes, and its sshfs runs on.
    second = sharing(first, "ssh")
    ws = workspace(second, workspace_id="w 1")
    two = await ws.session("agent", profile="agent")
    assert (await two.shell("python3 job.py")).exit_code == 0
    killed = second.commands.index(kill_line(stale))
    assert killed < second.commands.index(
        "fusermount3 -uz '/data' || fusermount -uz '/data'"
    )
    assert served(second) == ["/data", "/my notes"]
    # A kill the first instance started as it went lands late: it reaches
    # the sshfs it named, not the one the second serves the prefix with.
    fresh = second.table["/data"][0]
    assert fresh != stale
    await first.exec_line(kill_line(stale), None, None, None)
    assert fresh in second.running
    await ws.close()
    assert first.table == {}


@pytest.mark.asyncio
async def test_a_mount_a_restarted_instance_left_that_will_not_unmount_fails():
    sandbox = FakeMachine("ssh")
    sandbox.table["/data"] = ("mirage-w1.box-0123abcd-1:/data", "fuse.sshfs")
    sandbox.refuse_unmount = True
    ws = workspace(sandbox, workspace_id="w1")
    result = await (await ws.session("agent", profile="agent")).shell(
        "python3 job.py"
    )
    assert (result.exit_code, await result.stderr_str()) == (
        1,
        "python3: fake: cannot unmount /data, which this workspace served "
        "before a restart: fusermount: busy\n",
    )
    assert sandbox.pipes == []


@pytest.mark.asyncio
async def test_a_deleted_workspace_releases_the_mounts_it_left():
    first = FakeMachine("ssh")
    one = await workspace(first, workspace_id="w1").session(
        "agent", profile="agent"
    )
    assert (await one.shell("python3 job.py")).exit_code == 0
    left = [source for source, _ in first.table.values()]
    others = {
        "/theirs": "mirage-w2.box-0123abcd-1:/theirs",
        "/box2": "mirage-w1.box2-0123abcd-1:/box2",
    }
    for prefix, source in others.items():
        first.table[prefix] = (source, "fuse.sshfs")
        first.running.add(source)
    # The host restarted, and the workspace is deleted before it runs a line.
    second = sharing(first, "ssh")
    workspace(second, workspace_id="w1")
    await second.destroy()
    assert [kill_line(s) in second.commands for s in left] == [True, True]
    assert {p: s for p, (s, _) in second.table.items()} == others
    assert second.running == set(others.values())


class Counted(FakeMachine):
    """A machine that counts its connects and closes."""

    def __init__(self, mount_type):
        super().__init__(mount_type)
        self.connects = 0
        self.closes = 0

    async def connect(self) -> None:
        self.connects += 1

    async def close(self) -> None:
        self.closes += 1
        await super().close()


@pytest.mark.asyncio
async def test_a_delete_closes_the_connection_its_release_opened():
    sandbox = Counted("ssh")
    ws = workspace(sandbox, workspace_id="w1")
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    await ws.delete()
    assert (sandbox.connects, sandbox.closes) == (2, 2)


@pytest.mark.asyncio
async def test_a_delete_releases_a_mount_its_close_could_not_unmount():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox, workspace_id="w1")
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    sandbox.refuse_unmount = True
    await ws.close()
    assert len(sandbox.table) == 2
    sandbox.refuse_unmount = False
    await sandbox.destroy()
    assert sandbox.table == {}


@pytest.mark.asyncio
async def test_a_delete_lets_an_unanswered_kill_go_at_its_deadline(
    monkeypatch,
):
    monkeypatch.setattr(mounts, "UNMOUNT_WAIT_SECONDS", 0.05)
    sandbox = FakeMachine("ssh")
    sandbox.table["/data"] = ("mirage-w1.box-0123abcd-1:/data", "fuse.sshfs")
    sandbox.hang_kill = True
    workspace(sandbox, workspace_id="w1")
    await asyncio.wait_for(sandbox.destroy(), 5)
    assert sandbox.kills_stopped == 1


@pytest.mark.asyncio
async def test_a_live_workspace_keeps_its_own_mounts_through_destroy():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox, workspace_id="w1")
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    serving = dict(sandbox.table)
    await sandbox.destroy()
    assert sandbox.table == serving
    await ws.close()
    assert sandbox.table == {}


def test_a_macs_left_mounts_are_the_workspaces_own():
    text = (
        "mirage-w1.box-0123abcd-1:/data on /home/u/.mirage/mnt/data "
        "(macfuse, nodev)\n"
        "mirage-w2.box-0123abcd-1:/other on /home/u/.mirage/mnt/other "
        "(macfuse)\n"
        "mirage-w1.box-0123abcd-2:/my notes on /home/u/.mirage/mnt/my notes "
        "(macfuse)\n"
        "mirage-w1.box-0123abcd-3:/tmp/a on /b on /home/u/.mirage/mnt/x "
        "(macfuse)\n"
        "/dev/disk1s1 on / (apfs, local)\n"
    )
    assert darwin_left(text, "mirage-w1.box") == {
        "/data",
        "/my notes",
        "/tmp/a",
        "/tmp/a on /b",
    }


@pytest.mark.asyncio
async def test_a_deleted_workspace_tries_every_mount_it_left():
    sandbox = FakeMachine("ssh")
    sandbox.table["/data"] = ("mirage-w1.box-0123abcd-1:/data", "fuse.sshfs")
    sandbox.table["/more"] = ("mirage-w1.box-0123abcd-2:/more", "fuse.sshfs")
    sandbox.refuse_unmount = True
    workspace(sandbox, workspace_id="w1")
    await sandbox.destroy()
    tried = [c for c in sandbox.commands if c.startswith("fusermount3 -uz ")]
    assert [shlex.split(c)[2] for c in tried] == ["/data", "/more"]


@pytest.mark.asyncio
async def test_a_deleted_workspace_releases_the_mounts_it_left_on_a_mac():
    first = FakeMac("mirage", linked={"/data", "/my notes"})
    one = await workspace(first, workspace_id="w1").session(
        "agent", profile="agent"
    )
    assert (await one.shell("python3 job.py")).exit_code == 0
    assert len(first.table) == 2
    # The host restarted, and the workspace is deleted before it runs a line.
    second = FakeMac("mirage", linked={"/data", "/my notes"})
    second.table = first.table
    second.running = first.running
    workspace(second, workspace_id="w1")
    await second.destroy()
    assert (first.table, first.running) == ({}, set())


@pytest.mark.asyncio
async def test_another_machine_entrys_live_sshfs_on_the_sandbox_is_refused():
    first = FakeMachine("ssh")
    second = sharing(first, "ssh", "box2")
    ws = Workspace(
        {"/": RAMVFS(), "/data": RAMVFS()},
        mode=MountMode.WRITE,
        workspace_id="w1",
        machines={**on(first)["machines"], **on(second)["machines"]},
    )
    assert (await ws.shell("python3 job.py")).exit_code == 0
    mounted = dict(first.table)
    result = await ws.shell("python3 job.py", machine="box2")
    assert (result.exit_code, await result.stderr_str()) == (1, FOREIGN)
    assert not [c for c in second.commands if c.startswith("for p in /proc/")]
    assert first.table == mounted
    await ws.close()


@pytest.mark.asyncio
async def test_the_live_sshfs_of_a_workspace_whose_id_starts_alike_is_refused():
    first = FakeMachine("ssh")
    second = sharing(first, "ssh")
    ws1 = workspace(first, workspace_id="w1-2")
    ws2 = workspace(second, workspace_id="w1")
    one = await ws1.session("agent", profile="agent")
    assert (await one.shell("python3 job.py")).exit_code == 0
    mounted = dict(first.table)
    result = await (await ws2.session("agent", profile="agent")).shell(
        "python3 job.py"
    )
    assert (result.exit_code, await result.stderr_str()) == (1, FOREIGN)
    assert not [c for c in second.commands if c.startswith("for p in /proc/")]
    assert first.table == mounted
    await ws2.close()
    await ws1.close()


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
@pytest.mark.parametrize("mount_type", ["both", "own"])
async def test_a_hidden_mount_the_sandbox_serves_refuses_the_line(mount_type):
    sandbox = FakeMachine(mount_type, own=["/data"])
    ws = workspace(sandbox, hide=["/data"])
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 126
    assert await result.stderr_str() == "fake: Permission denied\n"
    assert result.decision is not None
    assert result.decision.reason == (
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
@pytest.mark.parametrize("mount_type", ["both", "own"])
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

    monkeypatch.setattr(mounts, "pipe_server", lambda transport: Server)
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

    monkeypatch.setattr(mounts, "pipe_server", lambda transport: Server)
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

    monkeypatch.setattr(mounts, "pipe_server", lambda transport: Server)
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

    monkeypatch.setattr(mounts, "pipe_server", lambda transport: Server)
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

    monkeypatch.setattr(mounts, "pipe_server", lambda transport: Server)
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

    monkeypatch.setattr(mounts, "pipe_server", lambda transport: Server)
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

    held = mounts.MachineMounts("fake", "box", "ssh", None, None)
    held._served["/data"] = (None, None, Server(None, None, None), "")
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

    monkeypatch.setattr(mounts, "pipe_server", lambda transport: Server)
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
async def test_a_local_path_under_a_served_prefix_fails_loud():
    sandbox = FakeMachine("ssh")
    ws = Workspace(
        {"/": RAMVFS(), "/data": RAMVFS(), "/data/native": f"@{sandbox.name}"},
        mode=MountMode.WRITE,
        profiles={"agent": {"paths": {"hide": []}}},
        **on(sandbox),
    )
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 1
    assert await result.stderr_str() == (
        "python3: fake: the machine mounts /data/native itself, and serving "
        "/data would cover it\n"
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


@pytest.mark.asyncio
@pytest.mark.parametrize("fails", [True, False])
async def test_a_mount_whose_server_ended_before_it_showed_is_never_taken(
    monkeypatch, fails
):
    class Server(Drain):
        async def serve(self, reader, writer):
            if fails:
                raise RuntimeError("no server here")

    monkeypatch.setattr(mounts, "pipe_server", lambda transport: Server)
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 1
    assert "fake: sshfs did not mount /data" in await result.stderr_str()
    assert "python3 job.py" not in sandbox.commands
    assert "/data" not in sandbox.table
    assert "/data" in sandbox.stopped
    await ws.close()


async def _until(ready):
    for _ in range(1000):
        if ready():
            return
        await asyncio.sleep(0.001)
    assert ready()


async def _ended_in_a_line(sandbox, agent):
    """Start a slow program, then end /data's server while it runs.

    Returns:
        asyncio.Task: the program's line, still running.
    """
    line = asyncio.create_task(agent.shell("python3 slow.py"))
    await _until(lambda: "python3 slow.py" in sandbox.commands)
    sandbox.requests["/data"].feed_eof()
    return line


async def _cancelled(line):
    line.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await line


# With no work on the machine no program of Mirage's is blocked, and the
# server most likely ended as the machine paused itself: nothing runs there
# until the next line unmounts the sshfs and serves the prefix again.
@pytest.mark.asyncio
async def test_a_server_that_ends_with_no_work_on_the_machine_kills_nothing():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    source = sandbox.table["/data"][0]
    sandbox.requests["/data"].feed_eof()
    for _ in range(20):
        await asyncio.sleep(0)
    assert kill_line(source) not in sandbox.commands
    assert (await agent.shell("python3 job.py")).exit_code == 0
    assert served(sandbox) == ["/data", "/my notes", "/data"]
    await ws.close()


# A program blocked on a mount nobody answers is freed while its line runs;
# the next line unmounts the mount and serves the prefix again.
@pytest.mark.asyncio
async def test_the_sshfs_of_a_mount_whose_server_ended_is_killed():
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    line = asyncio.create_task(agent.shell("python3 slow.py"))
    await _until(lambda: "python3 slow.py" in sandbox.commands)
    source = sandbox.table["/data"][0]
    sandbox.requests["/data"].feed_eof()
    await _until(lambda: source not in sandbox.running)
    killed = sandbox.commands.index(kill_line(source))
    line.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await line
    assert (await agent.shell("python3 job.py")).exit_code == 0
    assert (
        sandbox.commands.index(
            "fusermount3 -uz '/data' || fusermount -uz '/data'"
        )
        > killed
    )
    assert served(sandbox) == ["/data", "/my notes", "/data"]
    assert sandbox.table["/data"][0] != source
    await ws.close()


@pytest.mark.asyncio
async def test_a_kill_of_an_ended_servers_sshfs_that_fails_warns(caplog):
    sandbox = FakeMachine("ssh")
    sandbox.fail_kill = True
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    line = await _ended_in_a_line(sandbox, agent)
    await _until(
        lambda: "fake: killing the sshfs for /data failed" in caplog.text
    )
    await _cancelled(line)
    assert (await agent.shell("python3 job.py")).exit_code == 0
    await ws.close()


@pytest.mark.asyncio
async def test_the_next_line_runs_while_an_ended_servers_kill_is_unanswered():
    sandbox = FakeMachine("ssh")
    sandbox.hang_kill = True
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    line = await _ended_in_a_line(sandbox, agent)
    await _until(
        lambda: any(c.startswith("for p in /proc/") for c in sandbox.commands)
    )
    await _cancelled(line)
    assert (await agent.shell("python3 job.py")).exit_code == 0
    assert served(sandbox) == ["/data", "/my notes", "/data"]
    await ws.close()


@pytest.mark.asyncio
async def test_an_unanswered_kill_is_let_go_at_its_deadline_with_a_warning(
    monkeypatch, caplog
):
    monkeypatch.setattr(mounts, "UNMOUNT_WAIT_SECONDS", 0.05)
    sandbox = FakeMachine("ssh")
    sandbox.hang_kill = True
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    line = await _ended_in_a_line(sandbox, agent)
    await _until(
        lambda: "fake: killing the sshfs for /data failed" in caplog.text
    )
    assert sandbox.kills_stopped == 1
    await _cancelled(line)
    await ws.close()


@pytest.mark.asyncio
async def test_an_unanswered_kill_is_let_go_quietly_when_the_mounts_close(
    caplog,
):
    sandbox = FakeMachine("ssh")
    sandbox.hang_kill = True
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    line = await _ended_in_a_line(sandbox, agent)
    await _until(
        lambda: any(c.startswith("for p in /proc/") for c in sandbox.commands)
    )
    await _cancelled(line)
    await ws.close()
    await _until(lambda: sandbox.kills_stopped == 1)
    assert "killing the sshfs" not in caplog.text


# Each serve's sshfs carries a source of its own, so the ended one's kill
# reaches only it, however late it lands.
@pytest.mark.asyncio
async def test_a_kill_that_lands_late_spares_the_sshfs_serving_the_prefix_again():
    sandbox = FakeMachine("ssh")
    sandbox.kill_seconds = 0.05
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    line = await _ended_in_a_line(sandbox, agent)
    source = sandbox.table["/data"][0]
    await _until(lambda: kill_line(source) in sandbox.commands)
    await _cancelled(line)
    assert (await agent.shell("python3 job.py")).exit_code == 0
    again = sandbox.table["/data"][0]
    assert again != source
    await asyncio.sleep(0.1)
    assert again in sandbox.running
    assert source not in sandbox.running
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
@pytest.mark.parametrize("mount_type", ["own", "both"])
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
@pytest.mark.parametrize("mount_type", ["own", "both"])
async def test_a_line_is_refused_once_the_sandboxs_own_tmp_is_gone(mount_type):
    sandbox = FakeMachine(mount_type, own=["/tmp"])
    ws = Workspace(
        {"/": RAMVFS(), "/data": RAMVFS(), "/tmp": RAMVFS()},
        mode=MountMode.WRITE,
        **on(sandbox),
    )
    assert (await ws.shell("python3 job.py")).exit_code == 0
    del sandbox.table["/tmp"]
    result = await ws.shell("python3 lost.py")
    assert (result.exit_code, await result.stderr_str()) == (126, lost("/tmp"))
    assert "python3 lost.py" not in sandbox.commands
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
    sandbox = FakeMachine("own", own=own)
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    for _ in range(3):
        assert (await agent.shell("python3 job.py")).exit_code == 0
    assert sandbox.commands.count("cat /proc/mounts") == reads
    await ws.close()


@pytest.mark.asyncio
async def test_fuse_guards_a_mount_the_sandbox_lays_after_the_first_line():
    sandbox = FakeMachine("own")
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
@pytest.mark.parametrize("mount_type", ["own", "both"])
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
    sandbox = FakeMachine("own")
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

    monkeypatch.setattr(mounts, "pipe_server", lambda transport: Server)
    sandbox = FakeMachine("ssh", sshfs_mounts=False)
    ws = workspace(sandbox)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 1
    assert "the file server failed: no server here" in (
        await result.stderr_str()
    )
    await ws.close()


async def _refused_by_the_cli() -> str:
    return "msb refused: sandbox is not running"


@pytest.mark.asyncio
async def test_a_failed_mount_keeps_pipe_diagnostics_when_the_guest_is_gone():
    class UnavailableMachine(FakeMachine):
        async def exec_line(self, line, stdin, env, cwd, *, bounded=False):
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
        mounts.pipe_server("ssh")
    assert str(raised.value) == PIPE_SERVER_HINT


def test_a_broken_sftp_module_is_not_blamed_on_the_extra(monkeypatch):
    monkeypatch.setitem(sys.modules, "mirage.mount.sftp", None)
    with pytest.raises(ImportError) as raised:
        mounts.pipe_server("ssh")
    assert str(raised.value) != PIPE_SERVER_HINT


@pytest.mark.asyncio
async def test_a_line_waits_out_only_what_another_changed_under_its_mounts():
    clock = ManualClock()
    sandbox = FakeMachine("ssh")
    ws = workspace(sandbox, clock=clock)
    assert (await ws.shell("python3 job.py")).exit_code == 0
    start = clock.monotonic()
    assert (await ws.shell("python3 job.py")).exit_code == 0
    assert clock.monotonic() == start
    await ws.vfs.write("/data/f", b"x")
    assert (await ws.shell("python3 job.py")).exit_code == 0
    assert clock.monotonic() == start + 1
    token = SERVED_BY.set("box")
    try:
        await ws.vfs.write("/data/g", b"y")
    finally:
        SERVED_BY.reset(token)
    assert (await ws.shell("python3 job.py")).exit_code == 0
    assert clock.monotonic() == start + 1
    await ws.close()


@pytest.mark.asyncio
async def test_a_mac_mounts_each_prefix_where_its_root_link_leads():
    mac = FakeMac("mirage", linked={"/data", "/my notes"})
    ws = workspace(mac)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert (result.exit_code, await result.stdout_str()) == (0, "ran\n")
    points = ["/home/u/.mirage/mnt/data", "/home/u/.mirage/mnt/my notes"]
    assert sorted(mac.table) == points
    assert [sshfs_mount(p)[1] for p in mac.pipes] == points
    assert list(mac.guards[0][0::4]) == points
    assert list(mac.guards[0][2::4]) == ["macfuse", "macfuse"]
    await ws.close()
    assert mac.table == {}


@pytest.mark.asyncio
async def test_a_mac_without_a_root_link_names_the_commands_that_make_it():
    mac = FakeMac("mirage")
    ws = workspace(mac)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 1
    assert await result.stderr_str() == (
        "python3: "
        + darwin_admin_hint("fake", "/data", "/home/u/.mirage/mnt")
        + "\n"
    )
    assert mac.pipes == []
    await ws.close()


@pytest.mark.asyncio
async def test_a_macs_guard_refuses_a_line_once_its_mount_is_gone():
    mac = FakeMac("mirage", linked={"/data", "/my notes"})
    ws = workspace(mac)
    agent = await ws.session("agent", profile="agent")
    assert (await agent.shell("python3 job.py")).exit_code == 0
    mac.table.pop("/home/u/.mirage/mnt/data")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 126
    assert await result.stderr_str() == (
        "fake: /data is no longer mounted in the machine (did it restart?); "
        "the line did not run\n"
    )
    await ws.close()


def test_a_mirage_source_is_one_a_workspace_names():
    assert mirage_source("w1-box-0a1b2c3d-4:/data", "/data")
    assert not mirage_source("w1-box-0a1b2c3d-4:/data", "/other")
    assert not mirage_source("cryptomator@vault:/data", "/data")
    assert not mirage_source("-0a1b2c3d-4:/data", "/data")


@pytest.mark.asyncio
async def test_a_mac_leaves_a_macfuse_mount_no_workspace_made():
    mac = FakeMac("mirage", linked={"/data", "/my notes"})
    mac.table["/home/u/.mirage/mnt/data"] = ("vault", "macfuse")
    ws = workspace(mac)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert (result.exit_code, await result.stderr_str()) == (
        1,
        "fake: another macFUSE mount serves /data in this machine; "
        "give this workspace a machine of its own\n",
    )
    assert mac.table == {"/home/u/.mirage/mnt/data": ("vault", "macfuse")}
    assert not [c for c in mac.commands if c.startswith("umount")]
    await ws.close()


@pytest.mark.asyncio
async def test_a_mac_takes_no_ssh_mount():
    mac = FakeMac("ssh", linked={"/data", "/my notes"})
    ws = workspace(mac)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("python3 job.py")
    assert result.exit_code == 1
    assert await result.stderr_str() == (
        "python3: fake: mount_type ssh needs a Linux machine; a Mac takes "
        "mount_type mirage\n"
    )
    await ws.close()
