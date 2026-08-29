import pytest

from mirage import MountMode, RAMResource, Workspace
from mirage.agents.file_version import (FileVersionTracker, MarkerMatch,
                                        StaleMirageFileError, Stamp,
                                        compare_markers, fingerprint)
from mirage.agents.tool_operations import MirageToolOperations
from mirage.ops.types import LiveFileIdentity


@pytest.fixture
def workspace():
    return Workspace({"/": RAMResource()}, mode=MountMode.WRITE)


class _RenderingOps:
    """A read seam that answers with something other than the stored bytes.

    Any mount carrying a filetype read op behaves this way: `write`
    stores one thing and `read` hands back the rendering. The tracker
    reaches the workspace only through these calls, so this is the whole
    of the condition. It names no version of its own, so every check
    falls to the hash rung, which is what a RAM, disk or redis mount
    does too.
    """

    def __init__(self, ops):
        self._ops = ops

    async def read(self, path):
        return b"rendered:" + await self._ops.read(path)

    async def read_with_identity(self, path, raw=False):
        return await self.read(path), None

    async def live_identity(self, path):
        return None

    async def write(self, path, data):
        await self._ops.write(path, data)

    async def exists(self, path):
        return await self._ops.exists(path)


class _RenderingWorkspace:

    def __init__(self, ws):
        self.ops = _RenderingOps(ws.ops)
        self.namespace = ws.namespace


class _VersionedOps:
    """A backend that names its own versions, the way s3 and gridfs do.

    Every write bumps the marker, `read_with_identity` hands the marker
    back with the bytes it just read, and `live_identity` answers from
    the same table without touching content. `reads` counts full
    content reads, which is the cost the native path must not pay.

    Args:
        ops: The real ops facade to store through.
        with_revision (bool): Report a revision marker.
        with_fingerprint (bool): Report a fingerprint marker.
    """

    def __init__(self, ops, with_revision=True, with_fingerprint=True):
        self._ops = ops
        self._marks: dict[str, int] = {}
        self.with_revision = with_revision
        self.with_fingerprint = with_fingerprint
        self.reads = 0
        self.identity_calls = 0

    async def _identity(self, path):
        if not await self._ops.exists(path):
            return LiveFileIdentity(exists=False,
                                    revision=None,
                                    fingerprint=None)
        mark = self._marks.get(path, 0)
        return LiveFileIdentity(
            exists=True,
            revision=f"r{mark}" if self.with_revision else None,
            fingerprint=f"f{mark}" if self.with_fingerprint else None)

    async def read(self, path):
        self.reads += 1
        return await self._ops.read(path)

    async def read_with_identity(self, path, raw=False):
        # The markers ride the read's own response, the way s3 and
        # gridfs lift an ETag and a VersionId off the GET that carried
        # the bytes.
        return await self.read(path), await self._identity(path)

    async def live_identity(self, path):
        self.identity_calls += 1
        return await self._identity(path)

    async def write(self, path, data):
        await self._ops.write(path, data)
        self._marks[path] = self._marks.get(path, 0) + 1

    async def exists(self, path):
        return await self._ops.exists(path)


class _VersionedWorkspace:

    def __init__(self, ws, with_revision=True, with_fingerprint=True):
        self.ops = _VersionedOps(ws.ops,
                                 with_revision=with_revision,
                                 with_fingerprint=with_fingerprint)
        self.namespace = ws.namespace


def test_fingerprint_is_stable_and_url_safe():
    stamp = fingerprint(b"hello")
    assert stamp == fingerprint(b"hello")
    assert stamp != fingerprint(b"hello!")
    assert "+" not in stamp and "/" not in stamp and "=" not in stamp


@pytest.mark.asyncio
async def test_write_after_read_of_unchanged_file(workspace):
    tracker = FileVersionTracker(workspace)
    await workspace.ops.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await tracker.write("/a.txt", "two")
    assert await workspace.ops.read("/a.txt") == b"two"


@pytest.mark.asyncio
async def test_write_refuses_after_outside_change(workspace):
    tracker = FileVersionTracker(workspace)
    await workspace.ops.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await workspace.ops.write("/a.txt", b"moved underneath")
    with pytest.raises(StaleMirageFileError):
        await tracker.write("/a.txt", "two")
    assert await workspace.ops.read("/a.txt") == b"moved underneath"


@pytest.mark.asyncio
async def test_edit_refuses_after_outside_change(workspace):
    tracker = FileVersionTracker(workspace)
    await workspace.ops.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await workspace.ops.write("/a.txt", b"moved underneath")
    with pytest.raises(StaleMirageFileError):
        await tracker.read_for_edit("/a.txt")


@pytest.mark.asyncio
async def test_write_after_own_write_is_allowed(workspace):
    tracker = FileVersionTracker(workspace)
    await workspace.ops.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await tracker.write("/a.txt", "two")
    await tracker.write("/a.txt", "three")
    assert await workspace.ops.read("/a.txt") == b"three"


