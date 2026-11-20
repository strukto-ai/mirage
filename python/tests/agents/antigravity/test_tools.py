import pytest

antigravity = pytest.importorskip("google.antigravity")

from google.antigravity.tools.tool_runner import ToolRunner  # noqa: E402

from mirage import RAMVFS, MountMode, Workspace  # noqa: E402
from mirage.agents.antigravity.tools import mirage_tools  # noqa: E402


@pytest.fixture
def workspace():
    return Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)


@pytest.fixture
def tools(workspace):
    return {tool.__name__: tool for tool in mirage_tools(workspace)}


def test_each_tool_carries_its_description_and_schema(tools):
    shell = tools["shell"]
    assert shell.__doc__
    assert shell.input_schema["type"] == "object"
    assert "command" in shell.input_schema["properties"]


@pytest.mark.asyncio
async def test_shell_runs_in_the_workspace(tools, workspace):
    await workspace.vfs.write("/pipe.txt", b"aaa\nbbb\naaa\n")
    out = await tools["shell"](command="sort -u /pipe.txt | wc -l")
    assert out.strip() == "2"


@pytest.mark.asyncio
async def test_write_then_read(tools):
    await tools["write"](path="/notes.txt", content="hello\n")
    assert "hello" in await tools["read"](path="/notes.txt")


@pytest.mark.asyncio
async def test_a_failed_call_raises_the_sdk_error(tools):
    with pytest.raises(antigravity.ToolExecutionError) as failed:
        await tools["read"](path="/missing.txt")
    assert failed.value.tool_name == "read"
    assert "not found" in str(failed.value)


@pytest.mark.asyncio
async def test_the_sdk_tool_runner_calls_them(workspace):
    runner = ToolRunner(mirage_tools(workspace))
    ok, failed = await runner.process_tool_calls(
        [
            antigravity.types.ToolCall(
                name="shell", args={"command": "echo hi"}, id="1"
            ),
            antigravity.types.ToolCall(
                name="read", args={"path": "/missing.txt"}, id="2"
            ),
        ]
    )
    assert (ok.id, ok.result.strip(), ok.error) == ("1", "hi", None)
    assert failed.id == "2"
    assert "not found" in failed.error
