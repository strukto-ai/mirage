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

import asyncio
import errno
from collections.abc import AsyncIterator
from unittest.mock import AsyncMock, MagicMock

import pytest

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.errors import LimitExceededError
from mirage.context import reset_current_session, set_current_session
from mirage.errors import FsCondition, posix_errno
from mirage.errors.types import CommandTimeoutError, ReadOnlyError
from mirage.io import OpReport
from mirage.policy import (
    Action,
    CommandRule,
    Deny,
    Policies,
    Policy,
    PolicyDenied,
    VfsContext,
    VfsResultContext,
)
from mirage.policy.rule import RulePolicy
from mirage.types import (
    FileStat,
    FileType,
    HiddenPaths,
    Limit,
    MountMode,
    OnExceed,
    PathSpec,
    Visibility,
)
from mirage.utils.ranges import slice_window, splice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.disk import DiskVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.dispatcher.constants import POLICY_WRITE_OPS
from mirage.workspace.dispatcher.dispatcher import Dispatcher, _MountChannel
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.session import SessionState
from tests.fixtures.vfs_io import override, render


class DenyLocked(Policy):
    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        if ctx.path.virtual.startswith("/data/locked/"):
            return Deny("locked\n")
        return None


class DenyWrites(Policy):
    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        if ctx.write:
            return Deny("no writes\n")
        return None


class DenyRemnantUnlink(Policy):
    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        if ctx.op == "unlink" and ctx.path.virtual == "/a/d/sec/k":
            return Deny("protected\n")
        return None


class DenyUnlinkAfter(Policy):
    async def post_vfs(self, ctx: VfsResultContext) -> Action | None:
        return Deny("too late") if ctx.op == "unlink" else None


class _FailingRAM(RAMVFS):
    """A RAM VFS whose listing or deletion fails with an error of its own
    type once armed, as an API backend's can (box raises its own)."""

    failing: str | None = None

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        if self.failing == "readdir":
            raise RuntimeError("api exploded")
        return await super().readdir(path, index)

    async def unlink(self, path: PathSpec) -> None:
        if self.failing == "unlink":
            raise RuntimeError("api exploded")
        await super().unlink(path)


def _path(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual.rsplit("/", 1)[0] or "/",
        vfs_path="",
        raw_path=virtual,
        resolved=True,
    )


def _dispatcher(policies: Policies) -> tuple[Dispatcher, MagicMock]:
    namespace = MagicMock()
    namespace.ensure_loaded = AsyncMock()
    namespace.follow = MagicMock(side_effect=lambda p: p)
    namespace.follow_parent = MagicMock(side_effect=lambda p: p)
    mount = MagicMock()
    mount.prefix = "/data/"
    mount.retiring = False
    mount.ensure_ready = AsyncMock()
    mount.vfs.caches_reads = True
    mount.renders = MagicMock(return_value=False)
    mount.writes = MagicMock(return_value=False)
    mount.call = AsyncMock(return_value=b"cold")
    namespace.try_mount_for = MagicMock(return_value=mount)
    namespace.registry.policies = policies
    cache = MagicMock()
    cache.get = AsyncMock(return_value=b"warm")
    dispatcher = Dispatcher(namespace, cache)
    reconciler = MagicMock()
    reconciler.may_serve_cached = AsyncMock(return_value=True)
    dispatcher._reconciler = reconciler
    return dispatcher, cache


@pytest.mark.asyncio
async def test_warm_cache_read_cannot_bypass_pre_vfs():
    # The #241 failure class: a cached read served without consulting
    # the policy would make the cache a policy bypass. The hook fires
    # before the cache lookup, so the warm path refuses identically.
    policies = Policies()
    policies.add(DenyLocked())
    dispatcher, cache = _dispatcher(policies)
    with pytest.raises(PolicyDenied):
        await dispatcher.dispatch("read", _path("/data/locked/a.txt"))
    cache.get.assert_not_awaited()


@pytest.mark.asyncio
async def test_warm_cache_read_serves_when_no_policy_objects():
    policies = Policies()
    policies.add(DenyLocked())
    dispatcher, cache = _dispatcher(policies)
    result, _ = await dispatcher.dispatch("read", _path("/data/open/a.txt"))
    assert result == b"warm"
    cache.get.assert_awaited_once()


@pytest.mark.asyncio
async def test_setattr_classifies_as_a_write():
    # touch on an existing file mutates via setattr, which is absent
    # from the dispatcher's own invalidation set; the policy write
    # classification must still cover it.
    policies = Policies()
    policies.add(DenyWrites())
    dispatcher, _ = _dispatcher(policies)
    with pytest.raises(PolicyDenied):
        await dispatcher.dispatch("setattr", _path("/data/a.txt"))
    result, _ = await dispatcher.dispatch("stat", _path("/data/a.txt"))
    assert result == b"cold"


@pytest.mark.asyncio
async def test_symlink_classifies_as_a_write():
    # A symlink create is a name-plane write the dispatcher itself answers;
    # the policy write classification must cover it like any mutation.
    policies = Policies()
    policies.add(DenyWrites())
    dispatcher, _ = _dispatcher(policies)
    ns = dispatcher._namespace
    ns.registry.mounts = MagicMock(
        return_value=[ns.try_mount_for.return_value]
    )
    ns.symlink = AsyncMock()
    with pytest.raises(PolicyDenied):
        await dispatcher.dispatch("symlink", _path("/data/lk"), target="x")
    ns.symlink.assert_not_awaited()


@pytest.mark.asyncio
async def test_readlink_answers_from_the_namespace():
    # readlink is the read twin: the namespace table is the authority,
    # never a backend, and the operand is not rewritten through follow.
    dispatcher, _ = _dispatcher(Policies())
    ns = dispatcher._namespace
    ns.registry.mounts = MagicMock(
        return_value=[ns.try_mount_for.return_value]
    )
    ns.readlink = MagicMock(return_value="x.txt")
    result, _ = await dispatcher.dispatch("readlink", _path("/data/lk"))
    assert result == "x.txt"
    ns.follow.assert_not_called()


@pytest.mark.asyncio
async def test_spec_op_twin_holds_on_the_dispatcher():
    policies = Policies()
    policies.add(
        RulePolicy(CommandRule(reason="frozen", paths=("/data/locked/*",)))
    )
    dispatcher, _ = _dispatcher(policies)
    with pytest.raises(PolicyDenied) as excinfo:
        await dispatcher.dispatch("read", _path("/data/locked/a.txt"))
    assert excinfo.value.refusal and "frozen" in excinfo.value.refusal.reason


def _structure_only(dispatcher) -> None:
    """Point the mocks at a path no mount serves but structure knows:
    try_mount_for misses, while a mount deeper down makes the namespace
    answer readdir/stat for its parent."""
    namespace = dispatcher._namespace
    namespace.try_mount_for = MagicMock(return_value=None)
    deep = MagicMock()
    deep.prefix = "/data/locked/inner/deep/"
    namespace.registry.visible_mounts = MagicMock(return_value=[deep])
    namespace.symlink_targets = MagicMock(return_value={})


@pytest.mark.asyncio
async def test_structure_fallback_still_clears_admission():
    # A path with no owning mount can still answer readdir/stat from
    # namespace structure. That synthetic answer must pass the same
    # gates as a backend one, or "no mount here" is a policy bypass.
    policies = Policies()
    policies.add(DenyLocked())
    dispatcher, _ = _dispatcher(policies)
    _structure_only(dispatcher)
    with pytest.raises(PolicyDenied):
        await dispatcher.dispatch("readdir", _path("/data/locked/inner"))
    with pytest.raises(PolicyDenied):
        await dispatcher.dispatch("stat", _path("/data/locked/inner"))


@pytest.mark.asyncio
async def test_structure_fallback_serves_when_no_policy_objects():
    dispatcher, _ = _dispatcher(Policies())
    _structure_only(dispatcher)
    result, _ = await dispatcher.dispatch(
        "readdir", _path("/data/locked/inner")
    )
    assert result == ["/data/locked/inner/deep"]


@pytest.fixture
def scoped_session():
    """Bind a session whose profile hides the parent mount's own content,
    leaving the mount nested below it reachable."""
    session = SessionState(
        session_id="agent",
        visibility=Visibility(
            paths=HiddenPaths(
                paths=("/data/locked/other", "/data/locked/f.txt")
            )
        ),
    )
    token = set_current_session(session)
    yield session
    reset_current_session(token)


@pytest.mark.asyncio
async def test_a_structure_answer_still_clears_the_sessions_hides(
    scoped_session,
):
    # The synthetic answer passes the session's view as well as the
    # policy chain: it is produced above every backend, so a path the
    # profile hides would otherwise be served by the one code path that
    # asks no mount anything.
    dispatcher, _ = _dispatcher(Policies())
    _structure_only(dispatcher)
    result, _ = await dispatcher.dispatch(
        "readdir", _path("/data/locked/inner")
    )
    assert result == ["/data/locked/inner/deep"]
    with pytest.raises(FileNotFoundError):
        await dispatcher.dispatch("readdir", _path("/data/locked/other"))


