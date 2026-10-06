import errno

import pytest

from mirage import RAMVFS, Deny, MountMode, Policy, Session, Workspace
from mirage.context.session_context import (
    reset_current_session,
    set_current_session,
)
from mirage.ops.ops import Ops
from mirage.policy import Outcome, VfsContext
from mirage.workspace.store.ram import RAMWorkspaceStateStore
from mirage.workspace.tools.tool_operations import TOOL_NAMES, number_lines


@pytest.fixture
def workspace():
    return Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)


@pytest.fixture
def ops(workspace):
    return workspace.tools


@pytest.mark.asyncio
async def test_shell_echo(ops):
    result = await ops.shell("echo hello")
    assert "hello" in result.text
    assert result.is_error is False


@pytest.mark.asyncio
async def test_shell_pipe(ops, workspace):
    await workspace.vfs.write("/pipe.txt", b"aaa\nbbb\naaa\n")
    result = await ops.shell("cat /pipe.txt | sort | uniq | wc -l")
    assert "2" in result.text


@pytest.mark.asyncio
async def test_shell_reports_failure(ops):
    result = await ops.shell("ls /nowhere")
    assert result.is_error is True


@pytest.mark.asyncio
async def test_read_numbers_lines(ops, workspace):
    await workspace.vfs.write("/hello.txt", b"line1\nline2\n")
    result = await ops.read("/hello.txt")
    assert result.text == "     1\tline1\n     2\tline2\n"
    assert result.is_error is False


@pytest.mark.asyncio
async def test_read_offset_and_limit(ops, workspace):
    await workspace.vfs.write("/multi.txt", b"a\nb\nc\nd\ne\n")
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
    assert await workspace.vfs.read("/new.txt") == b"hello world"


@pytest.mark.asyncio
async def test_write_refuses_an_unread_file(ops, workspace):
    await workspace.vfs.write("/exists.txt", b"first")
    result = await ops.write("/exists.txt", "second")
    assert result.is_error is True
    assert "read all of it before overwriting it" in result.text
    assert await workspace.vfs.read("/exists.txt") == b"first"


@pytest.mark.asyncio
async def test_write_refuses_a_partly_read_file(ops, workspace):
    await workspace.vfs.write("/three.txt", b"1\n2\n3\n")
    await ops.read("/three.txt", 0, 1)
    result = await ops.write("/three.txt", "x")
    assert result.is_error is True
    assert "read all of it before overwriting it" in result.text
    assert await workspace.vfs.read("/three.txt") == b"1\n2\n3\n"


@pytest.mark.asyncio
async def test_write_overwrites_a_read_file(ops, workspace):
    await workspace.vfs.write("/exists.txt", b"first")
    await ops.read("/exists.txt")
    result = await ops.write("/exists.txt", "second")
    assert result.is_error is False
    assert await workspace.vfs.read("/exists.txt") == b"second"


@pytest.mark.asyncio
async def test_write_refuses_a_file_changed_since_read(ops, workspace):
    await workspace.vfs.write("/exists.txt", b"first")
    await ops.read("/exists.txt")
    await workspace.vfs.write("/exists.txt", b"moved")
    result = await ops.write("/exists.txt", "second")
    assert result.is_error is True
    assert "changed since it was last read" in result.text
    assert await workspace.vfs.read("/exists.txt") == b"moved"


@pytest.mark.asyncio
async def test_write_creates_parents(ops, workspace):
    result = await ops.write("/nested/deep/file.txt", "hi")
    assert result.is_error is False
    assert await workspace.vfs.read("/nested/deep/file.txt") == b"hi"


@pytest.mark.asyncio
async def test_edit_replaces_once(ops, workspace):
    await workspace.vfs.write("/edit.txt", b"foo bar baz")
    result = await ops.edit("/edit.txt", "bar", "qux")
    assert result.is_error is False
    assert await workspace.vfs.read("/edit.txt") == b"foo qux baz"


@pytest.mark.asyncio
async def test_edit_keeps_a_utf8_bom(ops, workspace):
    await workspace.vfs.write("/bom.txt", b"\xef\xbb\xbfhello world")
    result = await ops.edit("/bom.txt", "world", "there")
    assert result.is_error is False
    assert await workspace.vfs.read("/bom.txt") == b"\xef\xbb\xbfhello there"


