import asyncio

import pytest

from mirage import RAMVFS, MountMode, Session, Workspace
from mirage.workspace.tools.file_version import (
    FileVersionTracker,
    StaleMirageFileError,
    fingerprint,
)
from mirage.workspace.tools.tool_operations import MirageToolOperations


@pytest.fixture
def workspace():
    return Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)


class _RenderingOps:
    """A read seam that answers with something other than the stored bytes.

    Any mount carrying a filetype read op behaves this way: `write`
    stores one thing and `read` hands back the rendering. The tracker
    reaches the workspace only through these three calls, so this is the
    whole of the condition.
    """

    def __init__(self, ops):
        self._ops = ops
        self.links = ops.links

    async def read(self, path):
        return b"rendered:" + await self._ops.read(path)

    async def write(self, path, data):
        await self._ops.write(path, data)

    async def exists(self, path):
        return await self._ops.exists(path)


class _HeldOps:
    """Holds the reads at the given call indices once they fetched their
    bytes, until the test releases them, so a write can land while a read
    is in flight.
    """

    def __init__(self, ops, hold_at):
        self._ops = ops
        self.links = ops.links
        self._reads = 0
        self.fetched = {n: asyncio.Event() for n in hold_at}
        self.release = {n: asyncio.Event() for n in hold_at}

    async def read(self, path):
        n = self._reads
        self._reads += 1
        data = await self._ops.read(path)
        if n in self.release:
            self.fetched[n].set()
            await self.release[n].wait()
        return data

    async def write(self, path, data):
        await self._ops.write(path, data)

    async def exists(self, path):
        return await self._ops.exists(path)


def test_fingerprint_is_stable_and_url_safe():
    stamp = fingerprint(b"hello")
    assert stamp == "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ"
    assert stamp == fingerprint(b"hello")
    assert stamp != fingerprint(b"hello!")
    assert "+" not in stamp and "/" not in stamp and "=" not in stamp


@pytest.mark.asyncio
async def test_read_in_flight_shows_and_stamps_a_write_that_lands(workspace):
    await workspace.vfs.write("/a.txt", b"one")
    held = _HeldOps(workspace.vfs, [0])
    tracker = FileVersionTracker(held)
    reading = asyncio.create_task(tracker.read("/a.txt"))
    await asyncio.wait_for(held.fetched[0].wait(), 5)
    await tracker.write("/a.txt", "two")
    held.release[0].set()
    assert await reading == b"two"
    await tracker.write("/a.txt", "three")
    assert await workspace.vfs.read("/a.txt") == b"three"


@pytest.mark.asyncio
async def test_writes_during_both_fetches_keep_the_shown_stamp(workspace):
    await workspace.vfs.write("/a.txt", b"one")
    held = _HeldOps(workspace.vfs, [0, 2])
    tracker = FileVersionTracker(held)
    reading = asyncio.create_task(tracker.read("/a.txt"))
    await asyncio.wait_for(held.fetched[0].wait(), 5)
    await tracker.write("/a.txt", "two")
    held.release[0].set()
    await asyncio.wait_for(held.fetched[2].wait(), 5)
    await tracker.write("/a.txt", "three")
    held.release[2].set()
    assert await reading == b"two"
    with pytest.raises(StaleMirageFileError):
        await tracker.write("/a.txt", "four")
    assert await workspace.vfs.read("/a.txt") == b"three"


@pytest.mark.asyncio
async def test_write_after_read_of_unchanged_file(workspace):
    tracker = FileVersionTracker(workspace.vfs)
    await workspace.vfs.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await tracker.write("/a.txt", "two")
    assert await workspace.vfs.read("/a.txt") == b"two"


@pytest.mark.asyncio
async def test_write_refuses_after_outside_change(workspace):
    tracker = FileVersionTracker(workspace.vfs)
    await workspace.vfs.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await workspace.vfs.write("/a.txt", b"moved underneath")
    with pytest.raises(StaleMirageFileError):
        await tracker.write("/a.txt", "two")
    assert await workspace.vfs.read("/a.txt") == b"moved underneath"


