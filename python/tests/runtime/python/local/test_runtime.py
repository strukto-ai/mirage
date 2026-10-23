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
import json
import os
import sys
import threading
import time
from pathlib import Path

import pytest

from mirage import RAMVFS, DiskVFS, MountMode, Workspace
from mirage.commands.config import Context
from mirage.runtime.python import LocalRuntime
from mirage.runtime.types import Program, RunResult
from mirage.types import PathSpec


def _args(code: str, env: dict[str, str] | None = None, **fields):
    return Program(code=code, **fields), env


async def _run(runtime: LocalRuntime, program: Program, **fields) -> RunResult:
    return await runtime.interpret(None, program, Context(**fields))


def _process(runtime: LocalRuntime, argv, cwd, stdin: bytes | None = None):
    ctx = Context(cwd=PathSpec.from_str_path(str(cwd)), env={}, stdin=stdin)
    return runtime.run_process(None, [], list(argv), ctx, None)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "program, expected",
    [
        ("dir/py/list.py", "seed.txt\nsub\n"),
        ("path/py/stat.py", "file 5 32768\ndir 16384\nmissing\n"),
        ("dir/py/glob.py", "seed.txt\nsub/inner.txt\n"),
    ],
)
async def test_filesystem_operations(tmp_path, program, expected):
    (tmp_path / "seed.txt").write_text("seed\n")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "inner.txt").write_text("inner\n")
    fixture = (
        Path(__file__).resolve().parents[5]
        / "integ"
        / "fixtures"
        / "runtime"
        / program
    )
    runtime = LocalRuntime()
    try:
        result = await _run(
            runtime,
            Program(code=fixture.read_text()),
            env={"MIRAGE_TEST_ROOT": str(tmp_path)},
        )
        assert result.exit_code == 0, result.stderr
        assert result.stdout.decode() == expected
        assert result.stderr is None
    finally:
        await runtime.close()


@pytest.mark.parametrize(
    ("args", "exit_code", "stdout", "stderr"),
    [
        pytest.param(
            _args(code="print(21 * 2)"), 0, b"42\n", None, id="print"
        ),
        pytest.param(
            _args(code="import sys; print(sys.argv[1:])", args=["a", "b"]),
            0,
            b"['a', 'b']\n",
            None,
            id="argv",
        ),
        pytest.param(
            _args(
                code="import os; print(os.environ['MY_VAR'])",
                env={"MY_VAR": "v1"},
            ),
            0,
            b"v1\n",
            None,
            id="env-is-the-sessions",
        ),
        pytest.param(
            _args(
                code="import sys; print(sys.stdin.read().upper())",
                stdin=b"hello",
            ),
            0,
            b"HELLO\n",
            None,
            id="stdin",
        ),
        pytest.param(
            _args(code="1/0"), 1, b"", b"ZeroDivisionError", id="traceback"
        ),
    ],
)
def test_local_runs_on_the_host_interpreter(args, exit_code, stdout, stderr):
    program, env = args
    result = asyncio.run(_run(LocalRuntime(), program, env=env))
    assert (result.exit_code, result.stdout) == (exit_code, stdout)
    if stderr is None:
        assert result.stderr is None
    else:
        assert stderr in result.stderr


@pytest.mark.parametrize(
    "stdin", [None, b"", b"x" * 300_000], ids=["absent", "empty", "large"]
)
def test_script_cli_stdin_is_not_embedded_in_process_argv(stdin):
    runtime = LocalRuntime()
    result = asyncio.run(
        _run(
            runtime,
            Program(
                code=(
                    "from __future__ import annotations\n"
                    "import sys\nprint(argv)\n"
                    "print(stdin is None, len(stdin or b''), "
                    "sys.stdin.buffer.read() == (stdin or b''))"
                ),
                prog="pager",
                args=["one"],
                script_cli=True,
                stdin=stdin,
            ),
        )
    )
    assert result.exit_code == 0
    assert (
        result.stdout
        == (
            f"['pager', 'one']\n{stdin is None} {len(stdin or b'')} True\n"
        ).encode()
    )


@pytest.mark.asyncio
async def test_the_program_gets_none_of_the_host_environment(monkeypatch):
    monkeypatch.setenv("MIRAGE_TEST_HOST_ONLY", "host")
    runtime = LocalRuntime(config={"env": {"MIRAGE_TEST_CONFIG": "config"}})
    try:
        result = await _run(
            runtime,
            Program(
                code=(
                    "import os; print(os.environ.get('MIRAGE_TEST_HOST_ONLY'),"
                    " os.environ['MIRAGE_TEST_CONFIG'], os.environ['MY_VAR'])"
                )
            ),
            env={"MY_VAR": "session"},
        )
    finally:
        await runtime.close()
    assert (result.exit_code, result.stdout) == (0, b"None config session\n")