@pytest.mark.asyncio
async def test_a_hidden_path_denies_a_read_and_refuses_a_create(
    scoped_session,
):
    # The hide's two verdicts, at the dispatcher every surface comes through:
    # absent on a read, EACCES on a create, and a write is never served
    # from structure.
    dispatcher, _ = _dispatcher(Policies())
    _structure_only(dispatcher)
    with pytest.raises(FileNotFoundError):
        await dispatcher.dispatch("stat", _path("/data/locked/other"))
    with pytest.raises(PermissionError):
        await dispatcher.dispatch(
            "write", _path("/data/locked/f.txt"), data=b"x"
        )


@pytest.mark.asyncio
async def test_a_create_under_a_hidden_directory_is_absent_like_its_reads(
    scoped_session,
):
    # Every read on a hidden directory answers ENOENT, and a create
    # beneath it used to answer EACCES, so a session could map a
    # profile's hidden prefixes by probing writes. The parent decides:
    # under a hidden directory a create is ENOENT, and at a hidden name
    # under a visible directory it keeps EACCES, the way an existing
    # file the session cannot write does. A rename destination is a
    # create and answers the same way, and so is truncate, which
    # creates a missing file at the requested length.
    dispatcher, _ = _dispatcher(Policies())
    for op, kwargs in (
        ("write", {"data": b"x"}),
        ("mkdir", {}),
        ("create", {}),
        ("truncate", {"length": 0}),
    ):
        with pytest.raises(FileNotFoundError):
            await dispatcher.dispatch(
                op, _path("/data/locked/other/new.txt"), **kwargs
            )
    with pytest.raises(PermissionError):
        await dispatcher.dispatch(
            "truncate", _path("/data/locked/f.txt"), length=0
        )
    with pytest.raises(FileNotFoundError):
        await dispatcher.dispatch(
            "rename",
            _path("/data/locked/a.txt"),
            dst=_path("/data/locked/other/moved"),
        )
    with pytest.raises(PermissionError):
        await dispatcher.dispatch("mkdir", _path("/data/locked/other"))
    with pytest.raises(PermissionError):
        await dispatcher.dispatch(
            "rename",
            _path("/data/locked/a.txt"),
            dst=_path("/data/locked/f.txt"),
        )


@pytest.mark.asyncio
async def test_unlink_removes_a_namespace_link():
    # The dispatcher creates links (`symlink`), so it has to remove them too:
    # a link has no backend entry, so forwarding the unlink reaches a
    # backend that has never heard of the name and answers ENOENT,
    # leaving the link in place. That is what left `git checkout` unable
    # to drop a link the other branch does not have.
    with Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("echo hi > /ram/a.txt")
        await ws.shell("ln -s a.txt /ram/link")
        assert ws._namespace.is_link("/ram/link")
        await ws.dispatch("unlink", PathSpec.from_str_path("/ram/link"))
        assert not ws._namespace.is_link("/ram/link")
        listing = await ws.shell("ls /ram")
        assert b"link" not in (listing.stdout or b"")


@pytest.mark.asyncio
async def test_unlink_of_an_ordinary_file_still_reaches_the_backend():
    with Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("echo hi > /ram/a.txt")
        await ws.dispatch("unlink", PathSpec.from_str_path("/ram/a.txt"))
        listing = await ws.shell("ls /ram")
        assert (listing.stdout or b"").strip() == b""


@pytest.mark.asyncio
async def test_rename_moves_a_namespace_link():
    # Same fact as the unlink above, one verb along: a guest's os.rename
    # of a link forwarded to a backend that had never heard of the name,
    # so it answered ENOENT with the link still under the old one.
    with Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("echo hi > /ram/a.txt")
        await ws.shell("ln -s a.txt /ram/link")
        await ws.dispatch(
            "rename",
            PathSpec.from_str_path("/ram/link"),
            dst=PathSpec.from_str_path("/ram/moved"),
        )
        assert not ws._namespace.is_link("/ram/link")
        assert ws._namespace.readlink("/ram/moved") == "a.txt"


@pytest.mark.asyncio
async def test_rename_carries_the_nodes_below_a_directory():
    # A rename re-anchors a whole subtree, and the part of it no backend
    # can see has to move with it: the link below the source used to
    # stay at a name the rename had emptied, so the moved directory was
    # missing it and the old name still answered readlink.
    with Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("mkdir -p /ram/d && echo hi > /ram/d/a.txt")
        await ws.shell("ln -s a.txt /ram/d/link")
        await ws.dispatch(
            "rename",
            PathSpec.from_str_path("/ram/d"),
            dst=PathSpec.from_str_path("/ram/e"),
        )
        assert not ws._namespace.is_link("/ram/d/link")
        assert ws._namespace.readlink("/ram/e/link") == "a.txt"


@pytest.mark.asyncio
async def test_rename_refuses_a_destination_holding_a_link():
    # A link is a directory entry no backend can see, so a destination
    # the backend reads as empty is not: POSIX rename(2) answers
    # ENOTEMPTY for it (probed on debian:stable-slim, where a directory
    # holding one broken symlink refuses the rename). Letting the
    # backend decide replaced the directory and deleted the link with
    # it, which loses namespace state where the kernel refuses.
    with Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("mkdir -p /ram/d /ram/e && echo hi > /ram/d/a.txt")
        await ws.shell("ln -s a.txt /ram/d/link")
        await ws.shell("ln -s gone /ram/e/stale")
        with pytest.raises(OSError) as caught:
            await ws.dispatch(
                "rename",
                PathSpec.from_str_path("/ram/d"),
                dst=PathSpec.from_str_path("/ram/e"),
            )
        assert caught.value.errno == errno.ENOTEMPTY
        # Nothing moved: both ends are as they were.
        assert ws._namespace.readlink("/ram/e/stale") == "gone"
        assert ws._namespace.readlink("/ram/d/link") == "a.txt"


@pytest.mark.asyncio
async def test_rename_replaces_an_empty_destination():
    # The other half of rename(2): a destination with nothing in it is
    # replaced, and the subtree re-anchors onto the new name.
    with Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("mkdir -p /ram/d /ram/e && echo hi > /ram/d/a.txt")
        await ws.shell("ln -s a.txt /ram/d/link")
        await ws.dispatch(
            "rename",
            PathSpec.from_str_path("/ram/d"),
            dst=PathSpec.from_str_path("/ram/e"),
        )
        assert ws._namespace.readlink("/ram/e/link") == "a.txt"
        assert not ws._namespace.is_link("/ram/d/link")


@pytest.mark.asyncio
async def test_a_no_follow_stat_answers_a_links_own_row():
    # lstat asks for the row only the node table holds. Without it every
    # surface rebuilt the row from the target string and reported epoch
    # zero, so a no-follow utime persisted and stayed invisible.
    with Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("echo hi > /ram/a.txt")
        await ws.shell("ln -s a.txt /ram/link")
        link = PathSpec.from_str_path("/ram/link")
        row, _ = await ws.dispatch("stat", link, nofollow=True)
        assert row.type == FileType.SYMLINK
        assert row.size == len("a.txt")
        await ws.dispatch(
            "setattr",
            link,
            mode=None,
            uid=None,
            gid=None,
            atime=None,
            mtime="2020-01-02T03:04:05Z",
            nofollow=True,
        )
        row, _ = await ws.dispatch("stat", link, nofollow=True)
        assert row.modified == "2020-01-02T03:04:05Z"
        # Following is the other answer: the target's row, not the link's.
        followed, _ = await ws.dispatch("stat", link)
        assert followed.type != FileType.SYMLINK


@pytest.mark.asyncio
async def test_a_rename_replaces_a_link_at_the_destination():
    # rename(2) replaces the destination. A link left in the table there
    # shadowed the file that had just landed: the listing showed the new
    # file, every read followed the old link, and the moved content was
    # reachable under no name at all. mv did this right at the command
    # tier, so only the surfaces below it (a guest, a kernel mount) saw
    # the broken state.
    with Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("echo hi > /ram/a.txt")
        await ws.shell("echo tgt > /ram/t.txt")
        await ws.shell("ln -s t.txt /ram/link")
        await ws.dispatch(
            "rename",
            PathSpec.from_str_path("/ram/a.txt"),
            dst=PathSpec.from_str_path("/ram/link"),
        )
        assert not ws._namespace.is_link("/ram/link")
        assert (await ws.shell("cat /ram/link")).stdout == b"hi\n"