@pytest.mark.asyncio
async def test_edit_refuses_after_outside_change(workspace):
    tracker = FileVersionTracker(workspace.vfs)
    await workspace.vfs.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await workspace.vfs.write("/a.txt", b"moved underneath")
    with pytest.raises(StaleMirageFileError):
        await tracker.read_for_edit("/a.txt")


@pytest.mark.asyncio
async def test_write_after_own_write_is_allowed(workspace):
    tracker = FileVersionTracker(workspace.vfs)
    await workspace.vfs.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await tracker.write("/a.txt", "two")
    await tracker.write("/a.txt", "three")
    assert await workspace.vfs.read("/a.txt") == b"three"


@pytest.mark.asyncio
async def test_write_stamps_what_a_later_read_returns(workspace):
    # Stamping the bytes handed in would disagree with every later
    # check, which reads them back through the render, and the agent's
    # own next write would be refused as somebody else's change.
    tracker = FileVersionTracker(_RenderingOps(workspace.vfs))
    await tracker.write("/a.txt", "one")
    await tracker.write("/a.txt", "two")
    assert await workspace.vfs.read("/a.txt") == b"two"


@pytest.mark.asyncio
async def test_edit_after_own_write_survives_a_rendering_mount(workspace):
    tracker = FileVersionTracker(_RenderingOps(workspace.vfs))
    await tracker.write("/a.txt", "one")
    assert await tracker.read_for_edit("/a.txt") == b"rendered:one"


@pytest.mark.asyncio
async def test_alias_and_target_share_one_stamp(workspace):
    # ops.read follows the symlink table, so these two spellings are one
    # file. Keyed by spelling, the write below would find no stamp for
    # "/a.txt" and clobber a change the agent never saw.
    tracker = FileVersionTracker(workspace.vfs)
    await workspace.vfs.write("/a.txt", b"one")
    assert (await workspace.shell("ln -s /a.txt /alias.txt")).exit_code == 0
    await tracker.read("/alias.txt")
    await workspace.vfs.write("/a.txt", b"moved underneath")
    with pytest.raises(StaleMirageFileError):
        await tracker.write("/a.txt", "two")
    assert await workspace.vfs.read("/a.txt") == b"moved underneath"


@pytest.mark.asyncio
async def test_edit_through_an_alias_sees_the_read_of_the_target(workspace):
    tracker = FileVersionTracker(workspace.vfs)
    await workspace.vfs.write("/a.txt", b"one")
    assert (await workspace.shell("ln -s /a.txt /alias.txt")).exit_code == 0
    await tracker.read("/a.txt")
    await workspace.vfs.write("/a.txt", b"moved underneath")
    with pytest.raises(StaleMirageFileError):
        await tracker.read_for_edit("/alias.txt")


@pytest.mark.asyncio
async def test_disabled_tracker_allows_clobber(workspace):
    tracker = FileVersionTracker(workspace.vfs, enabled=False)
    await workspace.vfs.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await workspace.vfs.write("/a.txt", b"moved underneath")
    await tracker.write("/a.txt", "two")
    assert await workspace.vfs.read("/a.txt") == b"two"


@pytest.mark.asyncio
async def test_edit_tool_reports_a_stale_file(workspace):
    ops = workspace.tools
    await workspace.vfs.write("/a.txt", b"hello world")
    await ops.read("/a.txt")
    await workspace.vfs.write("/a.txt", b"hello there")
    result = await ops.edit("/a.txt", "hello", "goodbye")
    assert result.is_error is True
    assert "changed since it was last read" in result.text
    assert await workspace.vfs.read("/a.txt") == b"hello there"


@pytest.mark.asyncio
async def test_edit_tool_without_protection_overwrites(workspace):
    ops = MirageToolOperations(
        Session(workspace, workspace.default_session_id),
        stale_write_protection=False,
    )
    await workspace.vfs.write("/a.txt", b"hello world")
    await ops.read("/a.txt")
    await workspace.vfs.write("/a.txt", b"hello there")
    result = await ops.edit("/a.txt", "hello", "goodbye")
    assert result.is_error is False
    assert await workspace.vfs.read("/a.txt") == b"goodbye there"
