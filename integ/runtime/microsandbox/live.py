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

"""Run the Microsandbox integration against a provisioned real guest."""

import asyncio
import fcntl
import hashlib
import json
import os
import shlex
import signal
import uuid
from pathlib import Path

from mirage import RAMVFS, MountMode, PathSpec, Workspace
from mirage.commands.config import Context
from mirage.runtime.sandbox.microsandbox import MicrosandboxRuntime

SANDBOX = os.environ["MIRAGE_E2E_SANDBOX"]
GUEST = "/e2e-guest"
HOST = "/e2e host \u2603"
PASSED = []
FAILED = []


async def check(name, operation):
    try:
        await operation()
    except Exception as error:
        FAILED.append(name)
        print(
            json.dumps(
                {"check": name, "status": "FAIL", "error": repr(error)}
            ),
            flush=True,
        )
    else:
        PASSED.append(name)
        print(json.dumps({"check": name, "status": "PASS"}), flush=True)


async def raw(command):
    return await MicrosandboxRuntime(config={"sandbox": SANDBOX}).exec_line(
        command, None, {}, "/"
    )


async def transport():
    runtime = MicrosandboxRuntime(config={"sandbox": SANDBOX})
    for data in (None, b"", b"\x00\xff\r\n", bytes(range(256)) * 16384):
        result = await runtime.execute(
            [],
            list(
                (
                    "python3",
                    "-c",
                    "import sys,hashlib; "
                    "print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())",
                )
            ),
            Context(cwd=PathSpec.from_str_path("/tmp"), stdin=data),
            kind="process",
        )
        assert result.exit_code == 0, result.stderr
        assert (
            result.stdout.strip()
            == hashlib.sha256(data or b"").hexdigest().encode()
        )
        assert result.stderr == b""
    data = bytes(range(256)) * 16384
    words = ("a b", "$(literal)", "", "--flag", "\u2603", "one\ntwo")
    marker = "quotes ' \" $ and\nnewlines"
    result = await runtime.execute(
        [],
        list(
            (
                "python3",
                "-c",
                "import os,sys,json; assert os.getcwd()=='/tmp'; "
                "assert os.environ['MARK']==sys.argv[1]; "
                "sys.stdout.buffer.write(sys.stdin.buffer.read()); "
                "sys.stderr.write(json.dumps(sys.argv[2:])); sys.exit(23)",
                marker,
                *words,
            )
        ),
        Context(
            cwd=PathSpec.from_str_path("/tmp"),
            env={"MARK": marker},
            stdin=data,
        ),
        kind="process",
    )
    assert result.stdout == data
    assert json.loads(result.stderr) == list(words)
    assert result.exit_code == 23
    large = await runtime.exec_line(
        'python3 -c \'import sys; sys.stdout.write("O"*2097152); '
        'sys.stderr.write("E"*1048576)\'',
        None,
        {},
        "/tmp",
    )
    assert large.exit_code == 0
    assert large.stdout == b"O" * 2097152
    assert large.stderr == b"E" * 1048576
    await runtime.close()


