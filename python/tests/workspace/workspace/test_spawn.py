import asyncio

import pytest

from mirage import Workspace
from mirage.execution.process.types import SpawnRequest
from mirage.runtime.python.monty.runtime import MontyRuntime
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS


@pytest.mark.asyncio
async def test_spawn_preserves_literal_argv_and_uses_admission():
    ws = Workspace({"/data": RAMVFS()}, runtimes=[])
    try:
        argv = ("printf", "%s|", "a b", "$(echo bad)", "*", "a'b", "", "`")
        result = await ws.spawn(SpawnRequest(argv)).communicate()
        assert result.stdout == b"a b|$(echo bad)|*|a'b||`|"
        ws.create_session(
            "limited", profile={"commands": {"deny": ["printf"]}}
        )
        refused = await ws.spawn(SpawnRequest(argv), "limited").communicate()
        assert refused.exit_code != 0
        assert refused.stdout == b""
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_spawn_drains_pipes_and_isolates_session_state():
    ws = Workspace({}, runtimes=[])
    try:
        data = b"x" * 300000
        result = await asyncio.wait_for(
            ws.spawn(SpawnRequest(("cat",))).communicate(data), 3
        )
        assert result.stdout == data
        result = await ws.spawn(
            SpawnRequest(("pwd",), cwd=PathSpec.from_str_path("/tmp"))
        ).communicate()
        assert result.stdout == b"/tmp\n"
        assert (await ws.shell("pwd")).stdout == b"/\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_profile_session_processes_and_revocation():
    ws = Workspace({}, runtimes=[])
    try:
        a = ws.create_session("a")
        ws.create_session("b")
        child = ws.spawn(SpawnRequest(("sleep", "30")), "a")
        child.stdin.close()
        view = ws._session_processes(a)
        assert view.probe(child.pid)
        assert not ws.process_table.for_session("b").probe(child.pid)
        await ws.set_session_profile("a", {"processes": {"max": 1}})
        assert not view.probe(child.pid)
        assert view.spawn is not None
        with pytest.raises(PermissionError):
            view.spawn(SpawnRequest(("true",)))
        await asyncio.wait_for(child.wait(), 2)
        held = ws.spawn(SpawnRequest(("sleep", "30")), "a")
        with pytest.raises(BlockingIOError):
            ws.spawn(SpawnRequest(("true",)), "a")
        held.terminate()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_terminate_stops_a_child_with_the_signal_it_names():
    ws = Workspace({}, runtimes=[])
    try:
        child = ws.spawn(SpawnRequest(("sleep", "30")))
        child.terminate(15)
        info = await asyncio.wait_for(child.wait(), 5)
        assert info.exit == 143
        assert child.poll() == 143
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_monty_keeps_unsupported_subprocess_import():
    ws = Workspace({}, runtimes=[MontyRuntime()], mode=MountMode.EXEC)
    try:
        result = await asyncio.wait_for(
            ws.spawn(
                SpawnRequest(("python", "-c", "import subprocess"))
            ).communicate(),
            20,
        )
        assert result.exit_code == 1
        assert b"ModuleNotFoundError" in result.stderr
        result = await ws.spawn(
            SpawnRequest(("python", "-c", "mirage_run([])"))
        ).communicate()
        assert result.exit_code == 1
        assert b"NameError" in result.stderr
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_spawn_uses_programs_and_exported_environment():
    ws = Workspace({}, runtimes=[])
    try:
        await ws.shell(
            "LOCAL=private; export PARENT=outer; "
            "f() { echo wrong; }; printf() { echo wrong; }"
        )
        for name in ("f", "cd", "missing"):
            with pytest.raises(FileNotFoundError):
                ws.spawn(SpawnRequest((name,)))
        result = await ws.spawn(
            SpawnRequest(("printf", "-v", "name", "value"))
        ).communicate()
        assert result.stdout == b"-v"
        result = await ws.spawn(
            SpawnRequest(("printenv", "LOCAL"))
        ).communicate()
        assert result.exit_code == 1
        result = await ws.spawn(
            SpawnRequest(("printenv", "PARENT"), env={}, replace_env=True)
        ).communicate()
        assert result.exit_code == 1
        result = await ws.spawn(
            SpawnRequest(("printenv", "PARENT"), env={"PARENT": "child"})
        ).communicate()
        assert result.stdout == b"child\n"
        assert (await ws.shell('printf %s "$PARENT"')).stdout == b"outer"
        result = await ws.spawn(
            SpawnRequest(
                ("sh", "-c", "printf out; printf err >&2"), merge_stderr=True
            )
        ).communicate()
        assert result.stdout == b"outerr"
        assert result.stderr == b""
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_spawn_output_obeys_the_command_limit_wherever_the_parent_writes():
    ws = Workspace({}, runtimes=[])
    try:
        session = ws.create_session(
            "capped", profile={"command_limits": {"cat": {"max_bytes": 4}}}
        )
        piped = session.fork()
        piped.terminal_output = False
        result = await ws._spawn_for_session(
            SpawnRequest(("cat",)), piped
        ).communicate(b"0123456789")
        assert result.stdout == b"0123"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_top_level_line_cannot_bypass_spawn_process_cap():
    ws = Workspace({"/data": RAMVFS()}, runtimes=[])
    session = ws.create_session("capped", profile={"processes": {"max": 1}})
    child = ws.spawn(SpawnRequest(("sleep", "30")), "capped")
    try:
        result = await ws.shell(
            "echo leaked > /data/file", session_id="capped"
        )
        assert result.exit_code == 254
        assert result.stderr == (
            b"bash: fork: Resource temporarily unavailable\n"
        )
        assert session.process_id is None
        assert len(ws.process_table.live()) == 1
        assert (await ws.shell("test ! -e /data/file")).exit_code == 0
        child.terminate()
        await child.wait()
        result = await ws.shell("echo $?; echo ok", session_id="capped")
        assert result.stdout == b"254\nok\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_spawned_command_records_under_its_own_process():
    # The child's file calls carry the process id its handle bound, not
    # the spawning caller's.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE, runtimes=[])
    try:
        await ws.vfs.write("/data/f", b"x\n")
        del ws.vfs.records[:]
        child = ws.spawn(SpawnRequest(("cat", "/data/f")))
        assert (await child.communicate()).stdout == b"x\n"
        info = await child.wait()
        reads = [r for r in ws.vfs.records if r.path == "/data/f"]
        assert reads
        assert {r.process for r in reads} == {str(info.id)}
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_the_workspace_processes_block_caps_each_session_under_a_profile():
    ws = Workspace(
        {"/data": RAMVFS()},
        runtimes=[],
        processes={"max": 1},
        profiles={"batch": {"processes": {"max": 4}}},
    )
    try:
        assert ws.get_session(ws.default_session_id).processes.max == 1
        assert ws.create_session("plain").processes.max == 1
        assert ws.create_session("batch", profile="batch").processes.max == 4
        child = ws.spawn(SpawnRequest(("sleep", "30")), "plain")
        result = await ws.shell("echo leaked", session_id="plain")
        assert result.exit_code == 254
        child.terminate()
        await child.wait()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_fork_bomb_meets_the_default_cap():
    ws = Workspace({"/data": RAMVFS()}, runtimes=[])
    try:
        result = await ws.shell("b() { b | b; }; b")
        assert result.exit_code == 254
        assert b"bash: fork: Resource temporarily unavailable" in result.stderr
        assert len(ws.process_table.live()) == 0
    finally:
        await ws.close()
