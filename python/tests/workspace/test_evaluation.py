import asyncio

import pytest
import pytest_asyncio

from mirage import Workspace
from mirage.commands.cli.types import CLISpec
from mirage.io import IOResult
from mirage.shell.console import Channel
from mirage.shell.parse import scope
from mirage.shell.parse.program import ProgramNode
from mirage.workspace.evaluation import child_session, execution_session
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import seed_var


def test_execution_frames_do_not_live_on_persistent_sessions():
    state = SessionState(session_id="s")
    first = execution_session(state)
    first._diagnostics.append("first")
    first._cmdsub_seq = 4
    seed_var(first, "NAME", "parent")
    second = execution_session(state)
    child = child_session(first)
    seed_var(child, "NAME", "child")
    assert second._diagnostics == []
    assert second._cmdsub_seq == 0
    assert state.env["NAME"] == "parent"
    assert "_diagnostics" not in vars(state)


@pytest_asyncio.fixture
async def owned_workspace(monkeypatch):
    programs = []
    original = scope.parse_program

    def parse(source):
        program = original(source)
        programs.append(program)
        return program

    monkeypatch.setattr(scope, "parse_program", parse)
    ws = Workspace({})
    try:
        yield ws, programs
    finally:
        await ws.close()
        assert all(program.references == 0 for program in programs)


def install_stall(ws):
    entered, gate = asyncio.Event(), asyncio.Event()

    async def stall(inv):
        entered.set()
        await gate.wait()
        return None, IOResult()

    ws.register_cli("stall", CLISpec(name="stall", fn=stall))
    return entered, gate


@pytest.mark.asyncio
async def test_background_function_survives_late_substitutions_and_unset(
    owned_workspace,
):
    ws, programs = owned_workspace
    entered, gate = install_stall(ws)
    try:
        await ws.shell("f() { echo retained; }")
        stored = ws.get_session(ws.default_session_id).functions["f"]
        assert isinstance(stored[0], ProgramNode)
        defining = stored[0].program
        await ws.shell('{ stall; echo "$(f):$(</dev/null)"; } &')
        await asyncio.wait_for(entered.wait(), 5)
        await ws.shell("unset -f f")
        assert defining.references > 0
        job = ws.job_table.get(1, ws.default_session_id)
        assert job is not None
        gate.set()
        await ws.shell("wait")
        assert job.exit_code == 0
        assert await job.console.snapshot(Channel.STDERR) == b""
        assert await job.console.snapshot(Channel.STDOUT) == b"retained:\n"
        assert defining.references == 0
    finally:
        gate.set()


@pytest.mark.asyncio
async def test_explain_borrows_function_programs(owned_workspace):
    ws, programs = owned_workspace
    await ws.shell("f() { echo retained; }")
    before = [program.references for program in programs]
    await ws.explain("cd /; f")
    assert [
        program.references for program in programs[: len(before)]
    ] == before


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("command", "stdout", "exit_code"),
    [
        ("f() { unset -f f; echo alive; }; f", b"alive\n", 0),
        ("f() { unset -f f; return 7; }; f", b"", 7),
        ("f() { f() { echo new; }; echo old; }; f; f", b"old\nnew\n", 0),
        ("f() { echo alive; }; f | cat", b"alive\n", 0),
        (
            'f() { echo "$1"; }; printf "x\\nx\\n" | xargs -P 2 -n 1 f',
            b"x\nx\n",
            0,
        ),
        ("(f() { echo alive; }; f)", b"alive\n", 0),
        ("bash -c 'f() { echo alive; }; f'", b"alive\n", 0),
    ],
    ids=[
        "self-unset",
        "early-return",
        "self-redefinition",
        "pipeline",
        "parallel-xargs",
        "subshell",
        "nested-bash",
    ],
)
async def test_function_programs_release_after_execution(
    owned_workspace, command, stdout, exit_code
):
    ws, programs = owned_workspace
    io = await ws.shell(command)
    assert io.exit_code == exit_code
    assert await io.materialize_stdout() == stdout
    assert await io.materialize_stderr() == b""
    await ws.shell("unset -f f")
    assert all(program.references == 0 for program in programs)