def test_local_name():
    assert LocalRuntime().name == "local"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "argv, cwd, exit_code, stdout, stderr",
    [
        (("cksum",), "/", 0, b"2352138605 2\n", None),
        (
            ("no-such-program-xyz",),
            "/",
            127,
            b"",
            b"no-such-program-xyz: command not found\n",
        ),
        (
            ("cksum",),
            "/no/such/dir",
            126,
            b"",
            b"cksum: the working directory /no/such/dir is not on this host\n",
        ),
    ],
)
async def test_a_captured_program_runs_on_the_host(
    argv, cwd, exit_code, stdout, stderr
):
    runtime = LocalRuntime(captures=["python3", "@external"])
    try:
        result = await _process(runtime, argv, cwd, b"hi")
    finally:
        await runtime.close()
    assert (result.exit_code, result.stdout, result.stderr) == (
        exit_code,
        stdout,
        stderr,
    )


@pytest.mark.asyncio
async def test_a_program_found_through_a_relative_path_entry_runs_elsewhere(
    tmp_path, monkeypatch
):
    tools = tmp_path / "tools"
    tools.mkdir()
    probe = tools / "mirage-probe"
    probe.write_text(f"#!{sys.executable}\nprint('probe')\n")
    probe.chmod(0o755)
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setenv("PATH", "tools")
    monkeypatch.chdir(tmp_path)
    runtime = LocalRuntime(captures=["@external"])
    try:
        result = await _process(runtime, ["mirage-probe"], work)
    finally:
        await runtime.close()
    assert (result.exit_code, result.stdout) == (0, b"probe\n")


@pytest.mark.asyncio
async def test_a_program_named_by_a_relative_path_runs_from_the_cwd(tmp_path):
    tool = tmp_path / "mirage-tool"
    tool.write_text(f"#!{sys.executable}\nprint('tool')\n")
    tool.chmod(0o755)
    runtime = LocalRuntime(captures=["@external"])
    try:
        result = await _process(runtime, ["./mirage-tool"], tmp_path)
    finally:
        await runtime.close()
    assert (result.exit_code, result.stdout) == (0, b"tool\n")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name, exit_code, stderr",
    [
        ("./missing", 127, b"./missing: No such file or directory\n"),
        ("./plain", 126, b"./plain: Permission denied\n"),
        ("./sub", 126, b"./sub: Is a directory\n"),
    ],
)
async def test_a_program_path_that_cannot_run_answers_as_the_shell(
    tmp_path, name, exit_code, stderr
):
    (tmp_path / "plain").write_text("#!/bin/sh\necho hi\n")
    (tmp_path / "sub").mkdir()
    runtime = LocalRuntime(captures=["@external"])
    try:
        result = await _process(runtime, [name], tmp_path)
    finally:
        await runtime.close()
    assert (result.exit_code, result.stderr) == (exit_code, stderr)


@pytest.mark.asyncio
async def test_a_program_path_follows_dot_dot_past_a_symlink(tmp_path):
    (tmp_path / "opt" / "build").mkdir(parents=True)
    tool = tmp_path / "opt" / "mirage-tool"
    tool.write_text(f"#!{sys.executable}\nprint('opt')\n")
    tool.chmod(0o755)
    work = tmp_path / "work"
    work.mkdir()
    (work / "link").symlink_to(tmp_path / "opt" / "build")
    runtime = LocalRuntime(captures=["@external"])
    try:
        result = await _process(runtime, ["link/../mirage-tool"], work)
    finally:
        await runtime.close()
    assert (result.exit_code, result.stdout) == (0, b"opt\n")


@pytest.mark.asyncio
async def test_a_program_that_cannot_start_fails_as_the_shell_would(
    tmp_path, monkeypatch
):
    tool = tmp_path / "mirage-broken"
    tool.write_text("#!/no/such/interpreter\n")
    tool.chmod(0o755)
    runtime = LocalRuntime(captures=["@external"])
    monkeypatch.setenv("PATH", str(tmp_path))
    try:
        result = await _process(runtime, ["mirage-broken"], tmp_path)
    finally:
        await runtime.close()
    assert (result.exit_code, result.stderr) == (
        126,
        b"mirage-broken: cannot execute: No such file or directory\n",
    )


