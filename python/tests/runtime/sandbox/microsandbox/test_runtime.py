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
import os

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.commands.config import Context
from mirage.runtime.sandbox.constants import EXEC_PRELUDE
from mirage.runtime.sandbox.microsandbox import MicrosandboxRuntime
from mirage.runtime.table import build_runtime
from mirage.types import PathSpec


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "message"),
    [
        (b'{"status":"Stopped"}', "not running"),
        (b'{"status":"Paused"}', "not running"),
        (b'{"status":"Crashed"}', "not running"),
        (b'{"status":"Draining"}', "not running"),
        (b'{"status":"Starting"}', "not running"),
        (b'{"status":"Created"}', "not running"),
        (b'{"status":"unknown"}', "not running"),
        (b"{}", "not running"),
        (b"null", "invalid status object"),
        (b"[]", "invalid status object"),
        (b"not json", "unreadable json"),
    ],
)
async def test_refuses_unusable_status_before_exec(
    monkeypatch, status, message
):
    calls = []

    async def invoke(executable, hint, args, stdin):
        calls.append(args)
        return status, b"", 0

    monkeypatch.setattr(
        "mirage.runtime.sandbox.microsandbox.runtime.run_cli", invoke
    )
    runtime = build_runtime("microsandbox", config={"sandbox": "box"})
    with pytest.raises(RuntimeError, match=message):
        await runtime.execute(
            [],
            [],
            Context(
                flags={"c": "touch /must-not-exist"},
                cwd=PathSpec.from_str_path("/"),
            ),
            kind="line",
        )
    assert calls == [["status", "box", "--format", "json"]]


@pytest.mark.asyncio
async def test_status_failure_preserves_cli_error(monkeypatch):
    async def invoke(executable, hint, args, stdin):
        return b"", b"sandbox not found", 1

    monkeypatch.setattr(
        "mirage.runtime.sandbox.microsandbox.runtime.run_cli", invoke
    )
    with pytest.raises(RuntimeError, match="sandbox not found"):
        await MicrosandboxRuntime(config={"sandbox": "missing"}).connect()


SANDBOX = os.environ.get("MIRAGE_INTEG_MICROSANDBOX_SANDBOX")


@pytest.mark.asyncio
async def test_process_maps_the_msb_cli_contract(monkeypatch):
    calls = []

    async def invoke(executable, hint, args, stdin):
        calls.append((executable, args, stdin))
        if args[0] == "status":
            return b'{"status":"Running"}', b"", 0
        return b"output", b"diagnostic", 7

    monkeypatch.setattr(
        "mirage.runtime.sandbox.microsandbox.runtime.run_cli", invoke
    )
    runtime = build_runtime(
        "microsandbox", config={"sandbox": "box", "env": {"MARK": "config"}}
    )
    words = ("python3", "a b", "$(literal)", "", "--flag")
    result = await runtime.execute(
        [],
        list(words),
        Context(
            cwd=PathSpec.from_str_path("/work"),
            env={"MARK": "request"},
            stdin=b"input",
        ),
        kind="process",
    )
    assert [call for call in calls if call[1][:2] == ["exec", "box"]] == [
        (
            "msb",
            [
                "exec",
                "box",
                "--quiet",
                "--no-tty",
                "-w",
                "/",
                "-e",
                "MARK=request",
                "--",
                "/bin/sh",
                "-c",
                EXEC_PRELUDE,
                "sh",
                "/work",
                *words,
            ],
            b"input",
        ),
    ]
    assert (result.stdout, result.stderr, result.exit_code) == (
        b"output",
        b"diagnostic",
        7,
    )


