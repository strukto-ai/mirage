import pytest

pytest.importorskip("claude_agent_sdk")

from mirage import MountMode, RAMResource, Workspace  # noqa: E402
from mirage.agents.claude_agent_sdk.server import _MirageTools  # noqa: E402


@pytest.fixture
def workspace():
    return Workspace({"/": RAMResource()}, mode=MountMode.WRITE)


@pytest.fixture
def tools(workspace):
    return _MirageTools(workspace)


@pytest.mark.asyncio
async def test_execute_command_echo(tools):
    result = await tools.execute_command({"command": "echo hello"})
    assert "hello" in result["content"][0]["text"]
    assert result.get("is_error") is not True


@pytest.mark.asyncio
async def test_execute_command_pipe(tools, workspace):
    await workspace.fs.write("/pipe.txt", b"aaa\nbbb\naaa\n")
    result = await tools.execute_command(
        {"command": "cat /pipe.txt | sort | uniq | wc -l"})
    assert "2" in result["content"][0]["text"]


@pytest.mark.asyncio
async def test_read_file(tools, workspace):
    await workspace.fs.write("/hello.txt", b"line1\nline2\nline3\n")
    result = await tools.read({"path": "/hello.txt"})
    text = result["content"][0]["text"]
    assert "line1" in text
    assert "line2" in text
    assert result.get("is_error") is not True


@pytest.mark.asyncio
async def test_read_file_with_offset_and_limit(tools, workspace):
    await workspace.fs.write("/multi.txt", b"a\nb\nc\nd\ne\n")
    result = await tools.read({"path": "/multi.txt", "offset": 1, "limit": 2})
    text = result["content"][0]["text"]
    assert "b" in text
    assert "c" in text
    assert "a" not in text
    assert "d" not in text


@pytest.mark.asyncio
async def test_read_file_not_found(tools):
    result = await tools.read({"path": "/nonexistent.txt"})
    assert result["is_error"] is True
    assert "not found" in result["content"][0]["text"]


@pytest.mark.asyncio
async def test_write_file(tools, workspace):
    result = await tools.write({"path": "/new.txt", "content": "hello world"})
    assert result.get("is_error") is not True
    data = await workspace.fs.read("/new.txt")
    assert data == b"hello world"


@pytest.mark.asyncio
async def test_write_file_already_exists(tools, workspace):
    await workspace.fs.write("/exists.txt", b"first")
    result = await tools.write({"path": "/exists.txt", "content": "second"})
    assert result["is_error"] is True
    assert "already exists" in result["content"][0]["text"]


@pytest.mark.asyncio
async def test_edit_file(tools, workspace):
    await workspace.fs.write("/edit.txt", b"foo bar baz")
    result = await tools.edit({
        "path": "/edit.txt",
        "old_string": "bar",
        "new_string": "qux"
    })
    assert result.get("is_error") is not True
    data = await workspace.fs.read("/edit.txt")
    assert data == b"foo qux baz"


@pytest.mark.asyncio
async def test_edit_file_not_found(tools):
    result = await tools.edit({
        "path": "/missing.txt",
        "old_string": "x",
        "new_string": "y"
    })
    assert result["is_error"] is True
    assert "not found" in result["content"][0]["text"]


@pytest.mark.asyncio
async def test_edit_string_not_found(tools, workspace):
    await workspace.fs.write("/nostr.txt", b"hello world")
    result = await tools.edit({
        "path": "/nostr.txt",
        "old_string": "xyz",
        "new_string": "abc"
    })
    assert result["is_error"] is True
    assert "not found" in result["content"][0]["text"]


@pytest.mark.asyncio
async def test_edit_multiple_occurrences_without_replace_all(tools, workspace):
    await workspace.fs.write("/multi.txt", b"aa bb aa")
    result = await tools.edit({
        "path": "/multi.txt",
        "old_string": "aa",
        "new_string": "cc"
    })
    assert result["is_error"] is True
    assert "replace_all" in result["content"][0]["text"]


@pytest.mark.asyncio
async def test_edit_replace_all(tools, workspace):
    await workspace.fs.write("/all.txt", b"aa bb aa")
    result = await tools.edit({
        "path": "/all.txt",
        "old_string": "aa",
        "new_string": "cc",
        "replace_all": True
    })
    assert result.get("is_error") is not True
    data = await workspace.fs.read("/all.txt")
    assert data == b"cc bb cc"


@pytest.mark.asyncio
async def test_write_creates_parent_dirs(tools, workspace):
    result = await tools.write({
        "path": "/nested/deep/file.txt",
        "content": "hi"
    })
    assert result.get("is_error") is not True
    data = await workspace.fs.read("/nested/deep/file.txt")
    assert data == b"hi"


@pytest.mark.asyncio
async def test_ls(tools, workspace):
    await tools.write({"path": "/dir/a.txt", "content": "a"})
    await tools.write({"path": "/dir/b.txt", "content": "b"})
    result = await tools.ls({"path": "/dir"})
    text = result["content"][0]["text"]
    assert "a.txt" in text
    assert "b.txt" in text


@pytest.mark.asyncio
async def test_grep(tools, workspace):
    await workspace.fs.write("/search.txt",
                             b"hello world\ngoodbye world\nhello again\n")
    result = await tools.grep({"pattern": "hello", "path": "/"})
    text = result["content"][0]["text"]
    assert "hello" in text
