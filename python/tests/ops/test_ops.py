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

import pytest

from mirage import Workspace
from mirage.context import reset_current_session, set_current_session
from mirage.ops import Ops
from mirage.policy import (Action, Deny, OpsContext, OpsResultContext, Policy,
                           PolicyDenied)
from mirage.resource.ram import RAMResource
from mirage.types import FileType, HiddenPaths, MountMode
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
                     mode=MountMode.WRITE).fs


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
        ws.fs.records.clear()
        assert await ws.fs.readdir("/m/inner") == ["/m/inner/deep"]
        assert [(r.source, r.is_cache)
                for r in ws.fs.records] == [("ram", True)]
        assert ws.fs.network_records == []
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
        ws.fs.records.clear()
        with pytest.raises(PermissionError):
            await ws.fs.readdir("/m/inner")
        assert [(r.source, r.is_cache)
                for r in ws.fs.records] == [("ram", True)]
        assert ws.fs.network_records == []
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
        }, mode=MountMode.WRITE).fs
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
        return ws.fs, store

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
                     policies=policies).fs


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
        mode=MountMode.WRITE).fs


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
            await ws.fs.write("/data/x.txt", b"body")
            assert counter.calls.count(("write", "/data/x.txt")) == 1
            counter.calls.clear()
            assert await ws.fs.read("/data/x.txt") == b"body"
            assert counter.calls.count(("read", "/data/x.txt")) == 1
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_records_survive_the_delegation(self):
        ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
        try:
            await ws.fs.write("/data/x.txt", b"12345")
            assert await ws.fs.read("/data/x.txt") == b"12345"
            recorded = {(r.op, r.path, r.bytes) for r in ws.fs.records}
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
                await ws.fs.write("/data/x.txt", b"body")
            assert ws.fs.records == []
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_read_only_mount_refuses_writes_at_the_door(self):
        ws = Workspace({"/data/": RAMResource()}, mode=MountMode.READ)
        try:
            with pytest.raises(PermissionError):
                await ws.fs.write("/data/x.txt", b"body")
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
            await ws.fs.write("/a/x.txt", b"body")
            await ws.fs.rename("/a/x.txt", "/a/y.txt")
            assert await ws.fs.read("/a/y.txt") == b"body"
            with pytest.raises(OSError) as exc:
                await ws.fs.rename("/a/y.txt", "/b/x.txt")
            assert exc.value.errno == errno.EXDEV
            assert await ws.fs.read("/a/y.txt") == b"body"
        finally:
            await ws.close()


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