@pytest.mark.asyncio
@pytest.mark.skipif(
    not SANDBOX,
    reason="set MIRAGE_INTEG_MICROSANDBOX_SANDBOX to a guest with Python and /data",
)
async def test_real_guest_process_shell_and_fuse():
    runtime = build_runtime(
        "microsandbox", config={"sandbox": SANDBOX, "env": {"MARK": "config"}}
    )
    assert isinstance(runtime, MicrosandboxRuntime)
    cwd = PathSpec.from_str_path("/data")
    payload = b"input\x00\xff\r\n"
    words = ("a b", "$(echo literal)", "", "--flag")
    result = await runtime.execute(
        [],
        list(
            (
                "python3",
                "-c",
                "import json,os,sys; "
                "sys.stdout.buffer.write(sys.stdin.buffer.read()); "
                "sys.stderr.write(json.dumps("
                "[os.getcwd(),os.environ['MARK'],sys.argv[1:]])); "
                "sys.exit(7)",
                *words,
            )
        ),
        Context(cwd=cwd, env={"MARK": "request"}, stdin=payload),
        kind="process",
    )
    assert result.stdout == payload
    assert json.loads(result.stderr) == ["/data", "request", list(words)]
    assert result.exit_code == 7
    shell = await runtime.execute(
        [],
        [],
        Context(flags={"c": 'printf "%s" "$MARK"; pwd'}, cwd=cwd),
        kind="line",
    )
    assert shell.stdout == b"config/data\n"
    assert shell.stderr == b""
    assert shell.exit_code == 0
    files = await runtime.execute(
        [],
        list(
            (
                "python3",
                "-c",
                "from pathlib import Path; "
                "assert any(' /data fuse ' in line for line in "
                "Path('/proc/mounts').read_text().splitlines()); "
                "assert Path('hello.txt').read_text() == 'hello from Mirage FUSE\\n'; "
                "Path('python.txt').write_text('python adapter\\n'); "
                "assert Path('python.txt').read_text() == 'python adapter\\n'; "
                "print('Mirage FUSE read/write passed')",
            )
        ),
        Context(cwd=cwd),
        kind="process",
    )
    assert files.stdout == b"Mirage FUSE read/write passed\n"
    assert files.stderr == b""
    assert files.exit_code == 0
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[
            MicrosandboxRuntime(
                captures=["python3", "@external"],
                config={"sandbox": SANDBOX},
            ),
            "workspace",
        ],
    )
    try:
        routed = await ws.shell(
            "python3 -c 'from pathlib import Path; "
            'print(Path("/data/python.txt").read_text(), end="")\''
        )
        assert routed.stdout == b"python adapter\n"
        assert not routed.stderr
        assert routed.exit_code == 0
    finally:
        await ws.close()
    await runtime.close()
    await build_runtime("microsandbox", config={"sandbox": SANDBOX}).connect()


STOPPED_SANDBOX = os.environ.get("MIRAGE_INTEG_MICROSANDBOX_STOPPED_SANDBOX")

MOUNT_SANDBOX = os.environ.get("MIRAGE_INTEG_MICROSANDBOX_MOUNT_SANDBOX")


@pytest.mark.asyncio
@pytest.mark.skipif(
    not MOUNT_SANDBOX, reason="set a guest with sshfs for mounts"
)
@pytest.mark.parametrize("mount_type", ["ssh", "both"])
async def test_real_ssh_mount_serves_the_host_session_and_unmounts(mount_type):
    prefix = f"/mirage-python-{mount_type}"
    runtime = MicrosandboxRuntime(
        captures=["python3"],
        config={"sandbox": MOUNT_SANDBOX, "mount_type": mount_type},
    )
    ws = Workspace(
        {prefix: RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"agent": {"paths": {"hide": [f"{prefix}/secret.txt"]}}},
        runtimes=[runtime, "workspace"],
    )
    try:
        assert (
            await ws.shell(f"echo host > {prefix}/hello.txt")
        ).exit_code == 0
        assert (
            await ws.shell(f"echo hidden > {prefix}/secret.txt")
        ).exit_code == 0
        agent = await ws.session("agent", profile="agent")
        result = await agent.shell(
            "python3 -c 'from pathlib import Path; "
            f'assert Path("{prefix}/hello.txt").read_text() == "host\\n"; '
            f'assert not Path("{prefix}/secret.txt").exists(); '
            f'Path("{prefix}/new.txt").write_text("guest\\n"); '
            'print("host workspace served")\''
        )
        assert result.exit_code == 0, result.stderr
        assert result.stdout == b"host workspace served\n"
        written = await ws.shell(f"cat {prefix}/new.txt")
        assert written.stdout == b"guest\n"
        other = await ws.session("other")
        refused = await other.shell("python3 -c 'print(1)'")
        assert refused.exit_code == 1
        assert b"session agent's view" in refused.stderr
    finally:
        await ws.close()
    check = await MicrosandboxRuntime(
        config={"sandbox": MOUNT_SANDBOX}
    ).exec_line(f"mountpoint -q {prefix}", None, {}, "/")
    assert check.exit_code != 0


def test_mount_type_rejects_an_unknown_value():
    with pytest.raises(ValueError, match="mount_type must be one of"):
        MicrosandboxRuntime(config={"sandbox": "box", "mount_type": "unknown"})


@pytest.mark.asyncio
@pytest.mark.skipif(
    not STOPPED_SANDBOX, reason="set a stopped guest to check refusal"
)
async def test_real_stopped_guest_is_not_started():
    runtime = MicrosandboxRuntime(config={"sandbox": STOPPED_SANDBOX})
    with pytest.raises(RuntimeError, match="status: Stopped"):
        await runtime.execute(
            [],
            [],
            Context(
                flags={"c": "echo must-not-run"},
                cwd=PathSpec.from_str_path("/"),
            ),
            kind="line",
        )
    with pytest.raises(RuntimeError, match="status: Stopped"):
        await MicrosandboxRuntime(
            config={"sandbox": STOPPED_SANDBOX}
        ).connect()
