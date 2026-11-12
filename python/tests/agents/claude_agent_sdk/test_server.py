import pytest

pytest.importorskip("claude_agent_sdk")

from mcp import Client
from mcp.types import CallToolResult

from mirage import RAMVFS, MountMode, Workspace
from mirage.agents.claude_agent_sdk.server import MirageServer


async def call(server, name: str, args: dict) -> CallToolResult:
    async with Client(server["instance"]) as client:
        return await client.call_tool(name, args)


@pytest.fixture
def workspace():
    return Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)


@pytest.fixture
def tools(workspace):
    return MirageServer(workspace)


@pytest.mark.asyncio
async def test_shell_echo(tools):
    result = await call(tools, "shell", {"command": "echo hello"})
    assert "hello" in result.content[0].text
    assert not result.is_error


@pytest.mark.asyncio
async def test_shell_pipe(tools, workspace):
    await workspace.vfs.write("/pipe.txt", b"aaa\nbbb\naaa\n")
    result = await call(
        tools, "shell", {"command": "cat /pipe.txt | sort | uniq | wc -l"}
    )
    assert "2" in result.content[0].text


@pytest.mark.asyncio
async def test_read_file(tools, workspace):
    await workspace.vfs.write("/hello.txt", b"line1\nline2\nline3\n")
    result = await call(tools, "read", {"path": "/hello.txt"})
    text = result.content[0].text
    assert "line1" in text
    assert "line2" in text
    assert not result.is_error


@pytest.mark.asyncio
async def test_read_file_with_offset_and_limit(tools, workspace):
    await workspace.vfs.write("/multi.txt", b"a\nb\nc\nd\ne\n")
    result = await call(
        tools, "read", {"path": "/multi.txt", "offset": 1, "limit": 2}
    )
    text = result.content[0].text
    assert "b" in text
    assert "c" in text
    assert "a" not in text
    assert "d" not in text


@pytest.mark.asyncio
async def test_read_file_not_found(tools):
    result = await call(tools, "read", {"path": "/nonexistent.txt"})
    assert result.is_error
    assert "not found" in result.content[0].text


@pytest.mark.asyncio
async def test_write_file(tools, workspace):
    result = await call(
        tools, "write", {"path": "/new.txt", "content": "hello world"}
    )
    assert not result.is_error
    data = await workspace.vfs.read("/new.txt")
    assert data == b"hello world"


@pytest.mark.asyncio
async def test_write_refuses_an_unread_file(tools, workspace):
    await workspace.vfs.write("/exists.txt", b"first")
    result = await call(
        tools, "write", {"path": "/exists.txt", "content": "second"}
    )
    assert result.is_error
    assert "read all of it before overwriting it" in result.content[0].text


@pytest.mark.asyncio
async def test_edit_file(tools, workspace):
    await workspace.vfs.write("/edit.txt", b"foo bar baz")
    result = await call(
        tools,
        "edit",
        {"path": "/edit.txt", "old_string": "bar", "new_string": "qux"},
    )
    assert not result.is_error
    data = await workspace.vfs.read("/edit.txt")
    assert data == b"foo qux baz"


@pytest.mark.asyncio
async def test_edit_file_not_found(tools):
    result = await call(
        tools,
        "edit",
        {"path": "/missing.txt", "old_string": "x", "new_string": "y"},
    )
    assert result.is_error
    assert "not found" in result.content[0].text


@pytest.mark.asyncio
async def test_edit_string_not_found(tools, workspace):
    await workspace.vfs.write("/nostr.txt", b"hello world")
    result = await call(
        tools,
        "edit",
        {"path": "/nostr.txt", "old_string": "xyz", "new_string": "abc"},
    )
    assert result.is_error
    assert "not found" in result.content[0].text


@pytest.mark.asyncio
async def test_edit_multiple_occurrences_without_replace_all(tools, workspace):
    await workspace.vfs.write("/multi.txt", b"aa bb aa")
    result = await call(
        tools,
        "edit",
        {"path": "/multi.txt", "old_string": "aa", "new_string": "cc"},
    )
    assert result.is_error
    assert "replace_all" in result.content[0].text


@pytest.mark.asyncio
async def test_edit_replace_all(tools, workspace):
    await workspace.vfs.write("/all.txt", b"aa bb aa")
    result = await call(
        tools,
        "edit",
        {
            "path": "/all.txt",
            "old_string": "aa",
            "new_string": "cc",
            "replace_all": True,
        },
    )
    assert not result.is_error
    data = await workspace.vfs.read("/all.txt")
    assert data == b"cc bb cc"


@pytest.mark.asyncio
async def test_write_creates_parent_dirs(tools, workspace):
    result = await call(
        tools, "write", {"path": "/nested/deep/file.txt", "content": "hi"}
    )
    assert not result.is_error
    data = await workspace.vfs.read("/nested/deep/file.txt")
    assert data == b"hi"


@pytest.mark.asyncio
async def test_ls(tools, workspace):
    await call(tools, "write", {"path": "/dir/a.txt", "content": "a"})
    await call(tools, "write", {"path": "/dir/b.txt", "content": "b"})
    result = await call(tools, "ls", {"path": "/dir"})
    text = result.content[0].text
    assert "a.txt" in text
    assert "b.txt" in text


@pytest.mark.asyncio
async def test_grep(tools, workspace):
    await workspace.vfs.write(
        "/search.txt", b"hello world\ngoodbye world\nhello again\n"
    )
    result = await call(tools, "grep", {"pattern": "hello", "path": "/"})
    text = result.content[0].text
    assert "hello" in text


@pytest.mark.asyncio
async def test_tools_act_as_the_session():
    ws = Workspace(
        {"/": RAMVFS(), "/vault": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={"guarded": {"paths": {"hide": ["/vault"]}}},
    )
    await ws.shell("echo key > /vault/key.txt")
    ws.create_session("agent", profile="guarded")
    try:
        result = await call(
            MirageServer(ws, session_id="agent"),
            "read",
            {"path": "/vault/key.txt"},
        )
    finally:
        await ws.close()
    assert result.is_error
    assert result.content[0].text == ("Error: file '/vault/key.txt' not found")