async def mode_checks(mode):
    prefix = GUEST if mode == "fuse" else HOST
    source, readonly = RAMVFS(), RAMVFS()
    await source.write(
        PathSpec.from_str_path("/seed.txt"),
        b"host-only\n" if mode == "fuse" else b"seed\n",
    )
    await source.write(PathSpec.from_str_path("/secret.txt"), b"host secret\n")
    await readonly.write(PathSpec.from_str_path("/protected.txt"), b"locked\n")
    mounts = {prefix: source, prefix + "/ro": (readonly, MountMode.READ)}
    if mode == "both":
        mounts[GUEST] = RAMVFS()
    runtime = MicrosandboxRuntime(
        captures=["python3", "dash", "sleep"],
        config={"sandbox": SANDBOX, "mount_type": mode},
    )
    ws = Workspace(
        mounts,
        mode=MountMode.EXEC,
        runtimes=[runtime, "workspace"],
        profiles={"hidden": {"paths": {"hide": [prefix + "/secret.txt"]}}},
    )
    agent = await ws.session(
        "agent", profile=None if mode == "fuse" else "hidden"
    )

    async def probe(operation, extra=""):
        command = (
            "python3 /tmp/mirage_e2e_ops.py "
            + shlex.quote(prefix)
            + " "
            + operation
            + extra
        )
        result = await agent.shell(command, cwd=prefix)
        assert result.exit_code == 0, result.stderr
        return json.loads(result.stdout)

    try:

        async def process_cwd():
            await probe("seed")
            words = ("a b", "$(literal)", "", "--flag", "☃", "one\ntwo")
            marker = "quotes ' \" $ and\nnewlines"
            argv = (
                "python3",
                "-c",
                "import os,sys,json; "
                "sys.stdout.buffer.write(sys.stdin.buffer.read()); "
                "sys.stderr.write(json.dumps([os.getcwd(),"
                "os.environ['MARK'],sys.argv[1:]])); sys.exit(23)",
                *words,
            )
            result = await agent.shell(
                "MARK=" + shlex.quote(marker) + " " + shlex.join(argv),
                cwd=prefix,
                stdin=b"\x00\xff\r\n",
            )
            assert result.stdout == b"\x00\xff\r\n"
            assert json.loads(result.stderr) == [prefix, marker, list(words)]
            assert result.exit_code == 23
            invalid = await runtime.exec_line(
                "printf must-not-run", None, {}, prefix + "/missing-directory"
            )
            assert invalid.exit_code != 0
            assert invalid.stdout == b""
            assert invalid.stderr.startswith(b"sh:"), invalid.stderr

            unusual = prefix + "/quotes ' \" $(printf injected) ☃\nline"
            created = await runtime.exec_line(
                shlex.join(
                    (
                        "python3",
                        "-c",
                        "import os,sys; os.makedirs(sys.argv[1], exist_ok=True)",
                        unusual,
                    )
                ),
                None,
                {},
                "/",
            )
            assert created.exit_code == 0, created.stderr
            literal_cwd = await runtime.exec_line(
                shlex.join(
                    (
                        "python3",
                        "-c",
                        "import os,sys; assert os.getcwd()==sys.argv[1]; "
                        "print('literal-cwd')",
                        unusual,
                    )
                ),
                None,
                {"CDPATH": "/tmp"},
                unusual,
            )
            assert literal_cwd.exit_code == 0, literal_cwd.stderr
            assert literal_cwd.stdout == b"literal-cwd\n"

        await check(
            mode + "_mounted_cwd_literal_argv_env_stdin_invalid_cwd",
            process_cwd,
        )

        async def fs():
            result = await probe("filesystem")
            assert result == {
                "sha256": hashlib.sha256(bytes(range(256)) * 4096).hexdigest(),
                "bytes": 1048576,
            }
            if mode == "fuse":
                receipt = await raw(
                    "mirage shell -w e2e -c 'cat /e2e-guest/receipt.txt'"
                )
                assert receipt.exit_code == 0, receipt.stderr
                assert receipt.stdout == b"guest-filesystem-verified\n"
                assert (
                    await ws.shell("cat /e2e-guest/seed.txt")
                ).stdout == b"host-only\n"
            else:
                assert (
                    await ws.shell(
                        "cat " + shlex.quote(prefix + "/receipt.txt")
                    )
                ).stdout == b"guest-filesystem-verified\n"

        await check(
            mode
            + "_filesystem_binary_seek_append_truncate_rename_unlink_tools",
            fs,
        )
        await check(
            mode + "_symlinks_relative_absolute_dangling",
            lambda: probe("symlinks", " scoped" if mode == "fuse" else ""),
        )
        await check(mode + "_threads", lambda: probe("threads"))
        await check(mode + "_readonly", lambda: probe("readonly"))
        if mode != "fuse":
            await check(mode + "_hidden_file", lambda: probe("hidden"))

            async def freshness():
                assert await probe("seed") == {"seed": "seed\n"}
                await source.write(
                    PathSpec.from_str_path("/seed.txt"), b"changed\n"
                )
                assert await probe("seed") == {"seed": "changed\n"}

            await check(mode + "_host_change_visible", freshness)

        async def parallel():
            results = await asyncio.gather(
                *(probe("parallel", f" {i}") for i in range(6))
            )
            assert [r["index"] for r in results] == [str(i) for i in range(6)]
            assert all(r["end"] > r["start"] for r in results)

        await check(mode + "_parallel_processes", parallel)

        async def streams():
            result = await agent.shell(
                "python3 -c 'import sys; d=sys.stdin.buffer.read(); "
                "sys.stdout.buffer.write(d); "
                'sys.stderr.write("separate"); sys.exit(7)\'',
                stdin=b"\x00\xff" * 524288,
                cwd="/",
            )
            assert result.stdout == b"\x00\xff" * 524288
            assert result.stderr == b"separate"
            assert result.exit_code == 7

        await check(mode + "_workspace_binary_stdin_stderr_exit", streams)

        async def session():
            other = await ws.session(
                "other", profile="hidden" if mode == "fuse" else None
            )
            result = await other.shell("python3 -c 'print(\"must not run\")'")
            assert result.exit_code == 1
            assert (
                b"out of reach" in result.stderr
                if mode == "fuse"
                else b"session agent's view" in result.stderr
            )

        await check(mode + "_session_policy", session)

        if mode == "both":

            async def own():
                result = await agent.shell(
                    "python3 -c 'from pathlib import Path; "
                    'print(Path("/e2e-guest/seed.txt").read_text(),end="")\''
                )
                assert result.exit_code == 0, result.stderr
                assert result.stdout == b"seed\n"

            await check("both_guest_mount_retained", own)
    finally:
        await asyncio.wait_for(ws.close(), 15)

    async def cleanup():
        result = await raw("mountpoint -q " + shlex.quote(prefix))
        assert (
            result.exit_code == 0 if mode == "fuse" else result.exit_code != 0
        )
        assert (await raw("mountpoint -q /e2e-guest")).exit_code == 0
        assert (await raw("pgrep -x sshfs")).exit_code == 1

    await check(mode + "_mount_and_process_cleanup", cleanup)


