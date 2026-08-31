# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import errno
import time

import pytest

from mirage import Workspace
from mirage.cache.index import IndexCacheStore
from mirage.cache.index.config import IndexEntry, LookupResult, LookupStatus
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.context import reset_current_session, set_current_session
from mirage.io import IOResult
from mirage.observe.context import RecordingScope, record
from mirage.ops import Ops
from mirage.ops.registry import RegisteredOp
from mirage.ops.types import LiveFileIdentity
from mirage.policy import (Action, Deny, OpsContext, OpsResultContext, Policy,
                           PolicyDenied)
from mirage.resource.ram import RAMResource
from mirage.types import FileType, HiddenPaths, Limit, MountMode
from mirage.utils.errors import CappedReadError
from mirage.workspace.session import Session

from .conftest import make_ops, run


class TestMountPrefixes:

    def test_mount_prefixes_returns_prefixes(self):
        ops, _ = make_ops()
        assert "/data/" in ops.mount_prefixes()

    def test_mount_prefixes_reflects_unmount(self):
        ops, _ = make_ops()
        ops.unmount("/data/")
        assert "/data/" not in ops.mount_prefixes()


class TestReadWrite:

    def test_write_and_read(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/file.txt", b"hello"))
        assert run(ops.read("/data/dir/file.txt")) == b"hello"

    def test_read_nonexistent(self):
        ops, _ = make_ops()
        with pytest.raises(FileNotFoundError):
            run(ops.read("/data/nope.txt"))

    def test_write_read_only(self):
        ops, _ = make_ops(mode=MountMode.READ)
        with pytest.raises(PermissionError):
            run(ops.write("/data/file.txt", b"data"))


class TestStat:

    def test_stat_file(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/f.txt", b"hello"))
        s = run(ops.stat("/data/dir/f.txt"))
        assert s.name == "f.txt"
        assert s.size == 5

    def test_stat_dir(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/mydir"))
        s = run(ops.stat("/data/mydir"))
        assert s.type == FileType.DIRECTORY

    def test_stat_nonexistent(self):
        ops, _ = make_ops()
        with pytest.raises(FileNotFoundError):
            run(ops.stat("/data/nope"))


class TestReaddir:

    def test_readdir(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/a.txt", b"a"))
        run(ops.write("/data/dir/b.txt", b"b"))
        entries = run(ops.readdir("/data/dir"))
        assert len(entries) == 2


class TestMkdirRmdir:

    def test_mkdir_and_rmdir(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/newdir"))
        s = run(ops.stat("/data/newdir"))
        assert s.type == FileType.DIRECTORY
        run(ops.rmdir("/data/newdir"))
        with pytest.raises(FileNotFoundError):
            run(ops.stat("/data/newdir"))

    def test_rmdir_nonempty(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/f.txt", b"data"))
        with pytest.raises(OSError):
            run(ops.rmdir("/data/dir"))


class TestUnlink:

    def test_unlink(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/f.txt", b"data"))
        run(ops.unlink("/data/dir/f.txt"))
        with pytest.raises(FileNotFoundError):
            run(ops.read("/data/dir/f.txt"))


def _two_mount_ops() -> Ops:
    return Workspace({
        "/a/": RAMResource(),
        "/b/": RAMResource()
    },
                     mode=MountMode.WRITE).ops


class TestRename:

    def test_rename(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/old.txt", b"content"))
        run(ops.rename("/data/dir/old.txt", "/data/dir/new.txt"))
        assert run(ops.read("/data/dir/new.txt")) == b"content"
        with pytest.raises(FileNotFoundError):
            run(ops.read("/data/dir/old.txt"))

    def test_rename_across_mounts_refuses_exdev(self):
        # A mount is a filesystem boundary; the facade refuses before
        # any backend is touched, so a kernel-facing caller (a
        # whole-workspace FUSE mount) falls back to copy+unlink instead
        # of writing one backend's path into another's key space.
        ops = _two_mount_ops()
        run(ops.write("/a/x.txt", b"body"))
        with pytest.raises(OSError) as exc:
            run(ops.rename("/a/x.txt", "/b/x.txt"))
        assert exc.value.errno == errno.EXDEV
        assert run(ops.read("/a/x.txt")) == b"body"

    def test_rename_to_an_unmounted_path_refuses_exdev(self):
        ops = _two_mount_ops()
        run(ops.write("/a/x.txt", b"body"))
        with pytest.raises(OSError) as exc:
            run(ops.rename("/a/x.txt", "/elsewhere/x.txt"))
        assert exc.value.errno == errno.EXDEV


class UngrantedRemote(RAMResource):
    caches_reads = True
    name = "s3"


@pytest.fixture
def deep_only_session():
    """Bind a session whose role hides the parent mount's own content."""
    session = Session(session_id="agent",
                      hidden_paths=HiddenPaths(patterns=("/m/*.txt", )))
    token = set_current_session(session)
    yield session
    reset_current_session(token)


@pytest.mark.asyncio
async def test_a_namespace_answer_is_not_a_backend_op(deep_only_session):
    # /m/inner is served by no backend: the answer exists only because
    # a mount sits below it. Attributing it to the lexical owner invents
    # a network op against that backend for every such lookup.
    ws = Workspace({
        "/m/": UngrantedRemote(),
        "/m/inner/deep/": RAMResource()
    },
                   mode=MountMode.WRITE)
    try:
        ws.ops.records.clear()
        assert await ws.ops.readdir("/m/inner") == ["/m/inner/deep"]
        assert [(r.source, r.is_cache)
                for r in ws.ops.records] == [("ram", True)]
        assert ws.ops.network_records == []
    finally:
        await ws.close()


class DenyInner(Policy):

    async def post_ops(self, ctx: OpsResultContext) -> Action | None:
        if ctx.path.virtual == "/m/inner":
            return Deny(message="no")
        return None


@pytest.mark.asyncio
async def test_a_denied_namespace_answer_is_not_a_backend_op(
        deep_only_session):
    # Refusing the synthetic answer does not make the parent backend
    # have served it: a deny suppresses a result nothing was contacted
    # to produce.
    ws = Workspace({
        "/m/": UngrantedRemote(),
        "/m/inner/deep/": RAMResource()
    },
                   mode=MountMode.WRITE)
    try:
        ws.policies.add(DenyInner())
        ws.ops.records.clear()
        with pytest.raises(PermissionError):
            await ws.ops.readdir("/m/inner")
        assert [(r.source, r.is_cache)
                for r in ws.ops.records] == [("ram", True)]
        assert ws.ops.network_records == []
    finally:
        await ws.close()


class TestCreateTruncate:

    def test_create(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.create("/data/dir/empty.txt"))
        assert run(ops.read("/data/dir/empty.txt")) == b""

    def test_truncate(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/f.txt", b"hello world"))
        run(ops.truncate("/data/dir/f.txt", 5))
        assert run(ops.read("/data/dir/f.txt")) == b"hello"


class TestSetattr:

    def test_setattr_lands_where_stat_reads_it(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/f.txt", b"hello"))
        run(ops.setattr("/data/dir/f.txt", mode=0o600, uid=4242))
        st = run(ops.stat("/data/dir/f.txt"))
        assert st.mode == 0o600
        assert st.uid == 4242

    def test_setattr_returns_what_the_backend_could_not_keep(self):
        # RAM holds attrs itself, so nothing is left for the overlay and
        # the residual is empty; a mount with no setattr op gets every
        # field back from the door instead.
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/f.txt", b"hello"))
        assert run(ops.setattr("/data/dir/f.txt", mode=0o640)) == {}
        assert run(ops.stat("/data/dir/f.txt")).mode == 0o640

    def test_setattr_on_a_link_entry_lands_in_the_overlay(self):
        # A link has no backend inode, so the door keeps its attrs
        # whatever the owning mount can do.
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/f.txt", b"hello"))
        run(ops.symlink("/link", "/data/dir/f.txt"))
        assert run(ops.setattr("/link", mode=0o640, nofollow=True)) == {
            "mode": 0o640
        }

    def test_setattr_writes_a_link_entry_under_nofollow(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/f.txt", b"hello"))
        run(ops.symlink("/data/dir/link", "f.txt"))
        run(ops.setattr("/data/dir/link", uid=7, nofollow=True))
        assert run(ops.stat("/data/dir/f.txt")).uid is None

    def test_setattr_follows_a_link_by_default(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/f.txt", b"hello"))
        run(ops.symlink("/data/dir/link", "f.txt"))
        run(ops.setattr("/data/dir/link", uid=9))
        assert run(ops.stat("/data/dir/f.txt")).uid == 9


class TestIsMounted:

    def test_mounted(self):
        ops, _ = make_ops()
        assert ops.is_mounted("/data/file.txt") is True

    def test_not_mounted(self):
        ops, _ = make_ops()
        assert ops.is_mounted("/other/file.txt") is False


class TestMultiMount:

    def test_two_mounts(self):
        one = RAMResource()
        two = RAMResource()
        store1 = one._store
        store2 = two._store
        ops = Workspace({
            "/mem1/": one,
            "/mem2/": two
        }, mode=MountMode.WRITE).ops
        run(ops.mkdir("/mem1/dir"))
        run(ops.mkdir("/mem2/dir"))
        run(ops.write("/mem1/dir/a.txt", b"from store1"))
        run(ops.write("/mem2/dir/b.txt", b"from store2"))
        assert run(ops.read("/mem1/dir/a.txt")) == b"from store1"
        assert run(ops.read("/mem2/dir/b.txt")) == b"from store2"
        assert store1.files.get("/dir/a.txt") == b"from store1"
        assert store2.files.get("/dir/b.txt") == b"from store2"


class TestOpsAgainstSeededStore:

    @pytest.fixture
    def memory_ops(self):
        resource = RAMResource()
        store = resource._store
        store.dirs.add("/")
        store.files["/test.txt"] = b"hello"
        store.modified["/test.txt"] = "2024-01-01T00:00:00"
        ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
        return ws.ops, store

    def test_read(self, memory_ops):
        ops, _ = memory_ops
        assert run(ops.read("/data/test.txt")) == b"hello"

    def test_write(self, memory_ops):
        ops, store = memory_ops
        run(ops.write("/data/test.txt", b"world"))
        assert store.files["/test.txt"] == b"world"

    def test_stat(self, memory_ops):
        ops, _ = memory_ops
        st = run(ops.stat("/data/test.txt"))
        assert st.name == "test.txt"


class _SealInner(Policy):

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        if ctx.path.virtual == "/data/inner":
            return Deny("sealed\n")
        return None


def _structure_only_ops(policies: list[Policy]) -> Ops:
    """Ops whose only mount sits below the probed path, so no mount
    serves /data/inner and the answer is namespace structure."""
    return Workspace({
        "/data/inner/deep/": RAMResource()
    },
                     mode=MountMode.WRITE,
                     policies=policies).ops


class TestStructureFallbackGates:

    def test_the_synthetic_answer_still_clears_admission(self):
        # Mirrors the dispatcher door: a policy that bounds readdir or
        # stat by path must cover a structure-only directory too.
        ops = _structure_only_ops([_SealInner()])
        with pytest.raises(PolicyDenied):
            run(ops.readdir("/data/inner"))
        with pytest.raises(PolicyDenied):
            run(ops.stat("/data/inner"))

    def test_the_synthetic_answer_serves_when_no_policy_objects(self):
        ops = _structure_only_ops([])
        assert run(ops.readdir("/data/inner")) == ["/data/inner/deep"]


def _granted_child_ops() -> Ops:
    """Ops with a real mount at /data and a nested one at
    /data/inner/deep, for sessions granted only the deep one."""
    return Workspace(
        {
            "/data/": RAMResource(),
            "/data/inner/deep/": RAMResource()
        },
        mode=MountMode.WRITE).ops


@pytest.fixture
def deep_scoped_session():
    """Bind a session whose role hides everything /data holds itself,
    leaving the nested mount below it reachable."""
    session = Session(session_id="agent",
                      hidden_paths=HiddenPaths(paths=("/data/other",
                                                      "/data/f.txt")))
    token = set_current_session(session)
    yield session
    reset_current_session(token)


class TestStructureOnlyParent:

    def test_walking_down_to_the_nested_mount_answers(self,
                                                      deep_scoped_session):
        # /data is real; the mount below it already put "data" in the
        # root listing, so readdir and stat answer with the structure.
        ops = _granted_child_ops()
        assert run(ops.readdir("/data")) == ["/data/inner"]
        st = run(ops.stat("/data"))
        assert st.type is FileType.DIRECTORY

    def test_paths_the_structure_does_not_owe_still_deny(
            self, deep_scoped_session):
        # A structure answer for the parent opens nothing below it: a
        # hidden path reads as absent and refuses to be created, which
        # is the one pair of answers a hide gives everywhere.
        ops = _granted_child_ops()
        with pytest.raises(FileNotFoundError):
            run(ops.readdir("/data/other"))
        with pytest.raises(PermissionError):
            run(ops.write("/data/f.txt", b"x"))


class _CountingPre(Policy):

    def __init__(self):
        self.calls = []

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        self.calls.append((ctx.op, ctx.path.virtual))
        return None


class _DenyEverything(Policy):

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        return Deny("sealed\n")


class TestAttachedOpsOneDoor:
    """Workspace-attached Ops delegates every op to the dispatcher."""

    @pytest.mark.asyncio
    async def test_gates_fire_exactly_once_per_op(self):
        counter = _CountingPre()
        ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
        try:
            ws.policies.add(counter)
            await ws.ops.write("/data/x.txt", b"body")
            assert counter.calls.count(("write", "/data/x.txt")) == 1
            counter.calls.clear()
            assert await ws.ops.read("/data/x.txt") == b"body"
            assert counter.calls.count(("read", "/data/x.txt")) == 1
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_records_survive_the_delegation(self):
        ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
        try:
            await ws.ops.write("/data/x.txt", b"12345")
            assert await ws.ops.read("/data/x.txt") == b"12345"
            recorded = {(r.op, r.path, r.bytes) for r in ws.ops.records}
            assert ("write", "/data/x.txt", 5) in recorded
            assert ("read", "/data/x.txt", 5) in recorded
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_a_pre_ops_deny_records_nothing(self):
        # The mirror of "a post deny still records the completed op"
        # (pinned in tests/workspace/workspace/test_policies.py): a pre
        # deny means the backend never ran, so nothing is recorded.
        ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
        try:
            ws.policies.add(_DenyEverything())
            with pytest.raises(PolicyDenied):
                await ws.ops.write("/data/x.txt", b"body")
            assert ws.ops.records == []
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_read_only_mount_refuses_writes_at_the_door(self):
        ws = Workspace({"/data/": RAMResource()}, mode=MountMode.READ)
        try:
            with pytest.raises(PermissionError):
                await ws.ops.write("/data/x.txt", b"body")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_attached_rename_stays_inside_a_mount(self):
        ws = Workspace({
            "/a/": RAMResource(),
            "/b/": RAMResource()
        },
                       mode=MountMode.WRITE)
        try:
            await ws.ops.write("/a/x.txt", b"body")
            await ws.ops.rename("/a/x.txt", "/a/y.txt")
            assert await ws.ops.read("/a/y.txt") == b"body"
            with pytest.raises(OSError) as exc:
                await ws.ops.rename("/a/y.txt", "/b/x.txt")
            assert exc.value.errno == errno.EXDEV
            assert await ws.ops.read("/a/y.txt") == b"body"
        finally:
            await ws.close()


class TestLiveIdentity:
    """The identity capability probe: no op wired reads back None, and a
    wired mount answers from the backend even when its own index cache
    is stale or actively lying."""

    def test_no_op_wired_reads_back_none(self):
        ops, _ = make_ops()
        run(ops.write("/data/a.txt", b"hello"))
        assert run(ops.live_identity("/data/a.txt")) is None

    def test_a_wired_mount_answers_with_the_backend_struct(self):
        resource = RAMResource()
        fresh = LiveFileIdentity(exists=True, revision="r1", fingerprint="fp1")

        async def fake_live_identity(accessor, path, **kwargs):
            return fresh

        resource.register_op(
            RegisteredOp(name="live_identity",
                         resource="ram",
                         filetype=None,
                         fn=fake_live_identity,
                         write=False))
        ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
        assert run(ws.ops.live_identity("/data/a.txt")) == fresh

    def test_ignores_a_wrong_entry_and_a_lying_negative_cache(self):
        # The index holds a stale positive entry for this exact path, and
        # its own get() answers NOT_FOUND for everything regardless of
        # what was put -- live_identity must still answer from the
        # backend, proving the op never consults the index either way.
        resource = RAMResource()

        class _LyingIndex(RAMIndexCacheStore):

            async def get(self, resource_path):
                return LookupResult(status=LookupStatus.NOT_FOUND)

        lying = _LyingIndex()
        resource._index = lying
        run(
            lying.put(
                "/a.txt",
                IndexEntry(id="wrong-id",
                           name="a.txt",
                           resource_type="ram/file")))
        fresh = LiveFileIdentity(exists=True,
                                 revision="fresh-rev",
                                 fingerprint="fresh-fp")

        async def fake_live_identity(accessor, path, **kwargs):
            return fresh

        resource.register_op(
            RegisteredOp(name="live_identity",
                         resource="ram",
                         filetype=None,
                         fn=fake_live_identity,
                         write=False))
        ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
        assert run(ws.ops.live_identity("/data/a.txt")) == fresh


class _CachingRAM(RAMResource):
    caches_reads = True


async def _stamped_read(accessor, path, **kwargs) -> bytes:
    """A backend read that stamps markers on its own record.

    Args:
        accessor: the mount's accessor.
        path: the path being read.
        **kwargs: the op's other arguments, unused.
    """
    data = b"versioned"
    record("read",
           path.virtual,
           "ram",
           len(data),
           int(time.monotonic() * 1000),
           fingerprint="fp-1",
           revision="rev-1")
    return data


class TestReadWithIdentity:
    """The read-side stamp comes from the read's own recorded markers,
    never a second call, and forwards to an enclosing recording frame."""

    def test_returns_bytes_and_none_on_ram(self):
        ops, _ = make_ops()
        run(ops.write("/data/a.txt", b"hello"))
        data, identity = run(ops.read_with_identity("/data/a.txt"))
        assert data == b"hello"
        assert identity is None

    def test_identity_populated_when_the_read_stamps_markers(self):
        resource = RAMResource()

        async def fake_read(accessor, path, **kwargs):
            data = b"versioned"
            record("read",
                   path.virtual,
                   "ram",
                   len(data),
                   int(time.monotonic() * 1000),
                   fingerprint="fp-1",
                   revision="rev-1")
            return data

        resource.register_op(
            RegisteredOp(name="read",
                         resource="ram",
                         filetype=None,
                         fn=fake_read,
                         write=False))
        ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
        data, identity = run(ws.ops.read_with_identity("/data/a.txt"))
        assert data == b"versioned"
        assert identity == LiveFileIdentity(exists=True,
                                            revision="rev-1",
                                            fingerprint="fp-1")

    def test_nested_records_forward_to_an_enclosing_scope_on_success(self):
        resource = RAMResource()

        async def fake_read(accessor, path, **kwargs):
            record("read",
                   path.virtual,
                   "ram",
                   4,
                   int(time.monotonic() * 1000),
                   fingerprint="fp-2",
                   revision="rev-2")
            return b"data"

        resource.register_op(
            RegisteredOp(name="read",
                         resource="ram",
                         filetype=None,
                         fn=fake_read,
                         write=False))
        ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
        outer = RecordingScope()
        try:
            run(ws.ops.read_with_identity("/data/a.txt"))
        finally:
            outer.close()
        assert any(r.revision == "rev-2" for r in outer.records)

    def test_nested_records_forward_to_an_enclosing_scope_on_a_raising_read(
            self):
        resource = RAMResource()

        async def failing_read(accessor, path, **kwargs):
            record("read",
                   path.virtual,
                   "ram",
                   0,
                   int(time.monotonic() * 1000),
                   fingerprint="fp-3",
                   revision="rev-3")
            raise RuntimeError("boom")

        resource.register_op(
            RegisteredOp(name="read",
                         resource="ram",
                         filetype=None,
                         fn=failing_read,
                         write=False))
        ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
        outer = RecordingScope()
        try:
            with pytest.raises(RuntimeError):
                run(ws.ops.read_with_identity("/data/a.txt"))
        finally:
            outer.close()
        assert any(r.revision == "rev-3" for r in outer.records)

    def test_the_warm_file_cache_does_not_answer_the_identity_read(self):
        # A cached read crosses no network and stamps no marker, so
        # serving one here would hand back bytes with identity None for
        # a file the backend versions. The plain read still takes the
        # cache; only this one refuses it.
        resource = _CachingRAM()
        resource.register_op(
            RegisteredOp(name="read",
                         resource="ram",
                         filetype=None,
                         fn=_stamped_read,
                         write=False))
        ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
        run(
            ws.apply_io(
                IOResult(reads={"/data/a.txt": b"CACHED"},
                         cache=["/data/a.txt"])))
        assert run(ws.ops.read("/data/a.txt")) == b"CACHED"
        data, identity = run(ws.ops.read_with_identity("/data/a.txt"))
        assert data == b"versioned"
        assert identity == LiveFileIdentity(exists=True,
                                            revision="rev-1",
                                            fingerprint="fp-1")

    def test_the_mount_index_does_not_answer_the_identity_read(self):
        # The other half of "fresh": an id-addressed backend turns a
        # path into an id through the index, and a remembered binding
        # never expires, so a stale one would stamp the identity of the
        # file that used to live at this path onto that file's bytes.
        # The op is handed an empty store of its own -- not None, which
        # is not a store, and not the mount's, which is the memory being
        # refused -- and the mount's own index is left untouched.
        resource = RAMResource()
        seen: list[IndexCacheStore | None] = []

        async def capturing_read(accessor, path, index=None, **kwargs):
            seen.append(index)
            return b"live"

        resource.register_op(
            RegisteredOp(name="read",
                         resource="ram",
                         filetype=None,
                         fn=capturing_read,
                         write=False))
        ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
        run(ws.ops.read("/data/a.txt"))
        run(ws.ops.read_with_identity("/data/a.txt"))
        plain, fresh = seen
        assert plain is resource.index
        assert isinstance(fresh, RAMIndexCacheStore)
        assert fresh is not resource.index
        assert run(fresh.entries()) == {}

    def test_a_marker_for_another_path_is_not_read_as_this_one(self):
        # FallbackStorage (the browser) hands the newest live frame to
        # every reader, so a concurrent read's record can land in this
        # frame. Filtering on the record's own path is what stops that
        # record from being reported as this file's identity.
        resource = RAMResource()

        async def cross_talking_read(accessor, path, **kwargs):
            record("read",
                   "/data/other.txt",
                   "ram",
                   1,
                   int(time.monotonic() * 1000),
                   fingerprint="fp-other",
                   revision="rev-other")
            return b"mine"

        resource.register_op(
            RegisteredOp(name="read",
                         resource="ram",
                         filetype=None,
                         fn=cross_talking_read,
                         write=False))
        ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
        data, identity = run(ws.ops.read_with_identity("/data/a.txt"))
        assert data == b"mine"
        assert identity is None

    def test_a_read_through_a_symlink_still_finds_its_marker(self):
        # The record names the followed path, so the filter has to
        # follow too: comparing against the link's own name would drop
        # the marker of every read reached through one.
        resource = RAMResource()
        resource.register_op(
            RegisteredOp(name="read",
                         resource="ram",
                         filetype=None,
                         fn=_stamped_read,
                         write=False))
        ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
        run(ws.ops.write("/data/a.txt", b"stored"))
        run(ws.ops.symlink("/data/link.txt", "/data/a.txt"))
        data, identity = run(ws.ops.read_with_identity("/data/link.txt"))
        assert data == b"versioned"
        assert identity == LiveFileIdentity(exists=True,
                                            revision="rev-1",
                                            fingerprint="fp-1")


class _CapReadBytes(Policy):
    """A post_ops policy that bounds every read to ``max_bytes``."""

    def __init__(self, max_bytes: int) -> None:
        self._max_bytes = max_bytes

    async def post_ops(self, ctx: OpsResultContext) -> Action | None:
        if ctx.op == "read":
            return Limit(max_bytes=self._max_bytes)
        return None


async def _rendered_read(accessor, path, **kwargs) -> bytes:
    """A rendered read: markers describe the stored bytes it read.

    The record measures the source (9 bytes), the op answers with a
    shorter rendering, and neither number is wrong -- which is why the
    truncation test cannot be a length comparison.

    Args:
        accessor: the mount's accessor.
        path: the path being read.
        **kwargs: the op's other arguments, unused.
    """
    record("read",
           path.virtual,
           "ram",
           len(b"raw-bytes"),
           int(time.monotonic() * 1000),
           fingerprint="fp-r",
           revision="rev-r")
    return b"tally"


def _capped_workspace(max_bytes: int) -> Workspace:
    """A workspace whose reads a post_ops policy bounds.

    Args:
        max_bytes (int): the bound every read is capped to.
    """
    resource = RAMResource()
    resource.register_op(
        RegisteredOp(name="read",
                     resource="ram",
                     filetype=None,
                     fn=_stamped_read,
                     write=False))
    ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
    ws.policies.add(_CapReadBytes(max_bytes))
    return ws


class TestReadWithIdentityUnderAPolicyCap:
    """A cap truncates after the backend answered, so the delivered
    bytes are a prefix while the markers still describe the whole file.
    The pair is refused rather than degraded: bypassing the cap is a
    policy bypass, and a None identity loses the same data one step
    later, once the caller hashes the prefix and writes it back."""

    def test_the_plain_read_still_serves_the_capped_prefix(self):
        ws = _capped_workspace(4)
        assert run(ws.ops.read("/data/a.txt")) == b"vers"

    def test_the_identity_read_refuses_a_truncated_pairing(self):
        ws = _capped_workspace(4)
        with pytest.raises(CappedReadError) as excinfo:
            run(ws.ops.read_with_identity("/data/a.txt"))
        assert excinfo.value.errno == errno.EINVAL
        assert "policy cap truncated" in str(excinfo.value)

    def test_the_workspace_facade_refuses_it_too(self):
        ws = _capped_workspace(4)
        with pytest.raises(CappedReadError):
            run(ws.read_with_identity("/data/a.txt"))

    def test_a_cap_that_truncates_nothing_still_answers(self):
        # The refusal is truncation, not the presence of a bound: a cap
        # wider than the file leaves the delivered bytes whole.
        ws = _capped_workspace(64)
        data, identity = run(ws.ops.read_with_identity("/data/a.txt"))
        assert data == b"versioned"
        assert identity == LiveFileIdentity(exists=True,
                                            revision="rev-1",
                                            fingerprint="fp-1")

    def test_a_rendered_read_is_not_mistaken_for_a_truncated_one(self):
        # A rendered read's marker record measures the bytes the backend
        # moved (9), and the op answers with a 5-byte rendering; only the
        # door knows no cap ran, which is why the report is what is read
        # back rather than the two lengths.
        resource = RAMResource()
        resource.register_op(
            RegisteredOp(name="read",
                         resource="ram",
                         filetype=".tally",
                         fn=_rendered_read,
                         write=False))
        ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
        run(ws.ops.write("/data/hits.tally", b"raw-bytes"))
        data, identity = run(ws.ops.read_with_identity("/data/hits.tally"))
        assert data == b"tally"
        assert identity == LiveFileIdentity(exists=True,
                                            revision="rev-r",
                                            fingerprint="fp-r")


class TestProbesAndConveniences:
    """The surface union with the TS facade (R7b).

    Only a genuine missing path reads back False from the probes; an
    auth failure or a backend bug propagates, since acting on a false
    "missing" means overwriting or recreating data that is there.
    """

    def test_exists_answers_the_three_cases(self):
        ops, _ = make_ops()
        run(ops.write("/data/a.txt", b"x"))
        run(ops.mkdir("/data/dir"))
        assert run(ops.exists("/data/a.txt")) is True
        assert run(ops.exists("/data/dir")) is True
        assert run(ops.exists("/data/nope.txt")) is False
        assert run(ops.exists("/nowhere/x.txt")) is False

    def test_is_dir_and_is_file_split_on_the_stat_type(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/f.txt", b"x"))
        assert run(ops.is_dir("/data/dir")) is True
        assert run(ops.is_file("/data/dir")) is False
        assert run(ops.is_file("/data/dir/f.txt")) is True
        assert run(ops.is_dir("/data/dir/f.txt")) is False
        assert run(ops.is_dir("/data/nope")) is False
        assert run(ops.is_file("/data/nope")) is False

    def test_cat_decodes_utf8(self):
        ops, _ = make_ops()
        run(ops.write("/data/a.txt", "héllo".encode()))
        assert run(ops.cat("/data/a.txt")) == "héllo"

    def test_list_files_keeps_files_only_as_basenames(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/a.txt", b"1"))
        run(ops.mkdir("/data/dir/sub"))
        assert run(ops.list_files("/data/dir")) == ["a.txt"]
