import pytest
from mcp import Client
from mcp.shared.exceptions import MCPError
from mcp.types import INVALID_PARAMS, CallToolResult, Tool

from mirage import RAMVFS, MountMode, Workspace
from mirage.server.mcp.server import MirageMcpServer


async def list_tools(server: MirageMcpServer) -> list[Tool]:
    async with Client(server.server) as client:
        return (await client.list_tools()).tools


async def call_tool(
    server: MirageMcpServer, name: str, arguments: dict
) -> CallToolResult:
    async with Client(server.server) as client:
        return await client.call_tool(name, arguments)


@pytest.fixture
def workspace():
    return Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)


@pytest.fixture
def server(workspace):
    return MirageMcpServer(workspace)


@pytest.mark.asyncio
async def test_lists_the_tools(server):
    tools = await list_tools(server)
    assert sorted(t.name for t in tools) == [
        "edit",
        "glob",
        "grep",
        "ls",
        "read",
        "session",
        "shell",
        "write",
    ]


@pytest.mark.asyncio
async def test_read_only_tools_are_annotated(server):
    annotations = {
        t.name: t.annotations and t.annotations.read_only_hint
        for t in await list_tools(server)
    }
    assert annotations["read"] is True
    assert annotations["ls"] is True
    assert annotations["grep"] is True
    assert annotations["glob"] is True
    assert annotations["shell"] is None
    assert annotations["write"] is None
    assert annotations["edit"] is None


@pytest.mark.asyncio
async def test_every_tool_declares_its_required_arguments(server):
    required = {
        t.name: t.input_schema["required"] for t in await list_tools(server)
    }
    assert required["shell"] == ["command"]
    assert required["read"] == ["path"]
    assert required["write"] == ["path", "content"]
    assert required["edit"] == ["path", "old_string", "new_string"]
    assert required["ls"] == ["path"]
    assert required["grep"] == ["pattern", "path"]
    assert required["glob"] == ["pattern"]


@pytest.mark.asyncio
async def test_read_and_edit_advertise_their_argument_types(server):
    tools = {t.name: t for t in await list_tools(server)}
    read = tools["read"].input_schema["properties"]
    edit = tools["edit"].input_schema["properties"]
    assert read["path"]["type"] == "string"
    assert (read["offset"]["type"], read["offset"]["minimum"]) == (
        "integer",
        0,
    )
    assert (read["limit"]["type"], read["limit"]["minimum"]) == ("integer", 1)
    assert edit["replace_all"]["type"] == "boolean"
    for tool in tools.values():
        for name, prop in tool.input_schema["properties"].items():
            assert prop["description"], (tool.name, name)


@pytest.mark.asyncio
async def test_call_shell(server):
    result = await call_tool(server, "shell", {"command": "echo hi"})
    assert "hi" in result.content[0].text
    assert result.is_error is False


@pytest.mark.asyncio
async def test_call_write_then_read(server):
    written = await call_tool(
        server, "write", {"path": "/a.txt", "content": "x\ny\n"}
    )
    assert written.is_error is False
    read = await call_tool(server, "read", {"path": "/a.txt"})
    assert read.content[0].text == "     1\tx\n     2\ty\n"


@pytest.mark.asyncio
async def test_call_read_offset_and_limit(server):
    await call_tool(
        server, "write", {"path": "/m.txt", "content": "a\nb\nc\n"}
    )
    read = await call_tool(
        server, "read", {"path": "/m.txt", "offset": 1, "limit": 1}
    )
    assert read.content[0].text == "     2\tb\n"


@pytest.mark.asyncio
async def test_call_edit(server, workspace):
    await workspace.vfs.write("/e.txt", b"foo bar")
    result = await call_tool(
        server,
        "edit",
        {"path": "/e.txt", "old_string": "bar", "new_string": "qux"},
    )
    assert result.is_error is False
    assert await workspace.vfs.read("/e.txt") == b"foo qux"


@pytest.mark.asyncio
async def test_call_ls_and_grep(server):
    await call_tool(
        server, "write", {"path": "/d/a.txt", "content": "needle\n"}
    )
    listing = await call_tool(server, "ls", {"path": "/d"})
    assert "a.txt" in listing.content[0].text
    found = await call_tool(server, "grep", {"pattern": "needle", "path": "/"})
    assert "needle" in found.content[0].text
    globbed = await call_tool(server, "glob", {"pattern": "**/*.txt"})
    assert globbed.content[0].text == "/d/a.txt\n"


@pytest.mark.asyncio
async def test_failure_sets_is_error(server):
    result = await call_tool(server, "read", {"path": "/missing.txt"})
    assert result.is_error is True
    assert "not found" in result.content[0].text


@pytest.mark.asyncio
async def test_unknown_tool_is_a_protocol_error(server):
    async with Client(server.server) as client:
        with pytest.raises(MCPError) as caught:
            await client.call_tool("nope", {})
    assert caught.value.code == INVALID_PARAMS
    assert caught.value.message == "Tool nope not found"


@pytest.mark.asyncio
async def test_missing_argument_is_an_error_result(server):
    result = await call_tool(server, "read", {})
    assert result.is_error is True
    assert result.content[0].text == (
        "Input validation error: Invalid arguments for tool read: "
        "'path' is a required property"
    )


@pytest.mark.asyncio
async def test_argument_outside_the_schema_is_an_error_result(server):
    result = await call_tool(server, "read", {"path": "/a.txt", "offset": -1})
    assert result.is_error is True
    assert "Input validation error" in result.content[0].text


def test_server_advertises_name_and_version(workspace):
    from mirage import __version__

    server = MirageMcpServer(workspace)
    assert server.server.name == "mirage"
    assert server.server.version == __version__


@pytest.mark.asyncio
async def test_stale_write_protection_reaches_the_tools(workspace):
    server = MirageMcpServer(workspace, stale_write_protection=False)
    await workspace.vfs.write("/a.txt", b"hello world")
    await call_tool(server, "read", {"path": "/a.txt"})
    await workspace.vfs.write("/a.txt", b"hello there")
    result = await call_tool(
        server,
        "edit",
        {"path": "/a.txt", "old_string": "hello", "new_string": "goodbye"},
    )
    assert result.is_error is False


@pytest.mark.asyncio
async def test_explicit_default_session_shares_the_read_ledger(
    workspace, server
):
    await workspace.vfs.write("/doc.txt", b"first")
    await call_tool(server, "read", {"path": "/doc.txt"})
    await workspace.vfs.write("/doc.txt", b"external")
    result = await call_tool(
        server,
        "edit",
        {
            "path": "/doc.txt",
            "old_string": "external",
            "new_string": "changed",
            "session_id": workspace.default_session_id,
        },
    )
    assert result.is_error
    assert "changed since it was last read" in result.content[0].text
