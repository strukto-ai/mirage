import pytest

from mirage import MountMode, RAMResource, Workspace
from mirage.agents.tool_operations import MirageToolOperations, number_lines


@pytest.fixture
def workspace():
    return Workspace({"/": RAMResource()}, mode=MountMode.WRITE)


@pytest.fixture
def ops(workspace):
    return MirageToolOperations(workspace)


@pytest.mark.asyncio
async def test_execute_command_echo(ops):
    result = await ops.execute("echo hello")
    assert "hello" in result.text
    assert result.is_error is False


@pytest.mark.asyncio
async def test_execute_command_pipe(ops, workspace):
    await workspace.fs.write("/pipe.txt", b"aaa\nbbb\naaa\n")
    result = await ops.execute("cat /pipe.txt | sort | uniq | wc -l")
    assert "2" in result.text


@pytest.mark.asyncio
async def test_execute_reports_failure(ops):
    result = await ops.execute("ls /nowhere")
    assert result.is_error is True


@pytest.mark.asyncio
async def test_read_numbers_lines(ops, workspace):
    await workspace.fs.write("/hello.txt", b"line1\nline2\n")
    result = await ops.read("/hello.txt")
    assert result.text == "     1\tline1\n     2\tline2\n"
    assert result.is_error is False


@pytest.mark.asyncio
async def test_read_offset_and_limit(ops, workspace):
    await workspace.fs.write("/multi.txt", b"a\nb\nc\nd\ne\n")
    result = await ops.read("/multi.txt", offset=1, limit=2)
    assert result.text == "     2\tb\n     3\tc\n"


@pytest.mark.asyncio
async def test_read_missing(ops):
    result = await ops.read("/nonexistent.txt")
    assert result.is_error is True
    assert "not found" in result.text


@pytest.mark.asyncio
async def test_write_then_read_back(ops, workspace):
    result = await ops.write("/new.txt", "hello world")
    assert result.is_error is False
    assert await workspace.fs.read("/new.txt") == b"hello world"


@pytest.mark.asyncio
async def test_write_refuses_existing(ops, workspace):
    await workspace.fs.write("/exists.txt", b"first")
    result = await ops.write("/exists.txt", "second")
    assert result.is_error is True
    assert "already exists" in result.text
    assert await workspace.fs.read("/exists.txt") == b"first"


@pytest.mark.asyncio
async def test_write_creates_parents(ops, workspace):
    result = await ops.write("/nested/deep/file.txt", "hi")
    assert result.is_error is False
    assert await workspace.fs.read("/nested/deep/file.txt") == b"hi"


@pytest.mark.asyncio
async def test_edit_replaces_once(ops, workspace):
    await workspace.fs.write("/edit.txt", b"foo bar baz")
    result = await ops.edit("/edit.txt", "bar", "qux")
    assert result.is_error is False
    assert await workspace.fs.read("/edit.txt") == b"foo qux baz"


@pytest.mark.asyncio
async def test_edit_missing_file(ops):
    result = await ops.edit("/missing.txt", "x", "y")
    assert result.is_error is True
    assert "not found" in result.text


@pytest.mark.asyncio
async def test_edit_string_not_found(ops, workspace):
    await workspace.fs.write("/nostr.txt", b"hello world")
    result = await ops.edit("/nostr.txt", "xyz", "abc")
    assert result.is_error is True
    assert "string not found in file" in result.text


@pytest.mark.asyncio
async def test_edit_refuses_ambiguous(ops, workspace):
    await workspace.fs.write("/multi.txt", b"aa bb aa")
    result = await ops.edit("/multi.txt", "aa", "cc")
    assert result.is_error is True
    assert "replace_all" in result.text
    assert await workspace.fs.read("/multi.txt") == b"aa bb aa"


@pytest.mark.asyncio
async def test_edit_replace_all(ops, workspace):
    await workspace.fs.write("/all.txt", b"aa bb aa")
    result = await ops.edit("/all.txt", "aa", "cc", replace_all=True)
    assert result.is_error is False
    assert "2 occurrence(s)" in result.text
    assert await workspace.fs.read("/all.txt") == b"cc bb cc"


@pytest.mark.asyncio
async def test_ls(ops):
    await ops.write("/dir/a.txt", "a")
    await ops.write("/dir/b.txt", "b")
    result = await ops.ls("/dir")
    assert "a.txt" in result.text
    assert "b.txt" in result.text


@pytest.mark.asyncio
async def test_grep(ops, workspace):
    await workspace.fs.write("/search.txt",
                             b"hello world\ngoodbye world\nhello again\n")
    result = await ops.grep("hello", "/")
    assert "hello" in result.text
    assert result.is_error is False


@pytest.mark.asyncio
async def test_grep_reports_no_match_as_success(ops, workspace):
    # grep exits 1 when nothing matched. That is the empty answer, not a
    # broken search, so the agent must not be told the call failed.
    await workspace.fs.write("/search.txt", b"hello world\n")
    result = await ops.grep("nothing-matches-this", "/")
    assert result.is_error is False


@pytest.mark.asyncio
async def test_grep_reports_a_real_failure_as_an_error(ops):
    # An unreadable path exits 2. Reported as a success, the diagnostic
    # would read to the agent like a search that found nothing.
    result = await ops.grep("hello", "/nope.txt")
    assert result.is_error is True


@pytest.mark.asyncio
async def test_ls_quotes_awkward_paths(ops):
    await ops.write("/od d/a.txt", "a")
    result = await ops.ls("/od d")
    assert "a.txt" in result.text


def test_number_lines_splits_on_newline_only():
    # str.splitlines would break on the form feed and renumber, which
    # is how this drifted from the TypeScript tool.
    assert number_lines("a\x0cb\n", 0, 10) == "     1\ta\x0cb\n"


def test_number_lines_keeps_unterminated_last_line():
    assert number_lines("a\nb", 0, 10) == "     1\ta\n     2\tb"


def test_number_lines_empty():
    assert number_lines("", 0, 10) == ""