@pytest.mark.asyncio
async def test_a_bare_home_found_through_an_empty_path_entry_runs(
    tmp_path, monkeypatch
):
    # An empty PATH entry is the current directory; the name resolves to
    # an absolute path, since the program's environment has no PATH.
    probe = tmp_path / "mirage-probe"
    probe.write_text(f"#!{sys.executable}\nprint('probe')\n")
    probe.chmod(0o755)
    monkeypatch.setenv("PATH", os.pathsep)
    monkeypatch.chdir(tmp_path)
    runtime = LocalRuntime(config={"home": "mirage-probe"})
    monkeypatch.chdir("/")
    result = await runtime.version({})
    assert result.stdout == b"probe\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode", [MountMode.READ, MountMode.WRITE, MountMode.EXEC]
)
async def test_version_process_gets_none_of_the_session_environment(
    tmp_path, monkeypatch, mode
):
    monkeypatch.setenv("MIRAGE_TEST_VERSION_ENV", "host")
    session = {
        "LD_PRELOAD": str(tmp_path / "session.so"),
        "LD_LIBRARY_PATH": str(tmp_path),
        "DYLD_INSERT_LIBRARIES": str(tmp_path / "session.dylib"),
        "DYLD_LIBRARY_PATH": str(tmp_path),
        "PATH": str(tmp_path),
        "MIRAGE_TEST_VERSION_ENV": "session",
    }
    probe = tmp_path / "python-probe"
    probe.write_text(
        f"#!{sys.executable}\nimport json, os\n"
        f"keys = {list(session)!r}\n"
        "print(json.dumps({k: os.environ.get(k) for k in keys}))\n"
    )
    probe.chmod(0o755)
    runtime = LocalRuntime(config={"home": str(probe)})
    baseline = await runtime.version({})
    expected = json.loads(baseline.stdout)
    assert expected["MIRAGE_TEST_VERSION_ENV"] is None
    ws = Workspace({"/": RAMVFS()}, mode=mode, runtimes=[runtime, "workspace"])
    try:
        for line in ["python --version", "python3 -V", "python -VV"]:
            io = await ws.shell(line, env=session)
            assert io.exit_code == 0
            assert json.loads(await io.stdout_str()) == expected
            assert await io.stderr_str() == ""
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_read_only_version_does_not_run_startup_code(tmp_path):
    marker = tmp_path / "startup-ran"
    (tmp_path / "sitecustomize.py").write_text(
        f"open({str(marker)!r}, 'w').write('ran')\n"
    )
    env = {"PYTHONPATH": str(tmp_path)}
    runtime = LocalRuntime(config={"home": sys.executable})
    ws = Workspace(
        {"/": RAMVFS()}, mode=MountMode.READ, runtimes=[runtime, "workspace"]
    )
    try:
        for line in ["python --version", "python3 -V", "python -VV"]:
            io = await ws.shell(line, env=env)
            assert io.exit_code == 0
            assert (
                await io.stdout_str() == f"Python {sys.version.split()[0]}\n"
            )
            assert await io.stderr_str() == ""
            assert not marker.exists()
        refused = await ws.shell("python -c 'pass'", env=env)
        assert refused.exit_code == 126
        assert not marker.exists()
        control = await _run(runtime, Program(code="pass"), env=env)
        assert control.exit_code == 0
        assert marker.read_text() == "ran"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_local_cancellation_kills_subprocess():
    runtime = LocalRuntime()
    task = asyncio.ensure_future(
        _run(runtime, Program(code="import time; time.sleep(30)"))
    )
    await asyncio.sleep(0.3)
    start = time.monotonic()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert time.monotonic() - start < 5  # killed, not waited out


def test_reach_is_process():
    # The subprocess sees the host filesystem and network: entry points the
    # workspace gate never sees, so a world holding this runtime may
    # not claim a sandbox.
    assert LocalRuntime.reach == "process"


TRACEBACK_CASES = json.loads(
    (
        Path(__file__).resolve().parents[5]
        / "integ/fixtures/runtime/python_errors.json"
    ).read_text()
)