@pytest.mark.asyncio
async def test_edit_missing_file(ops):
    result = await ops.edit("/missing.txt", "x", "y")
    assert result.is_error is True
    assert "not found" in result.text


@pytest.mark.asyncio
async def test_edit_string_not_found(ops, workspace):
    await workspace.vfs.write("/nostr.txt", b"hello world")
    result = await ops.edit("/nostr.txt", "xyz", "abc")
    assert result.is_error is True
    assert "string not found in file" in result.text


@pytest.mark.asyncio
async def test_edit_refuses_ambiguous(ops, workspace):
    await workspace.vfs.write("/multi.txt", b"aa bb aa")
    result = await ops.edit("/multi.txt", "aa", "cc")
    assert result.is_error is True
    assert "replace_all" in result.text
    assert await workspace.vfs.read("/multi.txt") == b"aa bb aa"


@pytest.mark.asyncio
async def test_edit_replace_all(ops, workspace):
    await workspace.vfs.write("/all.txt", b"aa bb aa")
    result = await ops.edit("/all.txt", "aa", "cc", replace_all=True)
    assert result.is_error is False
    assert "2 occurrence(s)" in result.text
    assert await workspace.vfs.read("/all.txt") == b"cc bb cc"


@pytest.mark.asyncio
async def test_ls(ops):
    await ops.write("/dir/a.txt", "a")
    await ops.write("/dir/b.txt", "b")
    result = await ops.ls("/dir")
    assert "a.txt" in result.text
    assert "b.txt" in result.text


@pytest.mark.asyncio
async def test_grep(ops, workspace):
    await workspace.vfs.write(
        "/search.txt", b"hello world\ngoodbye world\nhello again\n"
    )
    result = await ops.grep("hello", "/")
    assert "hello" in result.text
    assert result.is_error is False


@pytest.mark.asyncio
async def test_grep_reports_no_match_as_success(ops, workspace):
    # grep exits 1 when nothing matched. That is the empty answer, not a
    # broken search, so the agent must not be told the call failed.
    await workspace.vfs.write("/search.txt", b"hello world\n")
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


@pytest.mark.asyncio
async def test_glob_finds_files_by_name(ops):
    await ops.write("/src/a.py", "a")
    await ops.write("/src/deep/b.py", "b")
    await ops.write("/src/c.txt", "c")
    result = await ops.glob("**/*.py", "/src")
    assert result.text.split() == ["/src/a.py", "/src/deep/b.py"]
    assert result.is_error is False


@pytest.mark.asyncio
async def test_glob_matches_a_pattern_with_directories_in_it(ops):
    await ops.write("/src/deep/b.py", "b")
    result = await ops.glob("src/**/*.py")
    assert result.text.split() == ["/src/deep/b.py"]


@pytest.mark.asyncio
async def test_glob_follows_a_link_to_a_file(ops):
    await ops.write("/src/a.py", "a")
    await ops.shell("ln -s /src/a.py /src/link.py")
    await ops.shell("ln -s /src/none.py /src/dangling.py")
    result = await ops.glob("*.py", "/src")
    assert result.text.split() == ["/src/a.py", "/src/link.py"]


@pytest.mark.asyncio
async def test_glob_skips_directories(ops):
    await ops.write("/cache.py/inner.txt", "x")
    await ops.write("/src/a.py", "a")
    result = await ops.glob("**/*.py")
    assert result.text.split() == ["/src/a.py"]


@pytest.mark.asyncio
async def test_glob_matches_only_the_named_level(ops):
    await ops.write("/src/a.py", "a")
    await ops.write("/src/deep/b.py", "b")
    result = await ops.glob("*.py", "/src")
    assert result.text.split() == ["/src/a.py"]


@pytest.mark.asyncio
async def test_grep_takes_gnu_options(ops):
    await ops.write("/src/a.py", "Needle\nhay\n")
    await ops.write("/src/b.txt", "needle\n")
    loose = await ops.grep("needle", "/src", ignore_case=True, include="*.py")
    names = await ops.grep("needle", "/src", files_with_matches=True)
    counted = await ops.grep("e", "/src/a.py", count=True)
    literal = await ops.grep("-dash", "/src")
    assert loose.text == "/src/a.py:1:Needle\n"
    assert names.text == "/src/b.txt\n"
    assert counted.text == "1\n"
    assert literal.is_error is False