async def cycles():
    for _ in range(3):
        ws = Workspace(
            {HOST: RAMVFS()},
            mode=MountMode.EXEC,
            runtimes=[
                MicrosandboxRuntime(
                    captures=["python3"],
                    config={"sandbox": SANDBOX, "mount_type": "ssh"},
                ),
                "workspace",
            ],
        )
        try:
            result = await ws.shell("python3 -c 'print(\"cycle\")'")
            assert result.exit_code == 0, result.stderr
            assert result.stdout == b"cycle\n"
        finally:
            await ws.close()
        assert (await raw("pgrep -x sshfs")).exit_code == 1


async def local(*args):
    child = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        out, err = await asyncio.wait_for(child.communicate(), 20)
    finally:
        if child.returncode is None:
            child.kill()
            await child.wait()
    assert child.returncode == 0, err.decode(errors="replace")
    return out


async def guest_pid(path):
    for _ in range(60):
        result = await raw("cat " + shlex.quote(path))
        if result.exit_code == 0:
            return int(result.stdout)
        await asyncio.sleep(0.05)
    raise AssertionError("guest command never started")


async def reaped(pid):
    for _ in range(60):
        if (await raw(f"test ! -e /proc/{pid}")).exit_code == 0:
            return
        await asyncio.sleep(0.05)
    raise AssertionError(f"guest child {pid} survived cleanup")


async def host_pids(marker):
    listing = (await local("ps", "-axo", "pid=,command=")).decode()
    return [
        int(parts[0])
        for line in listing.splitlines()
        if len(parts := line.split(None, 2)) == 3
        and (parts[1] == "msb" or parts[1].endswith("/msb"))
        and SANDBOX in parts[2]
        and "--stream" in parts[2]
        and marker in parts[2]
    ]