@pytest.mark.asyncio
async def test_a_read_grant_refuses_link_writes_like_file_writes():
    # The mode gate on the table ops. A read grant refused a file's
    # unlink with EROFS while the same session deleted, created and
    # renamed its sibling link: the table verbs ran no mode check at
    # all, so `mounts: {"/extra": "read"}` protected everything on the
    # mount except its names.
    with Workspace({"/extra/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("echo b > /extra/plain.txt")
        await ws.shell("ln -s plain.txt /extra/lk")
        sess = ws.create_session("agent", mounts={"/extra/": "read"})
        token = set_current_session(sess)
        try:
            for coro in (
                ws.dispatch("unlink", PathSpec.from_str_path("/extra/lk")),
                ws.dispatch(
                    "symlink",
                    PathSpec.from_str_path("/extra/lk2"),
                    target="plain.txt",
                ),
                ws.dispatch(
                    "rename",
                    PathSpec.from_str_path("/extra/lk"),
                    dst=PathSpec.from_str_path("/extra/mv"),
                ),
            ):
                with pytest.raises(ReadOnlyError) as exc:
                    await coro
                assert exc.value.errno == errno.EROFS
        finally:
            reset_current_session(token)
        assert ws._namespace.readlink("/extra/lk") == "plain.txt"
        assert not ws._namespace.is_link("/extra/lk2")


@pytest.mark.asyncio
# mkdir looks its name up first (test_a_read_only_mkdir_answers_what_its_name_holds).
@pytest.mark.parametrize("op", sorted(POLICY_WRITE_OPS - {"mkdir"}))
async def test_read_only_admission_precedes_backend_support_and_io(op):
    with Workspace({"/ro": (RAMVFS(), MountMode.READ)}) as ws:
        mount = ws.namespace.mount_for("/ro/file")
        mount.ensure_ready = AsyncMock(
            side_effect=AssertionError("backend reached")
        )
        with pytest.raises(ReadOnlyError) as exc:
            await ws.dispatch(op, PathSpec.from_str_path("/ro/file"))
        assert exc.value.errno == errno.EROFS
        mount.ensure_ready.assert_not_awaited()
        assert not ws.namespace.is_link("/ro/file")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("path", "parents", "errno_"),
    [
        ("/ro/d", False, errno.EEXIST),
        ("/ro/d", True, None),
        ("/ro/f", False, errno.EEXIST),
        ("/ro/f/x", False, errno.ENOTDIR),
        ("/ro/gone/x", False, errno.ENOENT),
        ("/ro/gone/x", True, errno.EROFS),
        ("/ro/new", False, errno.EROFS),
    ],
)
async def test_a_read_only_mkdir_answers_what_its_name_holds(
    path, parents, errno_
):
    # mkdir(2) on a read-only filesystem refuses only a create it would
    # really make: a taken name is EEXIST, a file in the chain ENOTDIR,
    # and `mkdir -p` of a directory already there succeeds.
    ram = RAMVFS()
    ram._store.files["/f"] = b"x"
    ram._store.dirs.add("/d")
    with Workspace({"/ro": (ram, MountMode.READ)}) as ws:
        spec = PathSpec.from_str_path(path)
        if errno_ is None:
            await ws.dispatch("mkdir", spec, parents=parents)
            return
        with pytest.raises(OSError) as exc:
            await ws.dispatch("mkdir", spec, parents=parents)
        assert exc.value.errno == errno_


@pytest.mark.asyncio
async def test_a_write_reads_the_mode_again_as_it_starts():
    # Admission judged the mount writable before the write waited for
    # the mount; made read-only meanwhile, the mount refuses the write
    # as the backend call starts.
    ram = RAMVFS()
    with Workspace({"/rw": (ram, MountMode.WRITE)}) as ws:
        mount = ws.namespace.mount_for("/rw/file")
        ready = mount.ensure_ready

        async def turn_read_only() -> None:
            ws.set_mount_mode("/rw", MountMode.READ)
            await ready()

        mount.ensure_ready = turn_read_only
        with pytest.raises(ReadOnlyError):
            await ws.dispatch(
                "write", PathSpec.from_str_path("/rw/file"), data=b"x"
            )
        assert not await ram.exists(PathSpec.from_str_path("/file"))


@pytest.mark.asyncio
async def test_a_rename_destination_is_judged_on_its_own_turf():
    # The endpoints need not share a turf, and each is scored against
    # its own prefix: a grant writing /rw but only reading /ro refuses,
    # blaming the destination, the way the backend gate checks both ends
    # of a rename. The grant is what binds, so both mounts are writable
    # and the session is the only thing narrowing either.
    with Workspace(
        {"/rw/": RAMVFS(), "/ro/": RAMVFS()}, mode=MountMode.WRITE
    ) as ws:
        await ws.shell("ln -s t /rw/lk")
        sess = ws.create_session(
            "agent", mounts={"/rw/": "write", "/ro/": "read"}
        )
        token = set_current_session(sess)
        try:
            with pytest.raises(ReadOnlyError) as exc:
                await ws.dispatch(
                    "rename",
                    PathSpec.from_str_path("/rw/lk"),
                    dst=PathSpec.from_str_path("/ro/lk"),
                )
            assert exc.value.filename == "/ro/lk"
        finally:
            reset_current_session(token)
        assert ws._namespace.is_link("/rw/lk")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "occupied", ["/ram/a.txt", "/ram/d", "/ram/link", "/ram"]
)
async def test_symlink_refuses_an_occupied_name(occupied):
    # symlink(2) is EEXIST on a name that is taken, and only the dispatcher can
    # tell: a file and a directory are the backend's, a link is the node
    # table's, and a mount root is the registry's. Unchecked, the node
    # went on top and buried whatever was there.
    with Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("echo hi > /ram/a.txt; mkdir /ram/d")
        await ws.shell("ln -s a.txt /ram/link")
        with pytest.raises(FileExistsError):
            await ws.dispatch(
                "symlink", PathSpec.from_str_path(occupied), target="elsewhere"
            )
        assert (await ws.shell("cat /ram/a.txt")).stdout == b"hi\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name,refusal",
    [
        ("/ram/nope/y", FileNotFoundError),
        ("/ram/nope/deeper/y", FileNotFoundError),
        ("/ram/dangling/y", FileNotFoundError),
        ("/ram/a.txt/y", NotADirectoryError),
        ("/ram/a.txt/sub/y", NotADirectoryError),
        ("/ram/flink/y", NotADirectoryError),
    ],
)
async def test_symlink_refuses_a_name_its_parent_cannot_hold(name, refusal):
    # symlink(2) resolves the directory a name goes in before the name:
    # ENOENT when it is absent, ENOTDIR when a plain file stands in the
    # chain at any depth, and a link above the name is followed first.
    # Unchecked, the node was an orphan that invented the directories
    # above it, which ls then listed.
    with Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("echo hi > /ram/a.txt; mkdir /ram/d")
        await ws.shell("ln -s missing /ram/dangling; ln -s a.txt /ram/flink")
        with pytest.raises(refusal):
            await ws.dispatch(
                "symlink", PathSpec.from_str_path(name), target="x"
            )
        assert sorted(ws.namespace.symlink_targets()) == [
            "/ram/dangling",
            "/ram/flink",
        ]
        listing = (await ws.shell("ls /ram")).stdout
        assert listing == b"a.txt\nd\ndangling\nflink\n"


@pytest.mark.asyncio
async def test_a_link_made_under_a_linked_directory_lands_in_its_target():
    # Every link above the final name is followed before the op sees the
    # path, whichever surface named it. The node table filed a relative
    # `ln -s t alias/x` under the alias's own name, where no listing of
    # the directory and no read through it ever looked.
    with Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("mkdir /ram/d /ram/e; ln -s d /ram/alias")
        await ws.dispatch(
            "symlink", PathSpec.from_str_path("/ram/alias/x"), target="t"
        )
        await ws.dispatch(
            "symlink", PathSpec.from_str_path("/ram/e/empty"), target="t"
        )
        assert ws.namespace.readlink("/ram/d/x") == "t"
        assert not ws.namespace.is_link("/ram/alias/x")
        found, _ = await ws.dispatch(
            "readlink", PathSpec.from_str_path("/ram/alias/x")
        )
        assert found == "t"
        assert ws.namespace.readlink("/ram/e/empty") == "t"