async def _guarded() -> Workspace:
    ws = Workspace(
        {"/": RAMVFS(), "/vault": RAMVFS(), "/ro": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={
            "guarded": {
                "paths": {"hide": ["/vault"]},
                "mounts": {"/ro": {"mode": "r"}},
            }
        },
    )
    await ws.shell("echo key > /vault/key.txt && echo r > /ro/r.txt")
    ws.create_session("agent", profile="guarded")
    return ws


@pytest.mark.asyncio
async def test_every_tool_acts_under_the_session_profile():
    ws = await _guarded()
    ops = Session(ws, "agent").tools
    try:
        read = await ops.call("read", {"path": "/vault/key.txt"})
        listed = await ops.call("ls", {"path": "/"})
        globbed = await ops.call("glob", {"pattern": "/*/*.txt"})
        found = await ops.call("grep", {"pattern": "key", "path": "/vault"})
        shown = await ops.call("read", {"path": "/ro/r.txt"})
        default = await ws.tools.call("read", {"path": "/vault/key.txt"})
    finally:
        await ws.close()
    assert read.text == "Error: file '/vault/key.txt' not found"
    assert "vault" not in listed.text
    assert globbed.text == "/ro/r.txt\n"
    assert found.is_error
    assert shown.text == "     1\tr\n"
    assert default.text == "     1\tkey\n"


@pytest.mark.asyncio
async def test_a_refused_write_or_edit_is_a_tool_error():
    ws = await _guarded()
    ops = Session(ws, "agent").tools
    try:
        await ops.call("read", {"path": "/ro/r.txt"})
        written = await ops.call(
            "write", {"path": "/ro/r.txt", "content": "x"}
        )
        edited = await ops.call(
            "edit", {"path": "/ro/r.txt", "old_string": "r", "new_string": "R"}
        )
        hidden = await ops.call(
            "write", {"path": "/vault/new/n.txt", "content": "x"}
        )
    finally:
        await ws.close()
    assert written.is_error and written.text.startswith("Error: ")
    assert edited.is_error and edited.text.startswith("Error: ")
    assert hidden.is_error and hidden.text.startswith("Error: ")


class LockedFile(Policy):
    """Refuse every op on one file, a stat included."""

    async def pre_vfs(self, ctx: VfsContext) -> Deny | None:
        if ctx.path.virtual == "/d/locked.txt":
            return Deny("locked")
        return None


@pytest.mark.asyncio
async def test_a_file_refused_down_to_its_stat_is_a_tool_error():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell(
        "mkdir /d && echo l > /d/locked.txt && echo o > /d/open.txt"
    )
    ws.policies.add(LockedFile())
    try:
        read = await ws.tools.call("read", {"path": "/d/locked.txt"})
        written = await ws.tools.call(
            "write", {"path": "/d/locked.txt", "content": "x"}
        )
        edited = await ws.tools.call(
            "edit",
            {"path": "/d/locked.txt", "old_string": "l", "new_string": "m"},
        )
        globbed = await ws.tools.call("glob", {"pattern": "/d/*.txt"})
        literal = await ws.tools.call("glob", {"pattern": "/d/locked.txt"})
    finally:
        await ws.close()
    assert read.is_error and "not found" not in read.text
    assert edited.is_error and "not found" not in edited.text
    assert written.is_error and written.text.startswith("Error: ")
    assert globbed.text == "/d/open.txt\n"
    assert literal.text == "" and not literal.is_error


@pytest.mark.asyncio
async def test_a_probe_that_fails_leaves_the_tool_error(monkeypatch):
    # A backend that cannot answer the existence probe proves nothing, so
    # the tool reports the failure as its result instead of raising it.
    real = Ops.exists

    async def flaky(self, path, *, session_id=None):
        if path == "/d/flaky.txt":
            raise OSError(errno.EIO, "Input/output error", path)
        return await real(self, path, session_id=session_id)

    monkeypatch.setattr(Ops, "exists", flaky)
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("mkdir /d")
    try:
        read = await ws.tools.call("read", {"path": "/d/flaky.txt"})
        written = await ws.tools.call(
            "write", {"path": "/d/flaky.txt", "content": "x"}
        )
    finally:
        await ws.close()
    # The read's own error stands, never the probe's.
    assert read.is_error and read.text == "Error: /d/flaky.txt"
    assert written.is_error and "Input/output error" in written.text


@pytest.mark.asyncio
async def test_a_bound_session_is_kept_rather_than_widened():
    ws = await _guarded()
    wide = ws.tools
    token = set_current_session(ws.get_session("agent"))
    try:
        read = await wide.call("read", {"path": "/vault/key.txt"})
    finally:
        reset_current_session(token)
        await ws.close()
    assert read.text == "Error: file '/vault/key.txt' not found"


@pytest.mark.asyncio
async def test_a_stored_session_serves_the_first_call():
    store = RAMWorkspaceStateStore()
    ram = RAMVFS()
    writer = Workspace(
        {"/": ram}, mode=MountMode.WRITE, workspace_id="shared", store=store
    )
    writer.create_session("agent")
    await writer.ensure_sessions_loaded()
    await writer.flush_sessions()
    attached = Workspace(
        {"/": ram}, mode=MountMode.WRITE, workspace_id="shared", store=store
    )
    try:
        written = await Session(attached, "agent").tools.call(
            "write", {"path": "/a.txt", "content": "x\n"}
        )
    finally:
        await writer.close()
        await attached.close()
    assert written.text == "Written: /a.txt"


@pytest.mark.parametrize(
    "profile,mode,names",
    [
        (None, MountMode.WRITE, TOOL_NAMES),
        (None, MountMode.READ, ("shell", "read", "ls", "grep", "glob")),
        (
            {"commands": {"allow": ["cat"]}},
            MountMode.WRITE,
            ("shell", "read", "write", "edit", "glob"),
        ),
        (
            {"commands": {"allow": []}},
            MountMode.WRITE,
            ("read", "write", "edit", "glob"),
        ),
        (
            {"commands": {"deny": [{"reason": "no", "commands": ["grep"]}]}},
            MountMode.WRITE,
            ("shell", "read", "write", "edit", "ls", "glob"),
        ),
        (
            {"mounts": {"/": "read"}},
            MountMode.WRITE,
            ("shell", "read", "ls", "grep", "glob"),
        ),
        (
            {"mounts": {"/": "read"}, "paths": {"show": {"/out": "rw"}}},
            MountMode.WRITE,
            TOOL_NAMES,
        ),
    ],
)
def test_the_tool_list_follows_the_profile(profile, mode, names):
    ws = Workspace({"/": RAMVFS()}, mode=mode)
    if profile is not None:
        ws.create_session("agent", profile=profile)
    session = Session(ws, "agent" if profile is not None else None)
    assert session.tools.names() == names


@pytest.mark.asyncio
async def test_a_tool_the_profile_does_not_offer_is_no_tool():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    ws.create_session("ro", profile={"mounts": {"/": "read"}})
    with pytest.raises(KeyError):
        await Session(ws, "ro").tools.call(
            "write", {"path": "/x", "content": "y"}
        )


@pytest.mark.asyncio
async def test_a_path_ask_waits_on_the_host_outside_a_line():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    ws.create_session(
        "agent",
        profile={
            "commands": {
                "ask": [
                    {"reason": "outbox needs a nod", "paths": ["/data/out/*"]}
                ]
            }
        },
    )
    tools = Session(ws, "agent").tools
    asked = await tools.write("/data/out/a.txt", "hi")
    assert asked.is_error
    [record] = ws.decisions.pending("agent")
    assert (record.command, record.paths) == ("", ("/data/out/a.txt",))
    assert asked.text == (
        "Error: [Errno 13] Permission denied: '/data/out/a.txt'\n"
        f"requires approval: outbox needs a nod (ask {record.id})\n"
    )
    # Asking again quotes the same question.
    await tools.write("/data/out/a.txt", "hi")
    assert [r.id for r in ws.decisions.pending("agent")] == [record.id]
    await ws.decisions.answer(record.id, Outcome.ALLOW)
    assert not (await tools.write("/data/out/a.txt", "hi")).is_error
    # The nod was for one op on that path, and it is spent.
    assert (await tools.write("/data/out/a.txt", "again")).is_error
    # A line holds no question for its ops: the redirect is the line's
    # to ask about, at the command door.
    io = await ws.shell("echo hi > /data/out/b.txt", session_id="agent")
    assert io.exit_code != 0
