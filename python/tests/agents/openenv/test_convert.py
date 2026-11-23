import pytest

pytest.importorskip("openenv")

from mirage import RAMVFS, MountMode, Workspace
from mirage.agents.openenv.convert import (
    io_to_observation,
    refusal_of,
    tool_to_observation,
)
from mirage.agents.openenv.types import Refusal
from mirage.types import PolicyDecision
from mirage.workspace.tools.tool_operations import ToolResult


def test_refusal_of_copies_the_policys_record():
    decision = PolicyDecision(
        kind="pending", reason="needs approval", ask_id="ask-1"
    )

    assert refusal_of(None) is None
    assert refusal_of(decision) == Refusal(
        kind="pending", reason="needs approval", ask_id="ask-1"
    )


def test_a_tool_answer_is_stdout_or_a_failed_stderr():
    ok = tool_to_observation("read", ToolResult("     1\thi\n"), "/data")
    failed = tool_to_observation("read", ToolResult("Error: gone", True), "/")

    assert (ok.stdout, ok.stderr, ok.exit_code, ok.cwd) == (
        "     1\thi\n",
        "",
        0,
        "/data",
    )
    assert (failed.stdout, failed.stderr, failed.exit_code) == (
        "",
        "Error: gone",
        1,
    )


@pytest.mark.asyncio
async def test_a_shell_result_keeps_its_streams_apart():
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={"default": {"commands": {"rm": "deny"}}},
    )
    try:
        ran = await io_to_observation(
            await ws.shell("echo out; ls /missing"), "/"
        )
        refused = await io_to_observation(await ws.shell("rm /data/x"), "/")
    finally:
        await ws.close()

    assert ran.stdout == "out\n"
    assert "/missing" in ran.stderr
    assert ran.exit_code == 2
    assert ran.refusal is None
    assert refused.exit_code != 0
    assert refused.refusal == Refusal(
        kind="deny", reason="rm is not allowed", policy="PermissionsPolicy"
    )