@pytest.mark.asyncio
async def test_write_stamps_what_a_later_read_returns(workspace):
    # Stamping the bytes handed in would disagree with every later
    # check, which reads them back through the render, and the agent's
    # own next write would be refused as somebody else's change.
    tracker = FileVersionTracker(_RenderingWorkspace(workspace))
    await tracker.write("/a.txt", "one")
    await tracker.write("/a.txt", "two")
    assert await workspace.ops.read("/a.txt") == b"two"


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
    await workspace.ops.write("/a.txt", b"one")
    assert (await workspace.execute("ln -s /a.txt /alias.txt")).exit_code == 0
    await tracker.read("/alias.txt")
    await workspace.ops.write("/a.txt", b"moved underneath")
    with pytest.raises(StaleMirageFileError):
        await tracker.write("/a.txt", "two")
    assert await workspace.ops.read("/a.txt") == b"moved underneath"


@pytest.mark.asyncio
async def test_edit_through_an_alias_sees_the_read_of_the_target(workspace):
    tracker = FileVersionTracker(workspace)
    await workspace.ops.write("/a.txt", b"one")
    assert (await workspace.execute("ln -s /a.txt /alias.txt")).exit_code == 0
    await tracker.read("/a.txt")
    await workspace.ops.write("/a.txt", b"moved underneath")
    with pytest.raises(StaleMirageFileError):
        await tracker.read_for_edit("/alias.txt")


@pytest.mark.asyncio
async def test_disabled_tracker_allows_clobber(workspace):
    tracker = FileVersionTracker(workspace, enabled=False)
    await workspace.ops.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await workspace.ops.write("/a.txt", b"moved underneath")
    await tracker.write("/a.txt", "two")
    assert await workspace.ops.read("/a.txt") == b"two"


@pytest.mark.asyncio
async def test_edit_tool_reports_a_stale_file(workspace):
    ops = MirageToolOperations(workspace)
    await workspace.ops.write("/a.txt", b"hello world")
    await ops.read("/a.txt")
    await workspace.ops.write("/a.txt", b"hello there")
    result = await ops.edit("/a.txt", "hello", "goodbye")
    assert result.is_error is True
    assert "changed since it was last read" in result.text
    assert await workspace.ops.read("/a.txt") == b"hello there"


@pytest.mark.asyncio
async def test_edit_tool_without_protection_overwrites(workspace):
    ops = MirageToolOperations(workspace, stale_write_protection=False)
    await workspace.ops.write("/a.txt", b"hello world")
    await ops.read("/a.txt")
    await workspace.ops.write("/a.txt", b"hello there")
    result = await ops.edit("/a.txt", "hello", "goodbye")
    assert result.is_error is False
    assert await workspace.ops.read("/a.txt") == b"goodbye there"


def test_compare_markers_takes_the_strongest_shared_rung():
    both = LiveFileIdentity(exists=True, revision="r1", fingerprint="f1")
    # A revision outranks a fingerprint: the two disagree here and the
    # revision is what the verdict follows.
    moved_revision = LiveFileIdentity(exists=True,
                                      revision="r2",
                                      fingerprint="f1")
    assert compare_markers(both, both) is MarkerMatch.SAME
    assert compare_markers(both, moved_revision) is MarkerMatch.CHANGED
    only_fp = LiveFileIdentity(exists=True, revision=None, fingerprint="f1")
    assert compare_markers(both, only_fp) is MarkerMatch.SAME
    bare = LiveFileIdentity(exists=True, revision=None, fingerprint=None)
    assert compare_markers(both, bare) is MarkerMatch.UNCOMPARABLE
    assert compare_markers(None, both) is MarkerMatch.UNCOMPARABLE
    gone = LiveFileIdentity(exists=False, revision=None, fingerprint=None)
    assert compare_markers(both, gone) is MarkerMatch.CHANGED
    assert compare_markers(None, gone) is MarkerMatch.CHANGED


@pytest.mark.asyncio
async def test_native_markers_refuse_a_stale_write_without_a_re_read(
        workspace):
    versioned = _VersionedWorkspace(workspace)
    tracker = FileVersionTracker(versioned)
    await versioned.ops.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    reads = versioned.ops.reads
    await versioned.ops.write("/a.txt", b"moved underneath")
    with pytest.raises(StaleMirageFileError):
        await tracker.write("/a.txt", "two")
    # The refusal came from one metadata call, not from a download.
    assert versioned.ops.reads == reads
    assert await workspace.ops.read("/a.txt") == b"moved underneath"


@pytest.mark.asyncio
async def test_native_markers_allow_a_second_write_without_a_re_read(
        workspace):
    # The restamp after a write is a marker, so the file the agent just
    # wrote is never downloaded to prove it is still its own.
    versioned = _VersionedWorkspace(workspace)
    tracker = FileVersionTracker(versioned)
    await versioned.ops.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    reads = versioned.ops.reads
    await tracker.write("/a.txt", "two")
    await tracker.write("/a.txt", "three")
    assert versioned.ops.reads == reads
    assert await workspace.ops.read("/a.txt") == b"three"