@pytest.mark.asyncio
async def test_a_link_in_a_listed_directory_costs_only_the_occupancy_probes():
    # The parent check rides on the probes the occupancy check already
    # makes: a parent whose listing answered with entries is a directory,
    # so a link made there asks the backend nothing more. The walk is for
    # an empty or silent parent, which is the refusal path nearly always.
    with Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("mkdir /ram/d; echo hi > /ram/d/a.txt")
        mount = ws.namespace.mount_for("/ram/d")
        execute = mount.call
        seen: list[tuple[str, str]] = []

        async def spy(op, path, *args, **kwargs):
            seen.append((op, path))
            return await execute(op, path, *args, **kwargs)

        mount.call = spy
        await ws.dispatch(
            "symlink", PathSpec.from_str_path("/ram/d/x"), target="t"
        )
        assert seen == [("stat", "/ram/d/x"), ("readdir", "/ram/d")]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "landing,refusal",
    [
        ("/ram/nope/x", FileNotFoundError),
        ("/ram/a.txt/x", NotADirectoryError),
    ],
)
async def test_a_link_rename_refuses_a_landing_its_parent_cannot_hold(
    landing, refusal
):
    # rename(2) resolves the destination's directory as symlink(2) does,
    # and the node table moved a link anywhere at all.
    with Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("echo hi > /ram/a.txt; ln -s a.txt /ram/link")
        with pytest.raises(refusal):
            await ws.dispatch(
                "rename",
                PathSpec.from_str_path("/ram/link"),
                dst=PathSpec.from_str_path(landing),
            )
        assert ws.namespace.readlink("/ram/link") == "a.txt"
        assert not ws.namespace.is_link(landing)


@pytest.mark.asyncio
async def test_the_remnant_channel_invalidates_each_deletion():
    # The cascade's call calls run outside the cache-manager
    # context command execution establishes, so the channel discharges
    # the dispatcher's write invalidation itself, per deletion, and
    # holds each deletion to the pre-vfs admission with its own child
    # path; the dispatch-level invalidation of the rmdir target covers
    # only the root and its ancestors. Reads stay gate- and
    # invalidation-free, and a failing deletion still invalidates: a
    # missing-path failure means the tree changed under the walk, and
    # the walk's own earlier listing must not survive it.
    mount = MagicMock()
    mount.call = AsyncMock(return_value=["h"])
    seen: list[str] = []
    admitted: list[tuple[str, str]] = []

    async def admit(op: str, spec: PathSpec, write: bool, **kwargs) -> None:
        admitted.append((op, spec.virtual))

    async def invalidate(spec: PathSpec) -> None:
        seen.append(spec.virtual)

    boundary = MagicMock()
    boundary.admit = admit
    boundary.complete = AsyncMock()
    channel = _MountChannel(mount, boundary, invalidate)
    await channel.readdir(_path("/data/d"))
    await channel.stat(_path("/data/d/h"))
    assert seen == []
    assert admitted == []
    await channel.unlink(_path("/data/d/h"))
    await channel.rmdir(_path("/data/d"))
    assert seen == ["/data/d/h", "/data/d"]
    assert admitted == [("unlink", "/data/d/h"), ("rmdir", "/data/d")]
    mount.call = AsyncMock(side_effect=FileNotFoundError("/data/d/h"))
    with pytest.raises(FileNotFoundError):
        await channel.unlink(_path("/data/d/h"))
    assert seen == ["/data/d/h", "/data/d", "/data/d/h"]


