import pytest

from mirage import MountMode, RAMResource, Workspace
from mirage.agents.mcp.server import MirageMcpServer, create_mirage_mcp_server


@pytest.fixture
def workspace():
    return Workspace({"/": RAMResource()}, mode=MountMode.WRITE)


@pytest.fixture
def server(workspace):
    return MirageMcpServer(workspace)


@pytest.mark.asyncio
async def test_lists_the_six_tools(server):
    tools = await server.list_tools()
    assert sorted(t.name for t in tools) == [
        "edit", "execute_command", "grep", "ls", "read", "write"
    ]


@pytest.mark.asyncio
async def test_read_only_tools_are_annotated(server):
    annotations = {
        t.name: t.annotations and t.annotations.readOnlyHint
        for t in await server.list_tools()
    }
    assert annotations["read"] is True
    assert annotations["ls"] is True
    assert annotations["grep"] is True
    assert annotations["write"] is None
    assert annotations["edit"] is None


@pytest.mark.asyncio
async def test_every_tool_declares_its_required_arguments(server):
    required = {
        t.name: t.inputSchema["required"]
        for t in await server.list_tools()
    }
    assert required["execute_command"] == ["command"]
    assert required["read"] == ["path"]
    assert required["write"] == ["path", "content"]
    assert required["edit"] == ["path", "old_string", "new_string"]
    assert required["ls"] == ["path"]
    assert required["grep"] == ["pattern", "path"]


@pytest.mark.asyncio
async def test_call_execute_command(server):
    result = await server.call_tool("execute_command", {"command": "echo hi"})
    assert "hi" in result.content[0].text
    assert result.isError is False


@pytest.mark.asyncio
async def test_call_write_then_read(server):
    written = await server.call_tool("write", {
        "path": "/a.txt",
        "content": "x\ny\n"
    })
    assert written.isError is False
    read = await server.call_tool("read", {"path": "/a.txt"})
    assert read.content[0].text == "     1\tx\n     2\ty\n"


@pytest.mark.asyncio
async def test_call_read_offset_and_limit(server):
    await server.call_tool("write", {"path": "/m.txt", "content": "a\nb\nc\n"})
    read = await server.call_tool("read", {
        "path": "/m.txt",
        "offset": 1,
        "limit": 1
    })
    assert read.content[0].text == "     2\tb\n"


@pytest.mark.asyncio
async def test_call_edit(server, workspace):
    await workspace.fs.write("/e.txt", b"foo bar")
    result = await server.call_tool("edit", {
        "path": "/e.txt",
        "old_string": "bar",
        "new_string": "qux"
    })
    assert result.isError is False
    assert await workspace.fs.read("/e.txt") == b"foo qux"


@pytest.mark.asyncio
async def test_call_ls_and_grep(server):
    await server.call_tool("write", {
        "path": "/d/a.txt",
        "content": "needle\n"
    })
    listing = await server.call_tool("ls", {"path": "/d"})
    assert "a.txt" in listing.content[0].text
    found = await server.call_tool("grep", {"pattern": "needle", "path": "/"})
    assert "needle" in found.content[0].text


@pytest.mark.asyncio
async def test_failure_sets_is_error(server):
    result = await server.call_tool("read", {"path": "/missing.txt"})
    assert result.isError is True
    assert "not found" in result.content[0].text


@pytest.mark.asyncio
async def test_unknown_tool_raises(server):
    with pytest.raises(ValueError, match="unknown tool"):
        await server.call_tool("nope", {})


def test_server_advertises_name_and_version(workspace):
    from mirage import __version__
    server = create_mirage_mcp_server(workspace)
    assert server.server.name == "mirage"
    assert server.server.version == __version__


@pytest.mark.asyncio
async def test_stale_write_protection_reaches_the_tools(workspace):
    server = MirageMcpServer(workspace, stale_write_protection=False)
    await workspace.fs.write("/a.txt", b"hello world")
    await server.call_tool("read", {"path": "/a.txt"})
    await workspace.fs.write("/a.txt", b"hello there")
    result = await server.call_tool("edit", {
        "path": "/a.txt",
        "old_string": "hello",
        "new_string": "goodbye"
    })
    assert result.isError is False