@pytest.mark.asyncio
async def test_a_write_landing_before_the_check_is_refused(workspace):
    # The blocker this redesign exists for. The stamp is the identity of
    # the bytes the read itself returned, so a writer that lands after
    # that read and before the check moves the live marker away from it
    # and the write is refused. A stamp taken from a second identity
    # call after the read could have been this writer's version, and the
    # genuinely stale write would have gone through.
    versioned = _VersionedWorkspace(workspace)
    tracker = FileVersionTracker(versioned)
    await versioned.ops.write("/a.txt", b"A")
    await tracker.read("/a.txt")
    reads = versioned.ops.reads
    await versioned.ops.write("/a.txt", b"B")
    assert (await versioned.ops.live_identity("/a.txt")).revision == "r2"
    with pytest.raises(StaleMirageFileError):
        await tracker.write("/a.txt", "C")
    assert versioned.ops.reads == reads
    assert await workspace.ops.read("/a.txt") == b"B"


@pytest.mark.asyncio
async def test_a_vanished_file_is_stale(workspace):
    versioned = _VersionedWorkspace(workspace)
    tracker = FileVersionTracker(versioned)
    await versioned.ops.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    reads = versioned.ops.reads
    assert (await workspace.execute("rm /a.txt")).exit_code == 0
    with pytest.raises(StaleMirageFileError):
        await tracker.write("/a.txt", "two")
    assert versioned.ops.reads == reads


@pytest.mark.asyncio
async def test_a_marker_less_mount_uses_the_hash_path(workspace):
    # A RAM mount registers no identity op, so the facade answers None
    # end to end and every check is the full re-read it always was.
    assert await workspace.ops.live_identity("/a.txt") is None
    tracker = FileVersionTracker(workspace)
    await workspace.ops.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await tracker.write("/a.txt", "two")
    await workspace.ops.write("/a.txt", b"moved underneath")
    with pytest.raises(StaleMirageFileError):
        await tracker.write("/a.txt", "three")


@pytest.mark.asyncio
async def test_the_fingerprint_rung_decides_when_only_it_is_shared(workspace):
    versioned = _VersionedWorkspace(workspace)
    tracker = FileVersionTracker(versioned)
    await versioned.ops.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    reads = versioned.ops.reads
    # The stamp carries both markers; the backend now names only the
    # weaker one, so the check drops to it rather than to a download.
    versioned.ops.with_revision = False
    await tracker.write("/a.txt", "two")
    assert versioned.ops.reads == reads
    await tracker.read("/a.txt")
    reads = versioned.ops.reads
    await versioned.ops.write("/a.txt", b"moved underneath")
    with pytest.raises(StaleMirageFileError):
        await tracker.write("/a.txt", "three")
    assert versioned.ops.reads == reads


@pytest.mark.asyncio
async def test_the_hash_rung_decides_when_the_stamp_has_no_marker(workspace):
    versioned = _VersionedWorkspace(workspace,
                                    with_revision=False,
                                    with_fingerprint=False)
    tracker = FileVersionTracker(versioned)
    await versioned.ops.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    reads = versioned.ops.reads
    # Markers appear only after the stamp was taken, so there is no
    # shared rung and the check falls back to reading the bytes.
    versioned.ops.with_revision = True
    versioned.ops.with_fingerprint = True
    await tracker.write("/a.txt", "two")
    assert versioned.ops.reads == reads + 1


@pytest.mark.asyncio
async def test_a_marker_only_stamp_refuses_once_the_markers_go_away(workspace):
    # The one cost of the hash-free write restamp, pinned in the safe
    # direction: a backend that stops naming versions between a write
    # and the next check leaves the stamp with nothing to compare, and
    # the tracker refuses rather than guessing the file is untouched.
    versioned = _VersionedWorkspace(workspace)
    tracker = FileVersionTracker(versioned)
    await tracker.write("/a.txt", "one")
    versioned.ops.with_revision = False
    versioned.ops.with_fingerprint = False
    with pytest.raises(StaleMirageFileError):
        await tracker.write("/a.txt", "two")


@pytest.mark.asyncio
async def test_read_for_edit_compares_without_a_second_identity_call(
        workspace):
    # The read it just did carries the current identity, so the ladder
    # runs on what is already in hand.
    versioned = _VersionedWorkspace(workspace)
    tracker = FileVersionTracker(versioned)
    await versioned.ops.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    calls = versioned.ops.identity_calls
    assert await tracker.read_for_edit("/a.txt") == b"one"
    assert versioned.ops.identity_calls == calls
    await versioned.ops.write("/a.txt", b"moved underneath")
    with pytest.raises(StaleMirageFileError):
        await tracker.read_for_edit("/a.txt")


def test_stamp_keeps_both_the_identity_and_the_hash():
    identity = LiveFileIdentity(exists=True, revision="r1", fingerprint="f1")
    stamp = Stamp(identity=identity, content_hash=fingerprint(b"one"))
    assert stamp.identity is identity
    assert stamp.content_hash == fingerprint(b"one")