class FullInspect(MicrosandboxRuntime):
    async def _microsandbox(self, args, stdin=None):
        return await super()._microsandbox(
            ["inspect", *args[1:]] if args[0] == "status" else args,
            stdin,
        )


async def inspect_pids():
    rows = (await local("ps", "-axo", "pid=,command=")).decode()
    return [
        int(parts[0])
        for line in rows.splitlines()
        if len(parts := line.split(None, 2)) == 3
        and (parts[1] == "msb" or parts[1].endswith("/msb"))
        and parts[2].startswith("inspect " + SANDBOX + " ")
    ]


async def probe_with_storage_locked():
    run_dir = (
        Path(os.environ.get("MSB_HOME", str(Path.home() / ".microsandbox")))
        / "run"
    )
    digest = hashlib.sha256(SANDBOX.encode()).hexdigest()[:32]

    with (run_dir / "creation-locks" / (digest + ".lock")).open("rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = await asyncio.wait_for(raw("printf runtime-probe-ok"), 5)
        assert (
            result.exit_code == 0 and result.stdout == b"runtime-probe-ok"
        ), result
        pending = asyncio.create_task(
            FullInspect(config={"sandbox": SANDBOX}).execute(
                [],
                list(("true",)),
                Context(cwd=PathSpec.from_str_path("/")),
                kind="process",
            )
        )
        try:
            for _ in range(80):
                if await inspect_pids():
                    break
                await asyncio.sleep(0.025)
            else:
                raise AssertionError("real msb inspect did not start")
            assert not pending.done()
            pending.cancel()
            try:
                await pending
            except asyncio.CancelledError:
                pass
            else:
                raise AssertionError("probe ignored cancellation")
            for _ in range(80):
                if not await inspect_pids():
                    break
                await asyncio.sleep(0.025)
            else:
                raise AssertionError("cancelled inspect process survived")
        finally:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
            for pid in await inspect_pids():
                os.kill(pid, signal.SIGKILL)


async def missing_fuse_device():
    ws = Workspace(
        {"/missing-fuse": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[
            MicrosandboxRuntime(
                captures=["python3"],
                config={
                    "sandbox": SANDBOX,
                    "mount_type": "ssh",
                },
            ),
            "workspace",
        ],
    )
    moved = await raw(
        "test -c /dev/fuse && test ! -e /dev/fuse-mirage-e2e && "
        "mv /dev/fuse /dev/fuse-mirage-e2e"
    )
    assert moved.exit_code == 0, moved.stderr
    try:
        result = await ws.shell("python3 -c 'print(1)'")
        assert result.exit_code == 1
        assert b"fuse: device not found" in result.stderr, result.stderr
    finally:
        restored = await raw("mv /dev/fuse-mirage-e2e /dev/fuse")
        assert restored.exit_code == 0, restored.stderr
        await ws.close()


async def stopped_after_connect(mode):
    runtime = MicrosandboxRuntime(
        config={"sandbox": SANDBOX, "mount_type": mode}
    )
    assert (await runtime.exec_line("true", None, {}, "/")).exit_code == 0
    await local("msb", "stop", SANDBOX, "--timeout", "10")
    try:
        for operation in (
            runtime.exec_line("printf must-not-run", None, {}, "/"),
            runtime.open_pipe("printf must-not-run"),
        ):
            try:
                await operation
            except RuntimeError as error:
                assert "not running" in str(error), error
            else:
                raise AssertionError("accepted a stopped guest")
        state = json.loads(
            await local("msb", "inspect", SANDBOX, "--format", "json")
        )
        assert state["status"] == "Stopped", state["status"]
    finally:
        await local("msb", "start", SANDBOX)
        await runtime.close()


class StopAfterProbe(MicrosandboxRuntime):
    async def connect(self):
        await super().connect()
        await local("msb", "stop", SANDBOX, "--timeout", "10")


async def stopped_between_probe_and_pipe(mode):
    candidate = StopAfterProbe(config={"sandbox": SANDBOX, "mount_type": mode})
    try:
        pipe = await candidate.open_pipe("printf race-command-ran")
        try:
            assert (
                await asyncio.wait_for(pipe.reader.read(), 15)
                == b"race-command-ran"
            )
            await pipe.stop()
            assert pipe.diagnostic is not None
            assert "not running" not in await pipe.diagnostic()
        finally:
            await pipe.stop()
        state = json.loads(
            await local("msb", "inspect", SANDBOX, "--format", "json")
        )
        assert state["status"] == "Stopped", state
    finally:
        await local("msb", "start", SANDBOX)


async def lifecycle_checks():
    runtime = MicrosandboxRuntime(config={"sandbox": SANDBOX})

    await check(
        "storage_lock_does_not_block_exec_and_cancel_reaps_probe",
        probe_with_storage_locked,
    )

    async def diagnostics():
        pipe = await runtime.open_pipe(
            "python3 -c 'import sys; "
            'sys.stderr.write("X"*32768+"specific-startup-error"); sys.exit(31)\''
        )
        try:
            assert await asyncio.wait_for(pipe.reader.read(), 10) == b""
            assert pipe.diagnostic is not None
            for _ in range(20):
                if "specific-startup-error" in await pipe.diagnostic():
                    break
                await asyncio.sleep(0.05)
            assert "specific-startup-error" in await pipe.diagnostic()
            assert len((await pipe.diagnostic()).encode()) <= 16384
        finally:
            await pipe.stop()

    await check("pipe_bounded_stderr_diagnostic", diagnostics)

    async def forced_stop():
        marker = "mirage-stop-" + uuid.uuid4().hex
        path = "/tmp/" + marker
        pipe = await runtime.open_pipe(f"echo $$ > {path}; exec sleep 30")
        try:
            pid = await guest_pid(path)
            hosts = await host_pids(marker)
            assert len(hosts) == 1, hosts
            os.kill(hosts[0], signal.SIGSTOP)
            await asyncio.wait_for(pipe.stop(), 8)
            assert not await host_pids(marker)
            await reaped(pid)
        finally:
            for host in await host_pids(marker):
                os.kill(host, signal.SIGCONT)
            await pipe.stop()

    await check("stopped_cli_forced_kill_and_guest_cleanup", forced_stop)

    async def cancelled_call():
        path = "/tmp/mirage-cancel-" + uuid.uuid4().hex
        task = asyncio.create_task(
            runtime.exec_line(
                f"echo $$ > {path}; exec sleep 30", None, {}, "/"
            )
        )
        try:
            pid = await guest_pid(path)
            task.cancel()
            try:
                await asyncio.wait_for(task, 5)
            except asyncio.CancelledError:
                pass
            else:
                raise AssertionError(
                    "execution did not propagate cancellation"
                )
            await reaped(pid)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    await check("cancelled_execution_reaps_guest", cancelled_call)

    await check(
        "missing_fuse_device_preserves_sshfs_error", missing_fuse_device
    )

    for mode in (None, "ssh", "both"):
        await check(
            f"{mode}_cached_runtime_refuses_guest_stopped_before_probe",
            lambda mode=mode: stopped_after_connect(mode),
        )
        await check(
            f"{mode}_released_cli_can_restart_after_probe",
            lambda mode=mode: stopped_between_probe_and_pipe(mode),
        )


async def main():
    if path := os.environ.get("MIRAGE_E2E_AGENTD"):
        actual = (
            (await raw("sha256sum /proc/1/exe")).stdout.decode().split()[0]
        )
        assert actual == hashlib.sha256(Path(path).read_bytes()).hexdigest()
    assert (await raw("mountpoint -q /e2e-guest")).exit_code == 0, (
        "guest FUSE setup missing"
    )
    await check("raw_4MiB_stdin_argv_env_cwd_large_output", transport)
    for mode in ("fuse", "ssh", "both"):
        await mode_checks(mode)
    await check("three_mount_close_cycles", cycles)
    await lifecycle_checks()
    print(
        json.dumps(
            {"host": "python", "passed": len(PASSED), "failed": FAILED}
        ),
        flush=True,
    )
    return bool(FAILED)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
