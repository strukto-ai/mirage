import pytest

from mirage import MountMode, RAMResource, Workspace
from mirage.agents.file_version import (FileVersionTracker,
                                        StaleMirageFileError, fingerprint)
from mirage.agents.tool_operations import MirageToolOperations


@pytest.fixture
def workspace():
    return Workspace({"/": RAMResource()}, mode=MountMode.WRITE)


class _RenderingOps:
    """A read seam that answers with something other than the stored bytes.

    Any mount carrying a filetype read op behaves this way: `write`
    stores one thing and `read` hands back the rendering. The tracker
    reaches the workspace only through these three calls, so this is the
    whole of the condition.
    """

    def __init__(self, ops):
        self._ops = ops

    async def read(self, path):
        return b"rendered:" + await self._ops.read(path)

    async def write(self, path, data):
        await self._ops.write(path, data)

    async def exists(self, path):
        return await self._ops.exists(path)


class _RenderingWorkspace:

    def __init__(self, ws):
        self.fs = _RenderingOps(ws.fs)
        self.namespace = ws.namespace


def test_fingerprint_is_stable_and_url_safe():
    stamp = fingerprint(b"hello")
    assert stamp == fingerprint(b"hello")
    assert stamp != fingerprint(b"hello!")
    assert "+" not in stamp and "/" not in stamp and "=" not in stamp


@pytest.mark.asyncio
async def test_write_after_read_of_unchanged_file(workspace):
    tracker = FileVersionTracker(workspace)
    await workspace.fs.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await tracker.write("/a.txt", "two")
    assert await workspace.fs.read("/a.txt") == b"two"


@pytest.mark.asyncio
async def test_write_refuses_after_outside_change(workspace):
    tracker = FileVersionTracker(workspace)
    await workspace.fs.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await workspace.fs.write("/a.txt", b"moved underneath")
    with pytest.raises(StaleMirageFileError):
        await tracker.write("/a.txt", "two")
    assert await workspace.fs.read("/a.txt") == b"moved underneath"


@pytest.mark.asyncio
async def test_edit_refuses_after_outside_change(workspace):
    tracker = FileVersionTracker(workspace)
    await workspace.fs.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await workspace.fs.write("/a.txt", b"moved underneath")
    with pytest.raises(StaleMirageFileError):
        await tracker.read_for_edit("/a.txt")


@pytest.mark.asyncio
async def test_write_after_own_write_is_allowed(workspace):
    tracker = FileVersionTracker(workspace)
    await workspace.fs.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await tracker.write("/a.txt", "two")
    await tracker.write("/a.txt", "three")
    assert await workspace.fs.read("/a.txt") == b"three"


@pytest.mark.asyncio
async def test_write_stamps_what_a_later_read_returns(workspace):
    # Stamping the bytes handed in would disagree with every later
    # check, which reads them back through the render, and the agent's
    # own next write would be refused as somebody else's change.
    tracker = FileVersionTracker(_RenderingWorkspace(workspace))
    await tracker.write("/a.txt", "one")
    await tracker.write("/a.txt", "two")
    assert await workspace.fs.read("/a.txt") == b"two"


@pytest.mark.asyncio
async def test_edit_after_own_write_survives_a_rendering_mount(workspace):
    tracker = FileVersionTracker(_RenderingWorkspace(workspace))
    await tracker.write("/a.txt", "one")
    assert await tracker.read_for_edit("/a.txt") == b"rendered:one"


@pytest.mark.asyncio
async def test_alias_and_target_share_one_stamp(workspace):
    # ops.read follows the symlink table, so these two spellings are one
    # file. Keyed by spelling, the write below would find no stamp for
    # "/a.txt" and clobber a change the agent never saw.
    tracker = FileVersionTracker(workspace)
    await workspace.fs.write("/a.txt", b"one")
    assert (await workspace.execute("ln -s /a.txt /alias.txt")).exit_code == 0
    await tracker.read("/alias.txt")
    await workspace.fs.write("/a.txt", b"moved underneath")
    with pytest.raises(StaleMirageFileError):
        await tracker.write("/a.txt", "two")
    assert await workspace.fs.read("/a.txt") == b"moved underneath"


@pytest.mark.asyncio
async def test_edit_through_an_alias_sees_the_read_of_the_target(workspace):
    tracker = FileVersionTracker(workspace)
    await workspace.fs.write("/a.txt", b"one")
    assert (await workspace.execute("ln -s /a.txt /alias.txt")).exit_code == 0
    await tracker.read("/a.txt")
    await workspace.fs.write("/a.txt", b"moved underneath")
    with pytest.raises(StaleMirageFileError):
        await tracker.read_for_edit("/alias.txt")


@pytest.mark.asyncio
async def test_disabled_tracker_allows_clobber(workspace):
    tracker = FileVersionTracker(workspace, enabled=False)
    await workspace.fs.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await workspace.fs.write("/a.txt", b"moved underneath")
    await tracker.write("/a.txt", "two")
    assert await workspace.fs.read("/a.txt") == b"two"


@pytest.mark.asyncio
async def test_edit_tool_reports_a_stale_file(workspace):
    ops = MirageToolOperations(workspace)
    await workspace.fs.write("/a.txt", b"hello world")
    await ops.read("/a.txt")
    await workspace.fs.write("/a.txt", b"hello there")
    result = await ops.edit("/a.txt", "hello", "goodbye")
    assert result.is_error is True
    assert "changed since it was last read" in result.text
    assert await workspace.fs.read("/a.txt") == b"hello there"


@pytest.mark.asyncio
async def test_edit_tool_without_protection_overwrites(workspace):
    ops = MirageToolOperations(workspace, stale_write_protection=False)
    await workspace.fs.write("/a.txt", b"hello world")
    await ops.read("/a.txt")
    await workspace.fs.write("/a.txt", b"hello there")
    result = await ops.edit("/a.txt", "hello", "goodbye")
    assert result.is_error is False
    assert await workspace.fs.read("/a.txt") == b"goodbye there"