@pytest.mark.asyncio
async def test_ops_rmdir_cascade_invalidates_each_remnant(monkeypatch):
    # A direct dispatcher caller (FUSE, ws.vfs) establishes no
    # cache-manager context, so the cores' own invalidation cannot land
    # during the remnant cascade; every deletion must reach the
    # dispatcher's write invalidation, not only the rmdir target, or
    # the cached listings and bodies below the directory survive its
    # deletion.
    ws = Workspace({"/a": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell("mkdir -p /a/d/sec && printf 'k\\n' > /a/d/sec/k")
    assert io.exit_code == 0, io.stderr
    sess = ws.create_session("rev", profile={"paths": {"hide": ["/a/d/sec"]}})
    recorded: list[str] = []
    real = Dispatcher.invalidate_after_write

    async def spy(self, mount, path, observed=None, times=True, removed=False):
        recorded.append(path.virtual)
        await real(
            self, mount, path, observed=observed, times=times, removed=removed
        )

    monkeypatch.setattr(Dispatcher, "invalidate_after_write", spy)
    token = set_current_session(sess)
    try:
        await ws.vfs.rmdir("/a/d")
    finally:
        reset_current_session(token)
    assert "/a/d/sec/k" in recorded
    assert "/a/d/sec" in recorded
    assert "/a/d" in recorded
    gone = await ws.shell("test -e /a/d")
    assert gone.exit_code == 1


@pytest.mark.asyncio
async def test_a_policy_denied_remnant_keeps_the_refusal():
    # The gate that admitted the rmdir judged the directory; each
    # cascade deletion answers pre_vfs with its own child path, so a
    # policy that protects the hidden file refuses its unlink, the
    # cascade folds the denial into the original not-empty refusal,
    # and the protected content survives.
    ws = Workspace(
        {"/a": RAMVFS()}, mode=MountMode.WRITE, policies=[DenyRemnantUnlink()]
    )
    io = await ws.shell("mkdir -p /a/d/sec && printf 'k\\n' > /a/d/sec/k")
    assert io.exit_code == 0, io.stderr
    sess = ws.create_session("rev", profile={"paths": {"hide": ["/a/d/sec"]}})
    token = set_current_session(sess)
    try:
        with pytest.raises(OSError) as exc:
            await ws.vfs.rmdir("/a/d")
    finally:
        reset_current_session(token)
    assert exc.value.errno in (errno.ENOTEMPTY, errno.EEXIST)
    kept = await ws.shell("cat /a/d/sec/k")
    assert (kept.stdout or b"") == b"k\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("failing", ["readdir", "unlink"])
async def test_a_remnant_cascade_failing_any_other_way_keeps_the_refusal(
    failing,
):
    # A listing or deletion that fails with no errno still answers with the
    # backend's not-empty refusal: the raw failure would reveal exactly
    # what the refusal exists to hide.
    vfs = _FailingRAM()
    ws = Workspace({"/a": vfs}, mode=MountMode.WRITE)
    io = await ws.shell("mkdir -p /a/d/sec && printf 'k\\n' > /a/d/sec/k")
    assert io.exit_code == 0, io.stderr
    sess = ws.create_session("rev", profile={"paths": {"hide": ["/a/d/sec"]}})
    vfs.failing = failing
    token = set_current_session(sess)
    try:
        with pytest.raises(OSError) as exc:
            await ws.vfs.rmdir("/a/d")
    finally:
        reset_current_session(token)
    assert exc.value.errno in (errno.ENOTEMPTY, errno.EEXIST)


@pytest.mark.asyncio
async def test_a_post_vfs_deny_does_not_strand_the_cascade():
    # A deletion is done by the time post_vfs could speak, so the
    # cascade never asks it: the rmdir takes the hidden remnant and the
    # directory, rather than refusing with a child already gone.
    ws = Workspace(
        {"/a": RAMVFS()}, mode=MountMode.WRITE, policies=[DenyUnlinkAfter()]
    )
    io = await ws.shell("mkdir -p /a/d/sec && printf 'k\\n' > /a/d/sec/k")
    assert io.exit_code == 0, io.stderr
    sess = ws.create_session("rev", profile={"paths": {"hide": ["/a/d/sec"]}})
    token = set_current_session(sess)
    try:
        await ws.vfs.rmdir("/a/d")
    finally:
        reset_current_session(token)
    gone = await ws.shell("test -e /a/d")
    assert gone.exit_code == 1


@pytest.mark.asyncio
async def test_ops_rmdir_takes_hidden_namespace_links_with_it():
    # A hidden link is invisible to every backend, so the cascade walk
    # cannot take it; left in the node table it synthesizes /a/d right
    # back once the hide lifts, resurfacing the removed tree.
    ws = Workspace({"/a": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell(
        "mkdir -p /a/d/sec && printf 'k\\n' > /a/d/sec/k"
        " && ln -s /a/t /a/d/lnk"
    )
    assert io.exit_code == 0, io.stderr
    sess = ws.create_session(
        "rev", profile={"paths": {"hide": ["/a/d/sec", "/a/d/lnk"]}}
    )
    token = set_current_session(sess)
    try:
        await ws.vfs.rmdir("/a/d")
    finally:
        reset_current_session(token)
    # No session, no hides: the tree must be gone, link included.
    linkless = await ws.shell("readlink /a/d/lnk")
    assert linkless.exit_code != 0
    gone = await ws.shell("test -e /a/d")
    assert gone.exit_code == 1


@pytest.mark.asyncio
async def test_a_visible_link_below_keeps_the_rmdir_refusal():
    # A visible link joins the merged emptiness judgment, so the
    # refusal stands and nothing (backend remnant or node table) is
    # destroyed.
    ws = Workspace({"/a": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell(
        "mkdir -p /a/d/sec && printf 'k\\n' > /a/d/sec/k"
        " && ln -s /a/t /a/d/lnk"
    )
    assert io.exit_code == 0, io.stderr
    sess = ws.create_session("rev", profile={"paths": {"hide": ["/a/d/sec"]}})
    token = set_current_session(sess)
    try:
        with pytest.raises(OSError) as exc:
            await ws.vfs.rmdir("/a/d")
    finally:
        reset_current_session(token)
    assert exc.value.errno in (errno.ENOTEMPTY, errno.EEXIST)
    kept = await ws.shell("cat /a/d/sec/k")
    assert (kept.stdout or b"") == b"k\n"
    link = await ws.shell("readlink /a/d/lnk")
    assert link.exit_code == 0


@pytest.mark.asyncio
async def test_a_non_oserror_cascade_failure_keeps_the_refusal(monkeypatch):
    # An API backend's failure is not always an errno (box raises its
    # own error type); a raw backend exception escaping the fold would
    # reveal exactly what the refusal exists to hide.
    ws = Workspace({"/a": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell("mkdir -p /a/d/sec && printf 'k\\n' > /a/d/sec/k")
    assert io.exit_code == 0, io.stderr
    sess = ws.create_session("rev", profile={"paths": {"hide": ["/a/d/sec"]}})
    real = MountEntry.call

    async def boom(self, op, virtual, **kwargs):
        if op == "unlink" and virtual == "/a/d/sec/k":
            raise RuntimeError("api exploded")
        return await real(self, op, virtual, **kwargs)

    monkeypatch.setattr(MountEntry, "call", boom)
    token = set_current_session(sess)
    try:
        with pytest.raises(OSError) as exc:
            await ws.vfs.rmdir("/a/d")
    finally:
        reset_current_session(token)
    assert exc.value.errno in (errno.ENOTEMPTY, errno.EEXIST)
    kept = await ws.shell("cat /a/d/sec/k")
    assert (kept.stdout or b"") == b"k\n"


@pytest.mark.asyncio
async def test_a_directory_rename_drops_the_listing_cached_below_it(tmp_path):
    # The old name kept answering from its cached children after the
    # move, so a later rename onto that name saw a directory that was no
    # longer there and landed the source inside it.
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "readme.md").write_text("notes\n", encoding="utf-8")
    with Workspace(
        {"/disk/": DiskVFS(root=str(tmp_path))}, mode=MountMode.WRITE
    ) as ws:
        listed = await ws.shell("ls /disk/docs")
        assert listed.stdout == b"readme.md\n"
        await ws.dispatch(
            "rename",
            PathSpec.from_str_path("/disk/docs"),
            dst=PathSpec.from_str_path("/disk/moved"),
        )
        gone = await ws.shell("test -d /disk/docs && echo stale || echo gone")
        assert gone.stdout == b"gone\n"
        assert (await ws.shell("ls /disk/docs")).exit_code != 0
        assert (await ws.shell("ls /disk/moved")).stdout == b"readme.md\n"


@pytest.mark.asyncio
async def test_a_rename_carries_the_node_at_the_source(tmp_path):
    # The subtree below the source was re-anchored and the source's own
    # node was not, so the mode a chmod recorded stayed at the emptied
    # name: the landing read as the unclamped file and whatever was
    # created at the old name next inherited the overlay.
    (tmp_path / "a.txt").write_text("one\n", encoding="utf-8")
    with Workspace(
        {"/disk/": DiskVFS(root=str(tmp_path))}, mode=MountMode.WRITE
    ) as ws:
        assert (await ws.shell("chmod 400 /disk/a.txt")).exit_code == 0
        assert ws.namespace.meta_for("/disk/a.txt").mode == 0o400
        await ws.dispatch(
            "rename",
            PathSpec.from_str_path("/disk/a.txt"),
            dst=PathSpec.from_str_path("/disk/b.txt"),
        )
        assert ws.namespace.meta_for("/disk/a.txt") is None
        assert ws.namespace.meta_for("/disk/b.txt").mode == 0o400


@pytest.mark.asyncio
async def test_a_rename_replaces_the_node_at_the_landing(tmp_path):
    # rename(2) replaces the destination, so the overlay it carried goes
    # with it rather than staying to shadow what just landed.
    (tmp_path / "a.txt").write_text("one\n", encoding="utf-8")
    (tmp_path / "b.txt").write_text("two\n", encoding="utf-8")
    with Workspace(
        {"/disk/": DiskVFS(root=str(tmp_path))}, mode=MountMode.WRITE
    ) as ws:
        assert (await ws.shell("chmod 400 /disk/b.txt")).exit_code == 0
        await ws.dispatch(
            "rename",
            PathSpec.from_str_path("/disk/a.txt"),
            dst=PathSpec.from_str_path("/disk/b.txt"),
        )
        assert ws.namespace.meta_for("/disk/b.txt") is None


@pytest.mark.asyncio
async def test_xattrs_are_stored_on_the_node_and_listed_sorted():
    with Workspace({"/r/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("echo x > /r/f")
        await ws.vfs.setxattr("/r/f", "user.b", b"two")
        await ws.vfs.setxattr("/r/f", "user.a", b"one")
        assert await ws.vfs.listxattr("/r/f") == ["user.a", "user.b"]
        assert await ws.vfs.getxattr("/r/f", "user.b") == b"two"
        await ws.vfs.removexattr("/r/f", "user.b")
        assert await ws.vfs.listxattr("/r/f") == ["user.a"]
        with pytest.raises(OSError) as missing:
            await ws.vfs.getxattr("/r/f", "user.b")
        assert missing.value.errno == posix_errno(FsCondition.NO_XATTR)


@pytest.mark.asyncio
async def test_xattr_flags_refuse_the_way_setxattr_2_does():
    with Workspace({"/r/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("echo x > /r/f")
        await ws.vfs.setxattr("/r/f", "user.a", b"one")
        with pytest.raises(FileExistsError):
            await ws.vfs.setxattr("/r/f", "user.a", b"two", create=True)
        with pytest.raises(OSError) as absent:
            await ws.vfs.setxattr("/r/f", "user.q", b"x", replace=True)
        assert absent.value.errno == posix_errno(FsCondition.NO_XATTR)
        await ws.vfs.setxattr("/r/f", "user.a", b"two", replace=True)
        assert await ws.vfs.getxattr("/r/f", "user.a") == b"two"


@pytest.mark.asyncio
async def test_a_backend_stat_extra_is_not_an_attribute():
    dispatcher, _ = _dispatcher(Policies())
    dispatcher._namespace.is_link = MagicMock(return_value=False)
    dispatcher._namespace.xattrs = MagicMock(return_value={"user.tag": b"t"})
    dispatcher._namespace.try_mount_for.return_value.call = AsyncMock(
        return_value=FileStat(
            name="d", type=FileType.DIRECTORY, extra={"file_id": "1AbC"}
        )
    )
    listed, _ = await dispatcher.dispatch("listxattr", _path("/data/d"))
    assert listed == ["user.tag"]


@pytest.mark.asyncio
async def test_setxattr_and_removexattr_classify_as_writes():
    policies = Policies()
    policies.add(DenyWrites())
    dispatcher, _ = _dispatcher(policies)
    for op in ("setxattr", "removexattr"):
        with pytest.raises(PolicyDenied):
            await dispatcher.dispatch(op, _path("/data/a.txt"), name="user.a")


@pytest.mark.asyncio
async def test_an_xattr_op_on_a_missing_path_is_enoent():
    with Workspace({"/r/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        with pytest.raises(FileNotFoundError):
            await ws.vfs.listxattr("/r/nope")
        with pytest.raises(FileNotFoundError):
            await ws.vfs.setxattr("/r/nope", "user.a", b"x")
        assert ws.namespace.meta_for("/r/nope") is None


@pytest.mark.asyncio
async def test_a_removed_file_takes_its_xattrs_with_it():
    # Removed through the dispatcher rather than the shell's rm, the node
    # stayed, and a file created at the name next read back the old
    # file's attributes.
    with Workspace({"/r/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("echo x > /r/f")
        await ws.vfs.setxattr("/r/f", "user.a", b"one")
        await ws.vfs.unlink("/r/f")
        await ws.shell("echo y > /r/f")
        assert await ws.vfs.listxattr("/r/f") == []


@pytest.mark.asyncio
async def test_a_rename_carries_xattrs():
    with Workspace({"/r/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("echo x > /r/f")
        await ws.vfs.setxattr("/r/f", "user.a", b"one")
        await ws.vfs.rename("/r/f", "/r/g")
        assert await ws.vfs.getxattr("/r/g", "user.a") == b"one"
        assert ws.namespace.meta_for("/r/f") is None


@pytest.mark.asyncio
async def test_nofollow_reads_the_links_own_xattrs():
    with Workspace({"/r/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("echo x > /r/f && ln -s f /r/lk")
        await ws.vfs.setxattr("/r/lk", "user.target", b"t")
        await ws.vfs.setxattr("/r/lk", "user.own", b"o", nofollow=True)
        assert await ws.vfs.listxattr("/r/lk") == ["user.target"]
        assert await ws.vfs.listxattr("/r/lk", nofollow=True) == ["user.own"]
        assert ws.namespace.readlink("/r/lk") == "f"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command, diagnostic",
    [
        ("echo x >> /ro/file", "/ro/file: Read-only file system\n"),
        ("exec >> /ro/file", "/ro/file: Read-only file system\n"),
        (
            "ln -s file /ro/link",
            "ln: failed to create symbolic link '/ro/link': Read-only file system\n",
        ),
        (
            "chmod 600 /ro/file",
            "chmod: changing permissions of '/ro/file': Read-only file system\n",
        ),
        (
            "find /ro/file -delete",
            "find: cannot delete '/ro/file': Read-only file system\n",
        ),
        (
            "rm /ro/file",
            "rm: cannot remove '/ro/file': Read-only file system\n",
        ),
        (
            "mv /ro/file /ro/moved",
            "mv: cannot move '/ro/file' to '/ro/moved': Read-only file system\n",
        ),
        (
            "touch /ro/file",
            "touch: cannot touch '/ro/file': Read-only file system\n",
        ),
        (
            "truncate -s 0 /ro/file",
            "truncate: cannot open '/ro/file' for writing: Read-only file system\n",
        ),
    ],
)
async def test_shell_mutations_share_read_only_admission(command, diagnostic):
    with Workspace({"/ro": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.dispatch(
            "write", PathSpec.from_str_path("/ro/file"), data=b"original"
        )
        mount = ws.namespace.mount_for("/ro/file")
        mount.mode = MountMode.READ
        execute = mount.call

        async def no_content_read(op, *args, **kwargs):
            assert op not in {"read", "read_bytes"}, (
                "refused write fetched content"
            )
            return await execute(op, *args, **kwargs)

        mount.call = no_content_read
        result = await ws.shell(command)
        assert result.exit_code == 1
        assert await result.stderr_str() == diagnostic
        assert not ws.namespace.is_link("/ro/link")
        mount.call = execute
        body, _ = await ws.dispatch("read", PathSpec.from_str_path("/ro/file"))
        assert body == b"original"


@pytest.mark.asyncio
@pytest.mark.parametrize("hidden", [False, True])
async def test_rmdir_accounts_for_a_directory_containing_only_a_link(hidden):
    with Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("mkdir /data/d; ln -s nowhere /data/d/link")
        session = ws.create_session(
            "remover",
            profile={
                "paths": {"hide": ["/data/d/link"] if hidden else []},
            },
        )
        token = set_current_session(session)
        try:
            if hidden:
                await ws.vfs.rmdir("/data/d")
            else:
                with pytest.raises(OSError) as exc:
                    await ws.vfs.rmdir("/data/d")
                assert exc.value.errno == errno.ENOTEMPTY
        finally:
            reset_current_session(token)
        assert ws.namespace.is_link("/data/d/link") is not hidden


@pytest.mark.asyncio
async def test_rmdir_keeps_a_link_created_while_the_backend_removes():
    with Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("mkdir /data/d; ln -s nowhere /data/d/old")
        mount = ws.namespace.mount_for("/data/d")
        execute = mount.call

        async def link_arrives(op, *args, **kwargs):
            if op == "rmdir":
                await ws.dispatch(
                    "symlink",
                    PathSpec.from_str_path("/data/d/late"),
                    target="nowhere",
                )
            return await execute(op, *args, **kwargs)

        mount.call = link_arrives
        session = ws.create_session(
            "remover", profile={"paths": {"hide": ["/data/d/old"]}}
        )
        token = set_current_session(session)
        try:
            await ws.vfs.rmdir("/data/d")
        finally:
            reset_current_session(token)
        assert not ws.namespace.is_link("/data/d/old")
        assert ws.namespace.readlink("/data/d/late") == "nowhere"


class _CachingRAM(RAMVFS):
    caches_reads = True


def _counted_workspace(
    race: bool = False, filetype: str | None = None
) -> tuple[Workspace, list[str]]:
    """A caching mount whose reads answer ``BODY``, one tally per fetch.

    The counted read replaces the mount's plain read, or with
    ``filetype`` renders only that extension; with ``race`` the first
    fetch is overtaken by a write.

    Args:
        race (bool): overtake the first fetch with a write.
        filetype (str | None): the extension the counted read renders.
    """
    fetched: list[str] = []
    ws = Workspace({"/data/": _CachingRAM()}, mode=MountMode.WRITE)

    async def counted(accessor, path: PathSpec, **kwargs) -> bytes:
        fetched.append(path.virtual)
        if race and len(fetched) == 1:
            await ws.vfs.write("/data/f.count", b"NEWER")
        return slice_window(
            b"BODY", kwargs.get("offset", 0), kwargs.get("size")
        )

    vfs = ws.mount("/data/").vfs
    if filetype is None:
        vfs.reads_ranges = False
        override(vfs, "read", counted)
    else:
        render(vfs, filetype, counted)
    return ws, fetched


@pytest.mark.asyncio
async def test_ranges_of_an_unranged_read_come_from_one_kept_read():
    # A read op with no remote range would fetch the whole file and
    # slice it for every range, so the first range keeps the file and
    # the rest, and the whole read, are served from it.
    ws, fetched = _counted_workspace()
    await ws.vfs.write("/data/f.count", b"STORED")
    await ws.cache.remove("/data/f.count")
    assert await ws.vfs.read("/data/f.count", 0, 2) == b"BO"
    assert await ws.vfs.read("/data/f.count", 2, 2) == b"DY"
    assert await ws.vfs.read("/data/f.count", 0, 0) == b""
    assert await ws.vfs.read("/data/f.count") == b"BODY"
    assert fetched == ["/data/f.count"]


@pytest.mark.asyncio
async def test_a_raw_read_keeps_what_a_command_reads():
    # The stored bytes are what the cache holds under the path, so the
    # cat after a raw read is served warm.
    ws, fetched = _counted_workspace(filetype=".count")
    await ws.vfs.write("/data/f.count", b"STORED")
    assert await ws.vfs.read("/data/f.count", raw=True) == b"STORED"
    assert await ws.cache.get("/data/f.count") == b"STORED"
    out = await ws.shell("cat /data/f.count")
    assert await out.stdout_str() == "STORED"
    assert fetched == []


@pytest.mark.asyncio
async def test_a_direct_read_neither_serves_nor_keeps_the_cache():
    # A follow's poll asks for what the backend holds now: the warm copy
    # is not served, and the read leaves the cache as it found it.
    ws, fetched = _counted_workspace()
    path = PathSpec.from_str_path("/data/f.count")
    await ws.cache.set("/data/f.count", b"WARM")
    whole, _ = await ws.dispatch("read", path, direct=True)
    window, _ = await ws.dispatch("read", path, offset=1, size=2, direct=True)
    assert (whole, window) == (b"BODY", b"OD")
    assert fetched == ["/data/f.count", "/data/f.count"]
    assert await ws.cache.get("/data/f.count") == b"WARM"
    await ws.cache.remove("/data/f.count")
    await ws.dispatch("read", path, direct=True)
    assert not await ws.cache.exists("/data/f.count")


@pytest.mark.asyncio
async def test_a_natively_ranged_read_keeps_nothing():
    # A store that serves a range itself moved only that range.
    ws, _ = _counted_workspace(filetype=".count")
    await ws.vfs.write("/data/f.txt", b"0123456789")
    await ws.cache.remove("/data/f.txt")
    assert await ws.vfs.read("/data/f.txt", 2, 3) == b"234"
    assert not await ws.cache.exists("/data/f.txt")


@pytest.mark.asyncio
async def test_a_write_racing_the_fetch_keeps_the_read_out_of_the_cache():
    # The write lands after the fetch began, so the bytes it read may be
    # older than the file; keeping them would serve the old file. The
    # write keeps its own bytes, which the next read is served.
    ws, fetched = _counted_workspace(race=True)
    await ws.vfs.write("/data/f.count", b"STORED")
    await ws.cache.remove("/data/f.count")
    await ws.vfs.read("/data/f.count")
    assert await ws.vfs.read("/data/f.count") == b"NEWER"
    assert len(fetched) == 1


@pytest.mark.asyncio
async def test_a_render_is_neither_kept_nor_served_to_a_command():
    # The file cache holds what commands read under the path alone, so a
    # kept render would be what cat prints, and a kept cat what the
    # renderer read returns.
    ws, fetched = _counted_workspace(filetype=".count")
    await ws.vfs.write("/data/f.count", b"STORED")
    await ws.cache.remove("/data/f.count")
    assert await ws.vfs.read("/data/f.count") == b"BODY"
    assert not await ws.cache.exists("/data/f.count")
    out = await ws.shell("cat /data/f.count")
    assert await out.stdout_str() == "STORED"
    assert await ws.vfs.read("/data/f.count", 0, 2) == b"BO"
    assert await ws.vfs.read("/data/f.count") == b"BODY"
    assert fetched == ["/data/f.count"] * 3


@pytest.mark.asyncio
async def test_a_ranged_render_reaches_the_renderer_as_its_range():
    # A render is never kept, so filling the whole file for a range would
    # only render more than the read asked for.
    ws, _ = _counted_workspace()
    windows: list[tuple[int | None, int | None]] = []

    async def windowed(accessor, path: PathSpec, **kwargs) -> bytes:
        windows.append((kwargs.get("offset"), kwargs.get("size")))
        return b"RE"

    render(ws.mount("/data/").vfs, ".count", windowed)
    await ws.vfs.write("/data/f.count", b"STORED")
    assert await ws.vfs.read("/data/f.count", 0, 2) == b"RE"
    assert windows == [(0, 2)]


async def _render_count(accessor, path: PathSpec, **kwargs) -> bytes:
    return b"RENDER"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "window, rendered",
    [((), b"RENDER"), ((0, 2), b"RE")],
    ids=["whole", "ranged"],
)
async def test_a_renderer_registered_after_the_probe_is_not_kept(
    window, rendered
):
    # The fill is chosen after the probe, but the op is resolved only
    # once the mount is ready; a renderer landing in between runs, and
    # its rendering must not become what cat reads. A ranged read on a
    # store with no native range fills the whole file too.
    ws, _ = _counted_workspace()
    await ws.vfs.write("/data/f.count", b"STORED")
    await ws.cache.remove("/data/f.count")
    mount = ws.mount("/data/")
    probe, ready = ws.cache.get, mount.ensure_ready
    probed = False

    async def probe_once(path, *args, **kwargs):
        nonlocal probed
        probed = True
        return await probe(path, *args, **kwargs)

    async def register_after_probe():
        if probed and not mount.renders(".count"):
            render(mount.vfs, ".count", _render_count)
        await ready()

    ws.cache.get = probe_once
    mount.ensure_ready = register_after_probe
    assert await ws.vfs.read("/data/f.count", *window) == rendered
    assert not await ws.cache.exists("/data/f.count")
    out = await ws.shell("cat /data/f.count")
    assert await out.stdout_str() == "STORED"


class _RefusingGate:
    """An EntryGate that refuses one path and remembers what it was asked."""

    scoped = True
    granted = ()

    def __init__(self, refused: str) -> None:
        self.refused = refused
        self.asked: list[str] = []

    def check(self, virtual: str) -> None:
        self.asked.append(virtual)
        if virtual == self.refused:
            raise PermissionError(errno.EACCES, "sealed", virtual)

    def refuses(self, virtual: str) -> bool:
        return virtual == self.refused


async def _linked_ws() -> Workspace:
    ws = Workspace(
        {"/data/": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE
    )
    await ws.shell(
        "mkdir -p /data/real && echo s > /data/real/secret && "
        "ln -s /data/real /data/alias && ln -s /data/real/secret /data/flink"
    )
    return ws


async def _text(ws: Workspace, virtual: str) -> bytes:
    data, _ = await ws.dispatch("read", _path(virtual))
    return data


@pytest.mark.asyncio
async def test_a_marked_op_is_judged_on_every_path_it_reaches():
    # Each spelling once, in the order the dispatcher meets it: as handed in,
    # walked, then followed. A refused op leaves the bytes alone; an
    # unmarked one is the dispatcher's alone.
    ws = await _linked_ws()
    await ws.shell(
        "echo new > /data/real/other && echo o > /data/other && "
        "ln -s /data/other /data/real/flink2"
    )
    try:
        gate = _RefusingGate("/data/real/secret")
        for op, virtual, kwargs in (
            ("unlink", "/data/alias/secret", {}),
            (
                "rename",
                "/data/real/other",
                {"dst": _path("/data/alias/secret")},
            ),
            ("read", "/data/flink", {}),
            (
                "write",
                "/data/alias/secret",
                {"data": b"x\n", "nofollow": True},
            ),
        ):
            with pytest.raises(PermissionError):
                await ws.dispatch(op, _path(virtual), rule_gate=gate, **kwargs)
        assert gate.asked == [
            "/data/alias/secret",
            "/data/real/secret",
            "/data/real/other",
            "/data/alias/secret",
            "/data/real/secret",
            "/data/flink",
            "/data/real/secret",
            "/data/alias/secret",
            "/data/real/secret",
        ]
        assert await _text(ws, "/data/real/secret") == b"s\n"
        assert await _text(ws, "/data/real/other") == b"new\n"
        walked = _RefusingGate("/data/real/flink2")
        with pytest.raises(PermissionError):
            await ws.dispatch(
                "read", _path("/data/alias/flink2"), rule_gate=walked
            )
        assert walked.asked == ["/data/alias/flink2", "/data/real/flink2"]
        await ws.dispatch("unlink", _path("/data/alias/secret"))
        with pytest.raises(FileNotFoundError):
            await _text(ws, "/data/real/secret")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_marked_unlink_of_a_link_is_judged_on_the_link_entry():
    # The link table answers unlink of a link: a rule on the link name
    # holds before that answer, and one on the referent is never asked.
    ws = await _linked_ws()
    try:
        with pytest.raises(PermissionError):
            await ws.dispatch(
                "unlink",
                _path("/data/flink"),
                rule_gate=_RefusingGate("/data/flink"),
            )
        referent = _RefusingGate("/data/real/secret")
        await ws.dispatch("unlink", _path("/data/flink"), rule_gate=referent)
        assert referent.asked == ["/data/flink"]
        assert await _text(ws, "/data/real/secret") == b"s\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_hidden_space_answers_a_marked_op_before_any_rule():
    # A write into hidden space, a link there, a hidden rename endpoint
    # and one behind a linked parent are missing, and the command's gate
    # is never asked.
    ws = await _linked_ws()
    await ws.shell(
        "mkdir -p /data/hid && echo h > /data/hid/h && "
        "ln -s /data/hid /data/halias && ln -s /data/hid/h /data/hlink"
    )
    token = set_current_session(
        SessionState(
            session_id="hider",
            visibility=Visibility(paths=HiddenPaths(paths=("/data/hid",))),
        )
    )
    try:
        gate = _RefusingGate("/data/real/secret")
        for op, virtual, kwargs in (
            ("write", "/data/hid/x", {"data": b"x\n"}),
            ("read", "/data/hlink", {}),
            ("rename", "/data/real/secret", {"dst": _path("/data/hid/x")}),
            ("rename", "/data/hid/h", {"dst": _path("/data/real/moved")}),
            ("rename", "/data/real/secret", {"dst": _path("/data/halias/x")}),
        ):
            with pytest.raises(FileNotFoundError):
                await ws.dispatch(op, _path(virtual), rule_gate=gate, **kwargs)
        assert gate.asked == []
    finally:
        reset_current_session(token)
        await ws.close()


@pytest.mark.asyncio
async def test_the_mark_never_reaches_the_op(monkeypatch):
    # The dispatcher lifts the mark at entry: the mount's op sees only its own
    # arguments, whatever the command's dispatcher carried.
    ws = await _linked_ws()
    seen: list[dict] = []
    real = MountEntry.call

    async def spy(self, op, *args, **kwargs):
        seen.append(dict(kwargs))
        return await real(self, op, *args, **kwargs)

    monkeypatch.setattr(MountEntry, "call", spy)
    try:
        gate = _RefusingGate("/nothing")
        await ws.dispatch("read", _path("/data/real/secret"), rule_gate=gate)
        assert seen and all("rule_gate" not in kw for kw in seen)
        assert gate.asked == ["/data/real/secret"]
    finally:
        await ws.close()


class _SplicingRAMVFS(RAMVFS):
    """A RAM mount that answers pwrite the way S3 and redis do: read the
    file, give the loop a turn, and write the whole file back."""

    async def pwrite(
        self,
        path: PathSpec,
        data: bytes,
        offset: int,
        index: IndexCacheStore = NULL_INDEX,
    ) -> None:
        whole = await self.read(path)
        await asyncio.sleep(0)
        await self.write(path, splice_window(whole, offset, data))


@pytest.mark.asyncio
async def test_offset_writes_to_one_path_all_land_on_a_splicing_store():
    # Four sessions' edits at once: each pwrite reads the file before any
    # writes it back, so without one writer at a time per path every
    # write puts back three bytes the others had just replaced.
    with Workspace({"/data/": _SplicingRAMVFS()}, mode=MountMode.WRITE) as ws:
        f = PathSpec.from_str_path("/data/f")
        await ws.dispatch("write", f, data=b"0123456789")
        await asyncio.gather(
            *(
                ws.dispatch("pwrite", f, data=letter, offset=offset)
                for letter, offset in (
                    (b"A", 0),
                    (b"B", 3),
                    (b"C", 6),
                    (b"D", 9),
                )
            )
        )
        got, _ = await ws.dispatch("read", f)
        assert bytes(got) == b"A12B45C78D"


@pytest.mark.asyncio
async def test_offset_writes_through_two_mounts_of_one_store_all_land():
    # One store mounted twice holds one file under two names: the writes
    # are one writer at a time by the store's own key, not by the name.
    store = _SplicingRAMVFS()
    with Workspace({"/a/": store, "/b/": store}, mode=MountMode.WRITE) as ws:
        await ws.dispatch(
            "write", PathSpec.from_str_path("/a/f"), data=b"0123456789"
        )
        await asyncio.gather(
            *(
                ws.dispatch(
                    "pwrite",
                    PathSpec.from_str_path(name),
                    data=letter,
                    offset=offset,
                )
                for name, letter, offset in (
                    ("/a/f", b"A", 0),
                    ("/b/f", b"B", 3),
                    ("/a/f", b"C", 6),
                    ("/b/f", b"D", 9),
                )
            )
        )
        got, _ = await ws.dispatch("read", PathSpec.from_str_path("/b/f"))
        assert bytes(got) == b"A12B45C78D"


class Tape(BaseVFS):
    """A cached store whose stream hands out 10-byte chunks, counting
    each one the backend delivered."""

    name = "tape"
    caches_reads = True

    def __init__(self, delay: float = 0.0) -> None:
        super().__init__()
        self.files = {"a.txt": b"0123456789" * 5}
        self.delay = delay
        self.pulled = 0
        self.reads = 0
        self.closed = False

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        return [f"/tape/{name}" for name in self.files]

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        key = path.vfs_path.strip("/")
        if not key:
            return FileStat(name="/", type=FileType.DIRECTORY)
        if key not in self.files:
            raise FileNotFoundError(path.virtual)
        return FileStat(
            name=key, type=FileType.FILE, size=len(self.files[key])
        )

    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        self.reads += 1
        return self.files[path.vfs_path.strip("/")]

    async def write(
        self, path: PathSpec, data: bytes, index: IndexCacheStore = NULL_INDEX
    ) -> None:
        self.files[path.vfs_path.strip("/")] = data

    async def read_stream(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> AsyncIterator[bytes]:
        key = path.vfs_path.strip("/")
        if key not in self.files:
            raise FileNotFoundError(path.virtual)
        data = self.files[key]
        try:
            for at in range(0, len(data), 10):
                await asyncio.sleep(self.delay)
                self.pulled += 1
                yield data[at : at + 10]
        finally:
            self.closed = True


class ReadsResults(Policy):
    async def post_vfs(self, ctx: VfsResultContext) -> Action | None:
        return None


TAPE = PathSpec.from_str_path("/tape/a.txt")


@pytest.mark.asyncio
async def test_a_streamed_read_arrives_as_pulled_and_fills_the_cache():
    tape = Tape()
    with Workspace({"/tape/": tape}, mode=MountMode.WRITE) as ws:
        report = OpReport()
        stream, _ = await ws.dispatch("read", TAPE, stream=True, report=report)
        assert tape.pulled == 1
        assert not report.completed
        chunks = [chunk async for chunk in stream]
        assert chunks == [b"0123456789"] * 5
        assert (report.completed, report.bytes) == (True, 50)
        warm, _ = await ws.dispatch("read", TAPE)
        assert warm == b"0123456789" * 5
        assert tape.reads == 0


@pytest.mark.asyncio
async def test_a_streamed_read_fails_at_the_call():
    with Workspace({"/tape/": Tape()}, mode=MountMode.WRITE) as ws:
        report = OpReport()
        with pytest.raises(FileNotFoundError):
            await ws.dispatch(
                "read",
                PathSpec.from_str_path("/tape/missing.txt"),
                stream=True,
                report=report,
            )
        assert not report.completed


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "policies,kwargs",
    [([], {"offset": 5}), ([], {"size": 4}), ([ReadsResults()], {})],
)
async def test_a_window_or_a_policy_that_reads_results_gets_whole_bytes(
    policies, kwargs
):
    tape = Tape()
    with Workspace(
        {"/tape/": tape}, mode=MountMode.WRITE, policies=policies
    ) as ws:
        got, _ = await ws.dispatch("read", TAPE, stream=True, **kwargs)
        assert isinstance(got, bytes)
        assert tape.pulled == 0


@pytest.mark.asyncio
async def test_each_pull_gets_the_whole_timeout():
    tape = Tape(delay=0.05)
    with Workspace({"/tape/": tape}, mode=MountMode.WRITE) as ws:
        ws.namespace.mount_for("/tape/a.txt").command_limits["read"] = Limit(
            timeout_seconds=0.2
        )
        stream, _ = await ws.dispatch("read", TAPE, stream=True)
        got = []
        async for chunk in stream:
            got.append(chunk)
            await asyncio.sleep(0.1)
        assert len(got) == 5
        tape.files["b.txt"] = tape.files["a.txt"]
        tape.delay = 0.5
        with pytest.raises(CommandTimeoutError):
            await ws.dispatch(
                "read",
                PathSpec.from_str_path("/tape/b.txt"),
                stream=True,
                filetype=None,
            )


@pytest.mark.asyncio
@pytest.mark.parametrize("on_exceed", [OnExceed.TRUNCATE, OnExceed.ERROR])
async def test_a_capped_stream_stops_at_the_cap(on_exceed):
    tape = Tape()
    with Workspace({"/tape/": tape}, mode=MountMode.WRITE) as ws:
        ws.namespace.mount_for("/tape/a.txt").command_limits["read"] = Limit(
            max_bytes=15, on_exceed=on_exceed
        )
        stream, _ = await ws.dispatch("read", TAPE, stream=True, filetype=None)
        got = b""
        if on_exceed is OnExceed.ERROR:
            with pytest.raises(LimitExceededError):
                async for chunk in stream:
                    got += chunk
        else:
            async for chunk in stream:
                got += chunk
        assert got == b"012345678901234"
        assert tape.pulled == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("cap", [None, Limit(max_bytes=15)])
async def test_a_stream_closed_before_its_first_pull_closes_and_keeps_nothing(
    cap,
):
    tape = Tape()
    with Workspace({"/tape/": tape}, mode=MountMode.WRITE) as ws:
        if cap is not None:
            ws.namespace.mount_for("/tape/a.txt").command_limits["read"] = cap
        stream, _ = await ws.dispatch("read", TAPE, stream=True)
        await stream.aclose()
        assert (tape.pulled, tape.closed) == (1, True)
        await ws.dispatch("read", TAPE)
        assert tape.reads == 1


@pytest.mark.asyncio
async def test_a_write_during_a_stream_keeps_none_of_it():
    tape = Tape()
    with Workspace({"/tape/": tape}, mode=MountMode.WRITE) as ws:
        stream, _ = await ws.dispatch("read", TAPE, stream=True)
        await ws.dispatch("write", TAPE, data=b"new")
        assert [chunk async for chunk in stream][0] == b"0123456789"
        got, _ = await ws.dispatch("read", TAPE)
        assert (got, tape.reads) == (b"new", 0)


@pytest.mark.asyncio
async def test_a_stream_past_the_drain_budget_keeps_nothing():
    tape = Tape()
    with Workspace({"/tape/": tape}, mode=MountMode.WRITE) as ws:
        manager = ws.namespace.mount_for("/tape/a.txt").cache_manager
        manager._file_cache.max_drain_bytes = 20
        stream, _ = await ws.dispatch("read", TAPE, stream=True)
        assert len(b"".join([chunk async for chunk in stream])) == 50
        await ws.dispatch("read", TAPE)
        assert tape.reads == 1


class SeenReads(Policy):
    def __init__(self) -> None:
        self.seen: list[tuple[str, str]] = []

    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        self.seen.append((ctx.op, ctx.path.virtual))
        return None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "cat /d/a.txt",
        "head -n 1 /d/a.txt",
        "tail -n 1 /d/a.txt",
        "wc -l /d/a.txt",
        "grep a /d/a.txt",
        "rg a /d/a.txt",
        "sort /d/a.txt",
        "md5sum /d/a.txt",
    ],
)
async def test_a_command_reads_at_the_dispatcher(line):
    seen = SeenReads()
    with Workspace(
        {"/d/": RAMVFS()}, mode=MountMode.WRITE, policies=[seen]
    ) as ws:
        await ws.vfs.write("/d/a.txt", b"a\nb\n")
        seen.seen.clear()
        out = await ws.shell(line)
        await out.stdout_str()
        assert out.exit_code == 0
        assert ("read", "/d/a.txt") in seen.seen
