import asyncio

import pytest

from mirage import Workspace
from mirage.commands.cli.types import CLISpec
from mirage.io import IOResult
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


@pytest.mark.asyncio
async def test_background_and_functions_release_programs_after_teardown(
    monkeypatch,
):
    programs = []
    original = scope.parse_program

    def parse(source):
        program = original(source)
        programs.append(program)
        return program

    monkeypatch.setattr(scope, "parse_program", parse)
    ws = Workspace({})
    entered, gate = asyncio.Event(), asyncio.Event()

    async def stall(inv):
        entered.set()
        await gate.wait()
        return None, IOResult()

    ws.register_cli("stall", CLISpec(name="stall", fn=stall))
    try:
        await ws.shell("f() { echo retained; }")
        stored = ws.get_session(ws.default_session_id).functions["f"]
        assert isinstance(stored[0], ProgramNode)
        defining = stored[0].program
        references = defining.references
        await ws.explain("cd /; f")
        assert defining.references == references
        await ws.shell("{ stall; f; } &")
        await entered.wait()
        await ws.shell("unset -f f")
        assert defining.references > 0
        gate.set()
        await ws.shell("wait")
        assert defining.references == 0
        await ws.shell("f() { unset -f f; echo alive; }; f")
        await ws.shell(
            "f() { :; }; f | f; echo x | xargs -P 2 -n 1 f; (f); bash -c f; unset -f f"
        )
    finally:
        gate.set()
        await ws.close()
    assert all(program.references == 0 for program in programs)


@pytest.mark.asyncio
async def test_substitution_does_not_mutate_parent_while_suspended():
    ws = Workspace({})
    entered, gate = asyncio.Event(), asyncio.Event()

    async def stall(inv):
        entered.set()
        await gate.wait()
        return None, IOResult()

    ws.register_cli("stall", CLISpec(name="stall", fn=stall))
    pending = asyncio.create_task(
        ws.shell(
            'X=parent; value=$(X=child; stall; echo "$X"); echo "$X:$value"'
        )
    )
    try:
        await asyncio.wait_for(entered.wait(), 5)
        assert ws.get_session(ws.default_session_id).env["X"] == "parent"
        gate.set()
        io = await pending
        assert await io.materialize_stdout() == b"parent:child\n"
        assert io.exit_code == 0
    finally:
        gate.set()
        await pending
        await ws.close()