@pytest.mark.asyncio
@pytest.mark.parametrize("case", TRACEBACK_CASES)
async def test_user_tracebacks_match_cpython(case):
    runtime = LocalRuntime()
    try:
        result = await _run(runtime, Program(code=case["code"]))
        assert result.exit_code == 1
        native = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            case["code"],
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await native.communicate()
        assert result.stderr == stderr
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_close_kills_an_interpreter_still_running():
    runtime = LocalRuntime()
    run = asyncio.create_task(
        _run(runtime, Program(code="import time; time.sleep(30)"))
    )
    while not runtime._children:
        await asyncio.sleep(0.01)
    started = time.monotonic()
    await runtime.close()
    result = await asyncio.wait_for(run, timeout=5)
    assert result.exit_code != 0
    assert time.monotonic() - started < 5


def test_close_leaves_a_blocked_loops_child_to_that_loop():
    # A sync `with` block exits inside its caller's loop, which runs
    # nothing until the exit returns, while the close runs on another.
    # The close waits until that loop is blocked: closing while it still
    # ran would let it reap the child before it ever saw one.
    runtime = LocalRuntime()
    owner = asyncio.new_event_loop()
    blocked = threading.Event()
    release = threading.Event()
    results = []

    async def start_then_block():
        run = asyncio.ensure_future(
            _run(runtime, Program(code="import time; time.sleep(30)"))
        )
        while not runtime._children:
            await asyncio.sleep(0.01)
        blocked.set()
        release.wait(10)
        results.append(await run)

    worker = threading.Thread(
        target=owner.run_until_complete,
        args=(start_then_block(),),
        daemon=True,
    )
    worker.start()
    try:
        assert blocked.wait(10)
        asyncio.run(asyncio.wait_for(runtime.close(), timeout=5))
    finally:
        release.set()
        worker.join(10)
        if worker.is_alive():
            # The loop never blocked or never finished: kill what it ran
            # and stop it, so a failed run leaves no loop behind.
            for child in list(runtime._children):
                child.kill()
            owner.call_soon_threadsafe(owner.stop)
            worker.join(10)
        owner.close()
    assert results[0].exit_code != 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "yes | perl -ne 'print; exit'",
        "perl -e '$|=1; print \"y\\n\" while 1' | head -1",
    ],
)
async def test_external_streams_infinite_pipes_and_closes_children(line):
    runtime = LocalRuntime(captures=("@external",))
    ws = Workspace(
        {"/": RAMVFS()}, mode=MountMode.EXEC, runtimes=[runtime, "workspace"]
    )
    try:
        async with asyncio.timeout(5):
            result = await ws.shell(line)
        assert result.exit_code == 0, await result.stderr_str()
        assert await result.stdout_str() == "y\n"
        assert not runtime._children
    finally:
        await ws.close()


class RecordingLocalRuntime(LocalRuntime):
    """A local runtime that records the programs it would run."""

    def __init__(self, **options):
        super().__init__(**options)
        self.programs: list[Program] = []

    async def interpret(self, engine, program, ctx):
        self.programs.append(program)
        return RunResult(stdout=b"ran\n", stderr=None, exit_code=0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "profile",
    [
        {"paths": {"hide": ["/data/secret"]}},
        {"commands": {"deny": [{"paths": ["/data/secret"], "reason": "x"}]}},
        {"mounts": {"/data": "r"}},
    ],
)
async def test_a_session_restriction_refuses_every_program(tmp_path, profile):
    runtime = RecordingLocalRuntime()
    ws = Workspace(
        {"/data": DiskVFS(str(tmp_path))},
        mode=MountMode.EXEC,
        profiles={"agent": profile},
        runtimes=[runtime, "workspace"],
    )
    try:
        agent = await ws.session("agent", profile="agent")
        result = await agent.shell("python3 -c pass")
        assert (result.exit_code, result.stdout, result.stderr) == (
            126,
            b"",
            b"local: Permission denied\n",
        )
        assert runtime.programs == []
        other = await ws.session("other")
        assert (await other.shell("python3 -c pass")).stdout == b"ran\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_file_the_program_makes_shows_in_the_next_listing(tmp_path):
    root = str(tmp_path.resolve())
    with Workspace(
        {root: DiskVFS(root=root)},
        mode=MountMode.EXEC,
        runtimes=[LocalRuntime(), "workspace"],
    ) as ws:
        assert await (await ws.shell(f"ls {root}")).stdout_str() == ""
        made = await ws.shell(
            f"python3 -c \"open('{root}/made.txt', 'w').write('x')\""
        )
        assert made.exit_code == 0
        listed = await ws.shell(f"ls {root}")
        assert await listed.stdout_str() == "made.txt\n"
