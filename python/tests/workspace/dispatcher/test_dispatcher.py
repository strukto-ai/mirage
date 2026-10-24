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
import dataclasses
import errno
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.cache.index.scope import command_scope
from mirage.context import (
    Caller,
    current_caller,
    reset_current_session,
    set_current_session,
)
from mirage.core.time_range import followed_day
from mirage.errors import FsCondition, posix_errno
from mirage.errors.fs import erofs
from mirage.errors.types import (
    CommandTimeoutError,
    ReadOnlyError,
    WalkDeclinedError,
)
from mirage.io import OpReport
from mirage.io.stream import yield_bytes
from mirage.observe.context import RecordingScope, record, start_op
from mirage.policy import (
    Action,
    AdmissionRules,
    CommandRule,
    Deny,
    Policies,
    Policy,
    PolicyDenied,
    VfsContext,
    VfsResultContext,
)
from mirage.policy.builtin.permissions import PermissionsPolicy
from mirage.policy.types import EntryGate
from mirage.types import (
    DirListing,
    FileStat,
    FileType,
    HiddenPaths,
    Limit,
    MountMode,
    OnExceed,
    PathSpec,
    SearchQuery,
    Visibility,
)
from mirage.utils.key_prefix import mounted_path
from mirage.utils.ranges import slice_window, splice_window
from mirage.utils.stat_view import ident
from mirage.vfs.base import BaseVFS
from mirage.vfs.disk import DiskVFS
from mirage.vfs.ram import RAMVFS
from mirage.vfs.types import VfsCall
from mirage.workspace import Workspace
from mirage.workspace.dispatcher.constants import (
    POLICY_WRITE_OPS,
    READ_AHEAD_BYTES,
)
from mirage.workspace.dispatcher.dispatcher import Dispatcher, _MountChannel
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.session import SessionState
from tests.fixtures.vfs_io import BatchedRAM, dispatched, override, render


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
        if ctx.call.name == "unlink" and ctx.path.virtual == "/a/d/sec/k":
            return Deny("protected\n")
        return None


class DenyUnlinkAfter(Policy):
    async def post_vfs(self, ctx: VfsResultContext) -> Action | None:
        return Deny("too late") if ctx.call.name == "unlink" else None


class RefuseMkdirReadOnly(Policy):
    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        if ctx.call.name == "mkdir":
            return Deny("no dirs", error=erofs(ctx.path.virtual))
        return None


class SeenMkdirs(Policy):
    def __init__(self) -> None:
        self.done: list[str] = []

    async def post_vfs(self, ctx: VfsResultContext) -> Action | None:
        if ctx.call.name == "mkdir":
            self.done.append(ctx.path.virtual)
        return None


class _FailingRAM(RAMVFS):
    """A RAM VFS whose listing or deletion fails with an error of its own
    type once armed, as an API backend's can (box raises its own)."""

    failing: str | None = None

    async def readdir(self, path: PathSpec) -> list[str]:
        if self.failing == "readdir":
            raise RuntimeError("api exploded")
        return await super().readdir(path)

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
    mount.cache_manager = None
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
    # the policy would make the cache a policy bypass. The method fires
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


class _OneRule:
    """Every session's compiled profile: one deny rule."""

    def __init__(self, rule: CommandRule) -> None:
        self.rules = AdmissionRules(deny=(rule,))

    def commands_of(self, session_id: str) -> AdmissionRules:
        return self.rules


@pytest.mark.asyncio
async def test_a_profile_path_rule_holds_on_the_dispatcher():
    policies = Policies()
    frozen = CommandRule(reason="frozen", paths=("/data/locked/*",))
    policies.add(PermissionsPolicy(_OneRule(frozen)))
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
async def test_a_tree_copy_merges_beside_a_link_at_the_destination():
    # Only a rename asks for an empty destination: a copy merges into
    # the directory and the link already there stays.
    with Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("mkdir -p /ram/d /ram/e/d && echo hi > /ram/d/a.txt")
        await ws.shell("ln -s gone /ram/e/d/stale")
        assert (await ws.shell("cp -r /ram/d /ram/e")).exit_code == 0
        assert (await ws.shell("cat /ram/e/d/a.txt")).stdout == b"hi\n"
        assert ws._namespace.readlink("/ram/e/d/stale") == "gone"


class TreeCopyRAM(RAMVFS):
    """A RAM store that keeps its listings and copies a tree in one op,
    as OneDrive's server-side copy does."""

    index_ttl = 60
    local = False

    async def dir_copy(self, src: PathSpec, dst: PathSpec) -> None:
        store = self._store
        base = "/" + src.vfs_path.strip("/")
        landing = "/" + dst.vfs_path.strip("/")
        for name in list(store.dirs):
            if name.startswith(base + "/"):
                store.dirs.add(landing + name[len(base) :])
        for name, data in list(store.files.items()):
            if name.startswith(base + "/"):
                store.files[landing + name[len(base) :]] = data


@pytest.mark.asyncio
async def test_a_tree_copy_drops_the_listing_an_empty_directory_joins():
    # The copy wrote no file, so only the directory it made says which
    # listing changed.
    ws = Workspace({"/ram/": TreeCopyRAM()}, mode=MountMode.WRITE)
    try:
        await ws.shell("mkdir -p /ram/s/e /ram/d && echo x > /ram/d/x")
        assert (await ws.shell("ls /ram/d")).stdout == b"x\n"
        await ws.dispatch(
            "dir_copy",
            PathSpec.from_str_path("/ram/s"),
            dst=PathSpec.from_str_path("/ram/d"),
        )
        assert (await ws.shell("ls /ram/d")).stdout == b"e\nx\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_copy_writes_through_a_link_at_the_destination():
    # A copy writes its destination as a write does: the bytes land in
    # the link's target and the link stays.
    with Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("echo hi > /ram/a.txt")
        await ws.shell("echo tgt > /ram/t.txt")
        await ws.shell("ln -s t.txt /ram/link")
        await ws.dispatch(
            "copy",
            PathSpec.from_str_path("/ram/a.txt"),
            dst=PathSpec.from_str_path("/ram/link"),
        )
        assert ws._namespace.readlink("/ram/link") == "t.txt"
        assert (await ws.shell("cat /ram/t.txt")).stdout == b"hi\n"


@pytest.mark.asyncio
async def test_a_copy_onto_a_link_to_its_source_is_refused():
    # Followed, both ends name one file, and a backend that replaces
    # its destination would delete the source before copying it.
    with Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("echo hi > /ram/a.txt")
        await ws.shell("ln -s a.txt /ram/self")
        with pytest.raises(OSError) as caught:
            await ws.dispatch(
                "copy",
                PathSpec.from_str_path("/ram/a.txt"),
                dst=PathSpec.from_str_path("/ram/self"),
            )
        assert caught.value.errno == errno.EINVAL
        assert (await ws.shell("cat /ram/a.txt")).stdout == b"hi\n"


@pytest.mark.asyncio
async def test_a_tree_copy_over_a_link_below_its_destination_declines():
    # The backend writes each child name as it is, so the bytes would
    # land behind the link; the caller's walk copies through it instead.
    with Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("mkdir -p /ram/d /ram/e/d && echo new > /ram/d/x")
        await ws.shell("echo old > /ram/t && ln -s /ram/t /ram/e/d/x")
        with pytest.raises(WalkDeclinedError):
            await ws.dispatch(
                "dir_copy",
                PathSpec.from_str_path("/ram/d"),
                dst=PathSpec.from_str_path("/ram/e/d"),
            )
        assert (await ws.shell("cp -r /ram/d /ram/e")).exit_code == 0
        assert (await ws.shell("cat /ram/t")).stdout == b"new\n"


@pytest.mark.asyncio
async def test_a_tree_copy_writes_through_a_link_into_another_mount():
    # cp walks a destination holding a link, and the write follows it
    # across mounts where a backend copy would answer EXDEV.
    mounts = {"/ram/": RAMVFS(), "/scratch/": RAMVFS()}
    with Workspace(mounts, mode=MountMode.WRITE) as ws:
        await ws.shell("mkdir -p /ram/d /ram/e/d && echo new > /ram/d/a.txt")
        await ws.shell("echo old > /scratch/a.txt")
        await ws.shell("ln -s /scratch/a.txt /ram/e/d/a.txt")
        assert (await ws.shell("cp -r /ram/d /ram/e")).exit_code == 0
        assert (await ws.shell("cat /scratch/a.txt")).stdout == b"new\n"
        assert ws._namespace.readlink("/ram/e/d/a.txt") == "/scratch/a.txt"


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
    # A copy reads its path and writes its destination.
    dst = {"dst": PathSpec.from_str_path("/ro/copy")} if "copy" in op else {}
    with Workspace({"/ro": (RAMVFS(), MountMode.READ)}) as ws:
        mount = ws.namespace.mount_for("/ro/file")
        mount.ensure_ready = AsyncMock(
            side_effect=AssertionError("backend reached")
        )
        with pytest.raises(ReadOnlyError) as exc:
            await ws.dispatch(op, PathSpec.from_str_path("/ro/file"), **dst)
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
async def test_a_policy_refusal_stands_on_a_read_only_mkdir():
    # The lookup answers for the mount's mode, never for a policy: a
    # policy's own read-only refusal stands where the directory exists.
    ram = RAMVFS()
    ram._store.dirs.add("/d")
    with Workspace(
        {"/ro": (ram, MountMode.READ)}, policies=[RefuseMkdirReadOnly()]
    ) as ws:
        with pytest.raises(OSError) as exc:
            await ws.dispatch(
                "mkdir", PathSpec.from_str_path("/ro/d"), parents=True
            )
    assert exc.value.errno == errno.EROFS


@pytest.mark.asyncio
async def test_a_read_only_mkdir_the_lookup_answers_completes():
    # `mkdir -p` of a directory already there succeeds, through post_vfs
    # like any op that succeeds.
    seen = SeenMkdirs()
    ram = RAMVFS()
    ram._store.dirs.add("/d")
    with Workspace({"/ro": (ram, MountMode.READ)}, policies=[seen]) as ws:
        await ws.dispatch(
            "mkdir", PathSpec.from_str_path("/ro/d"), parents=True
        )
    assert seen.done == ["/ro/d"]


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

    async def admit(
        call: VfsCall, spec: PathSpec, write: bool, **kwargs
    ) -> None:
        admitted.append((call.name, spec.virtual))

    async def invalidate(spec: PathSpec) -> None:
        seen.append(spec.virtual)

    boundary = MagicMock()
    boundary.admit = admit
    boundary.complete = AsyncMock()
    channel = _MountChannel(mount, boundary, invalidate, None)
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
    real = Dispatcher._changed

    async def spy(self, mount, path, kind, *args, **kwargs):
        recorded.append(path.virtual)
        await real(self, mount, path, kind, *args, **kwargs)

    monkeypatch.setattr(Dispatcher, "_changed", spy)
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
async def test_a_link_into_hidden_space_is_hidden_with_its_target():
    profiles = {"bob": {"paths": {"hide": ["/data/secret"]}}}
    with Workspace(
        {"/data": RAMVFS()}, mode=MountMode.WRITE, profiles=profiles
    ) as ws:
        await ws.shell(
            "mkdir -p /data/secret /data/pub /data/shared; "
            "echo s > /data/secret/f; echo p > /data/pub/n.txt; "
            "ln -s /data/secret/f /data/shared/to_secret; "
            "ln -s ../secret /data/shared/dirlink; "
            "ln -s /data/pub/n.txt /data/shared/to_pub"
        )
        ws.create_session("bob", profile="bob")
        gone = "No such file or directory"
        for line, out, err, code in (
            ("ls /data/shared", "to_pub\n", "", 0),
            ("readlink /data/shared/to_secret", "", "", 1),
            (
                "stat -c %N /data/shared/to_secret",
                "",
                f"stat: cannot statx '/data/shared/to_secret': {gone}\n",
                1,
            ),
            (
                "ls /data/shared/dirlink",
                "",
                f"ls: cannot access '/data/shared/dirlink': {gone}\n",
                2,
            ),
            (
                "find /data/shared",
                "/data/shared\n/data/shared/to_pub\n",
                "",
                0,
            ),
            (
                "rm /data/shared/to_secret",
                "",
                f"rm: cannot remove '/data/shared/to_secret': {gone}\n",
                1,
            ),
        ):
            result = await ws.shell(line, session_id="bob")
            got = (
                await result.stdout_str(),
                await result.stderr_str(),
                result.exit_code,
            )
            assert got == (out, err, code), line
        bob = await ws.session("bob-files", profile="bob")
        for call in (bob.vfs.read, bob.vfs.readlink):
            with pytest.raises(FileNotFoundError) as exc:
                await call("/data/shared/to_secret")
            assert exc.value.filename == "/data/shared/to_secret"
        shown = await ws.shell("readlink /data/shared/to_secret")
        assert await shown.stdout_str() == "/data/secret/f\n"


@pytest.mark.asyncio
async def test_rmdir_takes_a_link_into_hidden_space_with_the_directory():
    with Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell(
            "mkdir -p /data/secret /data/d; echo s > /data/secret/f; "
            "ln -s /data/secret/f /data/d/l"
        )
        session = ws.create_session(
            "remover", profile={"paths": {"hide": ["/data/secret"]}}
        )
        token = set_current_session(session)
        try:
            await ws.vfs.rmdir("/data/d")
        finally:
            reset_current_session(token)
        assert not ws.namespace.is_link("/data/d/l")
        listed = await ws.shell("ls /data")
        assert await listed.stdout_str() == "secret\n"


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


class _UnsizedRAM(_CachingRAM):
    async def stat(self, path):
        row = await super().stat(path)
        return row.model_copy(update={"size": None})


@pytest.mark.asyncio
async def test_a_stat_with_no_size_takes_the_cached_length():
    # An API mount cannot size a file without fetching it; once a read
    # kept its bytes, every caller of the dispatcher sees their length.
    vfs = _UnsizedRAM()
    vfs._store.dirs.add("/")
    vfs._store.files["/f"] = b"hello\n"
    ws = Workspace({"/api": vfs}, mode=MountMode.WRITE)
    try:
        assert (await ws.vfs.stat("/api/f")).size is None
        await ws.vfs.read("/api/f")
        assert (await ws.vfs.stat("/api/f")).size == len(b"hello\n")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_directory_stat_does_not_probe_cached_bytes():
    vfs = _UnsizedRAM()
    vfs._store.dirs.update({"/", "/d"})
    ws = Workspace({"/api": vfs})
    try:
        await ws.cache.set("/api/d", b"not a file")
        get = AsyncMock(wraps=ws.cache.get)
        ws.cache.get = get
        row = await ws.vfs.stat("/api/d")
        assert (row.type, row.size) == (FileType.DIRECTORY, None)
        assert get.call_args_list == []
    finally:
        await ws.close()


class _DirVoiceRAM(RAMVFS):
    """A RAM store that answers a read of a path in ``voiced`` in another
    store's voice: an error of its own, or no bytes."""

    def __init__(self, voice: Any, voiced: set[str]) -> None:
        super().__init__()
        self.voice = voice
        self.voiced = voiced

    def _answer(self, path: PathSpec) -> bytes:
        if not callable(self.voice):
            return self.voice
        raise self.voice(path.virtual)

    async def read(
        self, path: PathSpec, offset: int = 0, size: int | None = None
    ) -> bytes:
        if path.mount_path in self.voiced:
            return self._answer(path)
        return await super().read(path, offset, size)


def _host_named(at: str) -> OSError:
    return IsADirectoryError(21, "Is a directory", "/host" + at)


async def _drained(stream: AsyncIterator[bytes]) -> bytes:
    return b"".join([chunk async for chunk in stream])


_WS_READS = {
    "bytes": lambda ws, path: ws.vfs.read(path),
    "range": lambda ws, path: ws.vfs.read(path, offset=0, size=4),
    "stream": lambda ws, path: _drained_stream(ws, path),
}


async def _drained_stream(ws: Workspace, path: str) -> bytes:
    return await _drained(await ws.vfs.read(path, stream=True))


@pytest.mark.asyncio
@pytest.mark.parametrize("read", sorted(_WS_READS))
@pytest.mark.parametrize(
    "voice,dirs,files,path,error",
    [
        (None, set(), {"/sub/x": b"x"}, "/m/sub", IsADirectoryError),
        (RuntimeError, {"/d"}, {}, "/m/d", IsADirectoryError),
        (_host_named, {"/d"}, {}, "/m/d", IsADirectoryError),
        (b"", {"/d"}, {}, "/m/d", IsADirectoryError),
        (PermissionError, set(), {"/f": b"x"}, "/m/f", PermissionError),
    ],
    ids="implicit opaque host empty other".split(),
)
async def test_a_read_of_a_directory_is_refused_for_every_caller(
    voice, dirs, files, path, error, read
):
    # A store answers a read of a directory in its own voice (a keyed
    # store's ENOENT, sftp's opaque error, no bytes); ws.vfs gets GNU's
    # EISDIR at the path it named, as a command does, and any other
    # failure as it was.
    vfs = _DirVoiceRAM(voice, {*dirs, "/f"} if voice else set())
    vfs._store.dirs.update({"/", *dirs})
    vfs._store.files.update(files)
    ws = Workspace({"/m": vfs})
    try:
        with pytest.raises(error) as raised:
            await _WS_READS[read](ws, path)
        assert path in str(raised.value)
        assert "/host" not in str(raised.value)
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("read", sorted(_WS_READS))
async def test_a_read_through_a_link_takes_its_targets_kind(read):
    # GNU's cat calls a link to a directory a directory, at the name it
    # was given; a link that leads nowhere stays absent, though its
    # parent lists its name.
    vfs = RAMVFS()
    vfs._store.dirs.add("/")
    vfs._store.files["/sub/x"] = b"x"
    ws = Workspace({"/m": vfs}, mode=MountMode.WRITE)
    try:
        await ws.shell("ln -s /m/sub /m/alias; ln -s /m/nope /m/gone")
        with pytest.raises(IsADirectoryError) as raised:
            await _WS_READS[read](ws, "/m/alias")
        assert "/m/alias" in str(raised.value)
        with pytest.raises(FileNotFoundError):
            await _WS_READS[read](ws, "/m/gone")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_hidden_link_to_a_directory_stays_missing():
    # The probe walks no further than the caller sees: a hidden link to
    # a visible directory answers as a missing name, never as the
    # directory its target is.
    vfs = RAMVFS()
    vfs._store.dirs.add("/")
    vfs._store.files["/sub/x"] = b"x"
    ws = Workspace({"/m": vfs}, mode=MountMode.WRITE)
    try:
        await ws.shell("ln -s /m/sub /m/alias")
        ws.create_session("agent", profile={"paths": {"hide": ["/m/alias"]}})
        with pytest.raises(FileNotFoundError):
            await ws.vfs.read("/m/alias", session_id="agent")
        with pytest.raises(FileNotFoundError):
            await _drained(
                await ws.vfs.read("/m/alias", session_id="agent", stream=True)
            )
        io = await ws.shell("cat /m/alias", session_id="agent")
        assert io.stderr == b"cat: /m/alias: No such file or directory\n"
        with pytest.raises(IsADirectoryError):
            await ws.vfs.read("/m/alias")
    finally:
        await ws.close()


class _UpstreamFailingRAM(_DirVoiceRAM):
    """A store whose backend fails for a path in ``voiced``, on a stat as
    on a read."""

    async def stat(self, path: PathSpec) -> FileStat:
        if path.mount_path in self.voiced:
            self._answer(path)
        return await super().stat(path)


def _upstream(at: str) -> OSError:
    return OSError(errno.EIO, "upstream 502 Bad Gateway", at)


@pytest.mark.asyncio
@pytest.mark.parametrize("read", sorted(_WS_READS))
async def test_a_file_whose_backend_fails_keeps_its_error(read):
    # The directory probe's stat fails too, which proves nothing; the
    # parent's listing names the file, so reading past that stat called
    # it a directory.
    vfs = _UpstreamFailingRAM(_upstream, {"/f"})
    vfs._store.dirs.add("/")
    vfs._store.files["/f"] = b"x"
    ws = Workspace({"/m": vfs})
    try:
        with pytest.raises(OSError) as raised:
            await _WS_READS[read](ws, "/m/f")
        assert raised.value.errno == errno.EIO
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("read", sorted(_WS_READS))
async def test_a_read_of_a_file_empty_or_not_is_answered(read):
    vfs = RAMVFS()
    vfs._store.dirs.add("/")
    vfs._store.files.update({"/f": b"data", "/empty": b""})
    ws = Workspace({"/m": vfs})
    try:
        assert await _WS_READS[read](ws, "/m/f") == b"data"
        assert await _WS_READS[read](ws, "/m/empty") == b""
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("path", "error"),
    [
        ("/m/missing/", IsADirectoryError),
        ("/m/d/f/", IsADirectoryError),
        ("/m/d/", IsADirectoryError),
        ("/m/d/./", IsADirectoryError),
        ("/m/d/f/./", NotADirectoryError),
        ("/m/missing/./", FileNotFoundError),
    ],
)
async def test_a_write_to_a_slash_terminated_name_is_refused_for_every_caller(
    path, error
):
    # `x/` names a directory, so ws.vfs refuses to create a file there
    # before anything is looked up, as the shell's tee and truncate do.
    # Behind a dot the walk through it answers first, as GNU's does.
    vfs = RAMVFS()
    vfs._store.dirs.update({"/", "/d"})
    vfs._store.files["/d/f"] = b"x"
    ws = Workspace({"/m": vfs}, mode=MountMode.WRITE)
    try:
        for write in (
            lambda: ws.vfs.write(path, b"y"),
            lambda: ws.vfs.append(path, b"y"),
            lambda: ws.vfs.pwrite(path, b"y", 0),
            lambda: ws.vfs.truncate(path, 0),
        ):
            with pytest.raises(error):
                await write()
        assert vfs._store.files == {"/d/f": b"x"}
    finally:
        await ws.close()


class _StandInRAM(RAMVFS):
    """A caching RAM mount that answers the read stand-ins itself."""

    caches_reads = True

    def __init__(self) -> None:
        super().__init__()
        self.asked: list[str] = []

    async def first_lines(
        self, path: PathSpec, n: int, index: IndexCacheStore = NULL_INDEX
    ) -> bytes | None:
        self.asked.append("first_lines")
        return b"stand-in\n"

    async def line_count(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> int | None:
        self.asked.append("line_count")
        return 7


@pytest.mark.asyncio
async def test_a_stand_in_gives_way_to_the_read_for_a_cached_file():
    # A call standing in for a read answers None for a file the read
    # cache holds, so ws.vfs reads it and is served the cached copy.
    vfs = _StandInRAM()
    vfs._store.dirs.add("/")
    vfs._store.files.update({"/cold": b"a\n", "/warm": b"b\n"})
    ws = Workspace({"/m": vfs})
    try:
        await ws.vfs.read("/m/warm")
        for name, kwargs in (("first_lines", {"n": 1}), ("line_count", {})):
            cold, _ = await ws.vfs.dispatch(
                name, PathSpec.from_str_path("/m/cold"), **kwargs
            )
            warm, _ = await ws.vfs.dispatch(
                name, PathSpec.from_str_path("/m/warm"), **kwargs
            )
            assert cold is not None and warm is None
        assert vfs.asked == ["first_lines", "line_count"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_warm_read_answers_whether_a_copy_is_held():
    # Presence only: a held copy is never fetched to answer, since every
    # caller then reads the file anyway (wc -c, grep's narrowing).
    vfs = _StandInRAM()
    vfs._store.dirs.add("/")
    vfs._store.files.update({"/cold": b"a\n", "/warm": b"b\n"})
    ws = Workspace({"/m": vfs})
    try:
        await ws.vfs.read("/m/warm")
        vfs._store.files["/warm"] = b"changed\n"
        reads = AsyncMock(wraps=vfs.read)
        vfs.read = reads
        fetched = AsyncMock(wraps=ws.cache.get)
        ws.cache.get = fetched
        cold, _ = await ws.vfs.dispatch(
            "read", PathSpec.from_str_path("/m/cold"), warm=True
        )
        warm, _ = await ws.vfs.dispatch(
            "read", PathSpec.from_str_path("/m/warm"), warm=True
        )
        assert (cold, warm) == (None, True)
        assert reads.call_args_list == []
        assert fetched.call_args_list == []
    finally:
        await ws.close()


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


class _FollowedRAM(RAMVFS):
    def __init__(self, after) -> None:
        super().__init__()
        self._after = after

    async def follow(self, path, n, interval, index=NULL_INDEX):
        return followed_day([{"ts": "1"}], 1, 0, 0.001, self._after)


async def _nothing_after(last):
    return []


async def _stalled_after(last):
    await asyncio.Event().wait()
    return []


@pytest.mark.parametrize(
    "after", [_nothing_after, _stalled_after], ids=["idle", "stalled"]
)
@pytest.mark.asyncio
async def test_a_waiting_follow_closes_through_the_mount(after):
    # A follow past its day waits to be closed, idle or on an ask the
    # backend never answers; the pull that waits on it is cancelled and the
    # close reaches it through the mount's wrappers, or the follow holds the
    # mount forever.
    vfs = _FollowedRAM(after)
    vfs._store.dirs.add("/")
    vfs._store.files["/day"] = b'{"ts":"1"}\n'
    ws = Workspace({"/m": vfs}, mode=MountMode.WRITE)
    try:
        stream, _ = await ws.dispatch(
            "follow", PathSpec.from_str_path("/m/day"), n=1, interval=0.001
        )
        assert await anext(stream) == b'{"ts":"1"}\n'
        idle = asyncio.ensure_future(anext(stream))
        await asyncio.sleep(0.05)
        idle.cancel()
        with pytest.raises(asyncio.CancelledError):
            await idle
        await asyncio.wait_for(stream.aclose(), 0.5)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_fresh_stat_asks_past_a_stale_listing():
    # The index holds a listing up to its TTL old: `wc -c` and `cmp -s`
    # take the size from a stat that asks the backend now.
    vfs = RAMVFS()
    vfs._store.dirs.add("/")
    vfs._store.files["/f"] = b"grown\n"
    ws = Workspace({"/m": vfs}, mode=MountMode.WRITE)
    try:
        await ws.mount("/m").index.set_dir(
            "/m",
            [("f", FileStat(name="f", type=FileType.FILE, size=3))],
            datetime.now(timezone.utc) + timedelta(hours=1),
        )
        path = PathSpec.from_str_path("/m/f")
        listed, _ = await ws.dispatch("stat", path)
        now, _ = await ws.dispatch("stat", path, fresh=True)
        assert (listed.size, now.size) == (3, 6)
        out = await ws.shell("wc -c /m/f")
        assert await out.stdout_str() == "6 /m/f\n"
    finally:
        await ws.close()


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
    # its rendering must not become what cat reads, which is the counted
    # read's stored bytes. A ranged read on a store with no native range
    # fills the whole file too.
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
    assert await out.stdout_str() == "BODY"


class _RefusingGate:
    """An EntryGate that refuses one path and remembers what it was asked."""

    scoped = True
    granted = ()
    judged: frozenset[str] = frozenset()

    def __init__(self, refused: str) -> None:
        self.refused = refused
        self.asked: list[str] = []

    def check(self, virtual: str) -> None:
        self.asked.append(virtual)
        if virtual == self.refused:
            raise PermissionError(errno.EACCES, "sealed", virtual)


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


def _by_command(gate: EntryGate) -> Caller:
    """The caller of an op a command makes, with ``gate``: what its bound
    dispatch passes.

    Args:
        gate (EntryGate): the command's gate.
    """
    return dataclasses.replace(current_caller(), rule_gate=gate)


@pytest.mark.asyncio
async def test_a_commands_own_op_is_judged_on_every_path_it_reaches():
    # Each spelling once, in the order the dispatcher meets it: as handed in,
    # walked, then followed. A refused op leaves the bytes alone; one the
    # command did not make is the dispatcher's alone.
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
                await ws.dispatch(
                    op, _path(virtual), caller=_by_command(gate), **kwargs
                )
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
                "read", _path("/data/alias/flink2"), caller=_by_command(walked)
            )
        assert walked.asked == ["/data/alias/flink2", "/data/real/flink2"]
        await ws.dispatch("unlink", _path("/data/alias/secret"))
        with pytest.raises(FileNotFoundError):
            await _text(ws, "/data/real/secret")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_commands_unlink_of_a_link_is_judged_on_the_link_entry():
    # The link table answers unlink of a link: a rule on the link name
    # holds before that answer, and one on the referent is never asked.
    ws = await _linked_ws()
    try:
        with pytest.raises(PermissionError):
            await ws.dispatch(
                "unlink",
                _path("/data/flink"),
                caller=_by_command(_RefusingGate("/data/flink")),
            )
        referent = _RefusingGate("/data/real/secret")
        await ws.dispatch(
            "unlink", _path("/data/flink"), caller=_by_command(referent)
        )
        assert referent.asked == ["/data/flink"]
        assert await _text(ws, "/data/real/secret") == b"s\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_hidden_space_answers_a_commands_op_before_any_rule():
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
                await ws.dispatch(
                    op, _path(virtual), caller=_by_command(gate), **kwargs
                )
        assert gate.asked == []
    finally:
        reset_current_session(token)
        await ws.close()


@pytest.mark.asyncio
async def test_the_caller_never_reaches_the_op(monkeypatch):
    # The mount's op sees only its own arguments, whoever made the call.
    ws = await _linked_ws()
    seen: list[dict] = []
    real = MountEntry.call

    async def spy(self, op, *args, **kwargs):
        seen.append(dict(kwargs))
        return await real(self, op, *args, **kwargs)

    monkeypatch.setattr(MountEntry, "call", spy)
    try:
        gate = _RefusingGate("/nothing")
        await ws.dispatch(
            "read", _path("/data/real/secret"), caller=_by_command(gate)
        )
        assert seen and all("caller" not in kw for kw in seen)
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

    async def readdir(self, path: PathSpec) -> list[FileStat]:
        return [
            FileStat(name=name, type=FileType.FILE, size=len(data))
            for name, data in self.files.items()
        ]

    async def stat(self, path: PathSpec) -> FileStat:
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
        offset: int = 0,
        size: int | None = None,
    ) -> AsyncIterator[bytes]:
        self.reads += 1
        key = path.vfs_path.strip("/")
        if key not in self.files:
            raise FileNotFoundError(path.virtual)
        return self._pulled(self.files[key])

    async def write(
        self, path: PathSpec, data: bytes, index: IndexCacheStore = NULL_INDEX
    ) -> None:
        self.files[path.vfs_path.strip("/")] = data

    async def _pulled(self, data: bytes) -> AsyncIterator[bytes]:
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
        assert tape.reads == 1


@pytest.mark.asyncio
async def test_the_report_names_the_path_the_op_ran_on():
    # A record names the file a link led to, read off the report rather
    # than from a second follow of the link.
    with Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("echo body > /ram/a.txt; ln -s a.txt /ram/lk")
        report = OpReport()
        await ws.dispatch(
            "read", PathSpec.from_str_path("/ram/lk"), report=report
        )
        assert report.path == "/ram/a.txt"


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
async def test_a_window_or_a_post_vfs_policy_gets_whole_bytes(
    policies, kwargs
):
    tape = Tape()
    with Workspace(
        {"/tape/": tape}, mode=MountMode.WRITE, policies=policies
    ) as ws:
        got, _ = await ws.dispatch("read", TAPE, stream=True, **kwargs)
        assert isinstance(got, bytes)
        assert tape.reads == 1


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
async def test_a_mount_read_entry_never_cuts_a_stream(on_exceed):
    tape = Tape()
    with Workspace({"/tape/": tape}, mode=MountMode.WRITE) as ws:
        ws.namespace.mount_for("/tape/a.txt").command_limits["read"] = Limit(
            max_bytes=15, on_exceed=on_exceed
        )
        stream, _ = await ws.dispatch("read", TAPE, stream=True, filetype=None)
        got = b"".join([chunk async for chunk in stream])
        assert got == tape.files["a.txt"]
        assert tape.pulled == 5


@pytest.mark.asyncio
async def test_a_stream_closed_before_its_first_pull_closes_and_keeps_nothing():
    tape = Tape()
    with Workspace({"/tape/": tape}, mode=MountMode.WRITE) as ws:
        stream, _ = await ws.dispatch("read", TAPE, stream=True)
        await stream.aclose()
        assert (tape.pulled, tape.closed) == (1, True)
        await ws.dispatch("read", TAPE)
        assert tape.reads == 2


@pytest.mark.asyncio
async def test_a_write_during_a_stream_keeps_none_of_it():
    tape = Tape()
    with Workspace({"/tape/": tape}, mode=MountMode.WRITE) as ws:
        stream, _ = await ws.dispatch("read", TAPE, stream=True)
        await ws.dispatch("write", TAPE, data=b"new")
        assert [chunk async for chunk in stream][0] == b"0123456789"
        got, _ = await ws.dispatch("read", TAPE)
        assert (got, tape.reads) == (b"new", 1)


@pytest.mark.asyncio
async def test_a_subtree_read_names_the_links_on_its_own_mount():
    # No backend stores a link, so the walk a subtree read stands in for
    # meets them only here; one below a nested mount is that mount's.
    ws = Workspace(
        {"/base/": RAMVFS(), "/base/inner/": RAMVFS()}, mode=MountMode.WRITE
    )
    await ws.shell("echo hi > /base/f.txt")
    await ws.shell("ln -s /base/f.txt /base/kept")
    await ws.shell("ln -s /base/f.txt /base/inner/lnk")
    tree, _ = await ws.dispatch(
        "read_tree", PathSpec.from_str_path("/base"), nofollow=True
    )
    assert sorted(tree) == ["f.txt", "kept"]
    assert tree["kept"].type is FileType.SYMLINK


@pytest.mark.asyncio
async def test_a_listing_that_does_not_follow_stops_at_a_link():
    # As open(2) answers a link with O_DIRECTORY | O_NOFOLLOW. A listing
    # that follows names the children under the link it was handed.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("mkdir /data/d && echo hi > /data/d/f.txt")
    await ws.shell("ln -s /data/d /data/dlink")
    link = PathSpec.from_str_path("/data/dlink")
    with pytest.raises(NotADirectoryError):
        await ws.dispatch("readdir", link, nofollow=True)
    listed, _ = await ws.dispatch("readdir", link)
    assert listed == ["/data/dlink/f.txt"]
    # A caller that already followed the link hands the directory it
    # reached, its typed spelling riding along, and lists that one.
    reached = dataclasses.replace(
        PathSpec.from_str_path("/data/d"),
        raw_path="/data/dlink/",
        dotted="/data/dlink/",
    )
    listed, _ = await ws.dispatch("readdir", reached)
    assert listed == ["/data/d/f.txt"]


@pytest.mark.asyncio
async def test_a_stat_names_the_device_of_the_mount_serving_it():
    # The id a runtime reports as st_dev: one per mount, the namespace's
    # own for a directory no mount serves, and a link's is its mount's.
    ws = Workspace(
        {"/base/": RAMVFS(), "/base/inner/": RAMVFS(), "/far/deep/": RAMVFS()},
        mode=MountMode.WRITE,
    )
    await ws.shell("echo hi > /base/f.txt")
    await ws.shell("ln -s /base/inner /base/lnk")

    async def dev(path: str, **kwargs: bool) -> int | None:
        row, _ = await ws.dispatch(
            "stat", PathSpec.from_str_path(path), **kwargs
        )
        return row.dev

    assert await dev("/base/f.txt") == ident("/base/")
    assert await dev("/base") == ident("/base/")
    assert await dev("/base/inner") == ident("/base/inner/")
    assert await dev("/far") == ident("/")
    assert await dev("/base/lnk", nofollow=True) == ident("/base/")
    assert await dev("/base/lnk") == ident("/base/inner/")
    tree, _ = await ws.dispatch(
        "read_tree", PathSpec.from_str_path("/base"), nofollow=True
    )
    assert {row.dev for row in tree.values()} == {ident("/base/")}


@pytest.mark.asyncio
async def test_a_stat_after_the_commands_probe_is_the_probes_answer():
    # Under read: fresh the probe already asked the backend about the
    # command's operand. The stat after it is that answer, stamped as any
    # stat is; a write in the command sends the next one to the backend.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo hello > /data/a.txt")
    spec = PathSpec.from_str_path("/data/a.txt")
    manager = ws.namespace.mount_for("/data/a.txt").cache_manager
    probed = FileStat(name="a.txt", size=9, type=FileType.FILE)
    async with command_scope():
        manager.note_probed(spec, probed)
        row, _ = await ws.dispatch("stat", spec)
        assert (row.size, row.dev) == (9, ident("/data/"))
        await ws.dispatch("write", spec, data=b"hi")
        row, _ = await ws.dispatch("stat", spec)
        assert row.size == 2


class _LostReply(Tape):
    """A store whose write lands and whose reply then breaks off."""

    async def write(
        self, path: PathSpec, data: bytes, index: IndexCacheStore = NULL_INDEX
    ) -> None:
        self.files[path.vfs_path.strip("/")] = data
        raise ConnectionError("reply lost")


@pytest.mark.asyncio
async def test_a_write_that_raises_still_drops_the_cached_bytes():
    # The store may hold the new bytes though the write raised, so the
    # copy cached before it is not served again.
    tape = _LostReply()
    with Workspace({"/tape/": tape}, mode=MountMode.WRITE) as ws:
        await ws.dispatch("read", TAPE)
        with pytest.raises(ConnectionError):
            await ws.dispatch("write", TAPE, data=b"new")
        got, _ = await ws.dispatch("read", TAPE)
        assert (got, tape.reads) == (b"new", 2)


@pytest.mark.asyncio
async def test_a_path_the_line_retracted_is_not_served_from_the_cache():
    # A copy still running has recorded that it replaced the path, but the
    # dispatcher evicts only once the copy ends.
    tape = Tape()
    with Workspace({"/tape/": tape}, mode=MountMode.WRITE) as ws:
        await ws.dispatch("read", TAPE)
        scope = RecordingScope()
        try:
            record("copy", TAPE.virtual, "tape", 0, start_op())
            await ws.dispatch("read", TAPE)
        finally:
            scope.close()
        assert tape.reads == 2


@pytest.mark.asyncio
async def test_a_stream_past_the_drain_budget_keeps_nothing():
    tape = Tape()
    with Workspace({"/tape/": tape}, mode=MountMode.WRITE) as ws:
        manager = ws.namespace.mount_for("/tape/a.txt").cache_manager
        manager._file_cache.max_drain_bytes = 20
        stream, _ = await ws.dispatch("read", TAPE, stream=True)
        assert len(b"".join([chunk async for chunk in stream])) == 50
        await ws.dispatch("read", TAPE)
        assert tape.reads == 2


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
    with Workspace({"/d/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.vfs.write("/d/a.txt", b"a\nb\n")
        seen = dispatched(ws)
        out = await ws.shell(line)
        await out.stdout_str()
        assert out.exit_code == 0
        assert ("read", "/d/a.txt") in seen


class SearchedRAM(RAMVFS):
    """A RAM mount whose searches answer every file it holds and whose
    walk guard keeps the count it is handed."""

    def __init__(self) -> None:
        super().__init__()
        self.counted: list[int | None] = []
        self.batches: list[list[str]] = []

    async def files_containing(
        self, path, text, *, whole_word, ignore_case, index=NULL_INDEX
    ):
        return [mounted_path(path, key) for key in self._store.files]

    async def search(self, path, query, index=NULL_INDEX):
        return [
            (hit, f"{hit}\nabout {key}")
            for key in self._store.files
            for hit in [mounted_path(path, key).virtual]
        ]

    async def search_many(self, paths, query, index=NULL_INDEX):
        self.batches.append([path.virtual for path in paths])
        return await self.search(paths[0], query, index)

    async def before_full_walk(self, path, *, files=None, index=NULL_INDEX):
        self.counted.append(files)


@pytest.fixture
def secret_hidden():
    """Bind a session that hides one directory under the searched one."""
    session = SessionState(
        session_id="agent",
        visibility=Visibility(paths=HiddenPaths(paths=("/ram/d/secret",))),
    )
    token = set_current_session(session)
    yield session
    reset_current_session(token)


def _searched() -> SearchedRAM:
    vfs = SearchedRAM()
    vfs._store.dirs.update({"/d", "/d/secret"})
    vfs._store.files.update({"/d/a.txt": b"a\n", "/d/secret/b.txt": b"b\n"})
    return vfs


@pytest.mark.asyncio
async def test_a_hide_filters_a_tree_read_instead_of_declining(secret_hidden):
    with Workspace({"/ram/": _searched()}) as ws:
        found, _ = await ws.dispatch("read_tree", _path("/ram/d"))
        assert set(found) == {"a.txt"}


@pytest.mark.asyncio
async def test_a_hide_drops_its_files_from_a_search(secret_hidden):
    vfs = _searched()
    with Workspace({"/ram/": vfs}) as ws:
        hits, _ = await ws.dispatch(
            "files_containing",
            _path("/ram/d"),
            text="a",
            whole_word=False,
            ignore_case=False,
        )
        assert [hit.virtual for hit in hits] == ["/ram/d/a.txt"]
        for scope, scopes in [
            ("/ram/d", []),
            ("/ram/d/a.txt", []),
            ("/ram/d/a.txt", [_path("/ram/d")]),
        ]:
            records, _ = await ws.dispatch(
                "search", _path(scope), query=SearchQuery("a"), scopes=scopes
            )
            assert records == [
                ("/ram/d/a.txt", "/ram/d/a.txt\nabout /d/a.txt")
            ]
        assert vfs.batches == [["/ram/d/a.txt", "/ram/d"]]


class SeenSearches(Policy):
    def __init__(self) -> None:
        self.done: list[str] = []

    async def post_vfs(self, ctx: VfsResultContext) -> Action | None:
        if ctx.call.name == "search":
            self.done.append(ctx.path.virtual)
        return None


@pytest.mark.asyncio
async def test_scopes_on_two_mounts_are_searched_one_by_one():
    one, two = _searched(), _searched()
    with Workspace({"/one/": one, "/two/": two}) as ws:
        records, _ = await ws.dispatch(
            "search",
            _path("/one/d"),
            query=SearchQuery("a"),
            scopes=[_path("/two/d")],
        )
    assert [hit for hit, _ in records] == [
        "/one/d/a.txt",
        "/one/d/secret/b.txt",
        "/two/d/a.txt",
        "/two/d/secret/b.txt",
    ]
    assert one.batches == two.batches == []
    # A post_vfs policy judges each scope's answer, so the scopes of one
    # mount are searched one by one too.
    seen, vfs = SeenSearches(), _searched()
    with Workspace({"/ram/": vfs}, policies=[seen]) as ws:
        await ws.dispatch(
            "search",
            _path("/ram/d/a.txt"),
            query=SearchQuery("a"),
            scopes=[_path("/ram/d/secret")],
        )
    assert (vfs.batches, seen.done) == (
        [],
        ["/ram/d/a.txt", "/ram/d/secret"],
    )


@pytest.mark.asyncio
async def test_a_hide_drops_a_hit_whose_name_reads_like_a_score():
    vfs = _searched()
    vfs._store.files["/d/n:12"] = b"n\n"
    session = SessionState(
        session_id="agent",
        visibility=Visibility(paths=HiddenPaths(paths=("/ram/d/n:12",))),
    )
    token = set_current_session(session)
    try:
        with Workspace({"/ram/": vfs}) as ws:
            records, _ = await ws.dispatch(
                "search", _path("/ram/d"), query=SearchQuery("n")
            )
    finally:
        reset_current_session(token)
    assert "/ram/d/n:12" not in [hit for hit, _ in records]


@pytest.mark.asyncio
async def test_a_read_ahead_keeps_what_one_batch_answers():
    vfs = BatchedRAM()
    session = SessionState(
        session_id="agent",
        visibility=Visibility(paths=HiddenPaths(paths=("/r/secret",))),
    )
    token = set_current_session(session)
    try:
        with Workspace({"/r/": vfs}) as ws:
            await ws.dispatch(
                "read_many",
                _path("/r/a"),
                paths=[_path("/r/b"), _path("/r/secret/c")],
            )
            data, _ = await ws.dispatch("read", _path("/r/b"))
    finally:
        reset_current_session(token)
    assert vfs.batches == [["/r/a", "/r/b"]]
    assert (data, vfs.reads) == (b"b\n", [])


@pytest.mark.asyncio
async def test_a_read_ahead_reads_only_the_files_listed_small():
    vfs = BatchedRAM(batched=False)
    vfs._store.files["/big"] = b"x" * (READ_AHEAD_BYTES + 1)
    ws = Workspace({"/r/": vfs})
    try:
        await ws.mount("/r/").index.set_dir(
            "/r",
            [
                (n, FileStat(name=n, type=FileType.FILE, size=s))
                for n, s in [("a", 2), ("big", READ_AHEAD_BYTES + 1)]
            ],
        )
        await ws.dispatch(
            "read_many", _path("/r/a"), paths=[_path("/r/big"), _path("/r/b")]
        )
        assert vfs.reads == ["/r/a"]
        await ws.dispatch("read", _path("/r/a"))
        assert vfs.reads == ["/r/a"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_read_ahead_skips_cache_probes_for_known_directories():
    vfs = BatchedRAM()
    vfs._store.dirs.add("/empty")
    ws = Workspace({"/r": vfs})
    try:
        await ws.mount("/r").index.set_dir(
            "/r",
            [
                ("a", FileStat(name="a", type=FileType.FILE, size=2)),
                ("secret", FileStat(name="secret", type=FileType.DIRECTORY)),
                ("empty", FileStat(name="empty", type=FileType.DIRECTORY)),
            ],
        )
        exists = AsyncMock(wraps=ws.cache.exists)
        ws.cache.exists = exists
        await ws.dispatch(
            "read_many",
            _path("/r/a"),
            paths=[_path("/r/secret"), _path("/r/empty")],
        )
        assert [call.args[0] for call in exists.call_args_list] == ["/r/a"]
        assert vfs.batches == [["/r/a"]]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_warm_read_ahead_batches_metadata_lookups():
    vfs = BatchedRAM()
    ws = Workspace({"/r": vfs})
    try:
        await ws.dispatch("read_many", _path("/r/a"), paths=[_path("/r/b")])
        index = ws.mount("/r").index
        with patch.object(index, "get_many", wraps=index.get_many) as lookup:
            await ws.dispatch(
                "read_many", _path("/r/a"), paths=[_path("/r/b")]
            )
        lookup.assert_awaited_once_with(["/r/a", "/r/b"])
        assert vfs.batches == [["/r/a", "/r/b"]]
        data, _ = await ws.dispatch("read", _path("/r/a"))
        assert data == b"a\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_read_ahead_fetches_nothing_a_policy_could_refuse():
    vfs = BatchedRAM()
    with Workspace({"/r/": vfs}, policies=[DenyLocked()]) as ws:
        await ws.dispatch("read_many", _path("/r/a"), paths=[_path("/r/b")])
    assert (vfs.batches, vfs.reads) == ([], [])


@pytest.mark.asyncio
async def test_a_hide_still_declines_a_tree_removal(secret_hidden):
    with Workspace({"/ram/": _searched()}, mode=MountMode.WRITE) as ws:
        with pytest.raises(WalkDeclinedError):
            await ws.dispatch("rm_r", _path("/ram/d"))


@pytest.mark.asyncio
async def test_a_scan_guard_counts_only_the_files_the_session_sees(
    secret_hidden,
):
    vfs = _searched()
    with Workspace({"/ram/": vfs}) as ws:
        await ws.dispatch("before_full_walk", _path("/ram/d"))
        assert vfs.counted == [1]


class TreeCountingRAM(RAMVFS):
    """A RAM mount with no walk guard that counts its tree reads."""

    def __init__(self) -> None:
        super().__init__(walk_limit=-1)
        self.trees = 0

    async def read_tree(self, path):
        self.trees += 1
        return await super().read_tree(path)


@pytest.mark.asyncio
async def test_a_mount_with_no_scan_guard_is_not_counted():
    vfs = TreeCountingRAM()
    vfs._store.dirs.add("/d")
    with Workspace({"/ram/": vfs}) as ws:
        answer, _ = await ws.dispatch("before_full_walk", _path("/ram/d"))
    assert (answer, vfs.trees) == (None, 0)


class LimitedRAM(RAMVFS):
    """A RAM mount held to a ``walk_limit`` with no guard of its own."""

    def __init__(self) -> None:
        super().__init__(walk_limit=2)


class ListedRAM(LimitedRAM):
    """The same mount with no tree read, so a walk is counted by listing
    each directory."""

    read_tree = BaseVFS.read_tree

    def __init__(self) -> None:
        super().__init__()
        self.listed: list[str] = []

    async def readdir(self, path):
        self.listed.append(path.virtual)
        return await super().readdir(path)


class LinedRAM(LimitedRAM):
    """The limited mount handing each file's matching lines over itself."""

    def __init__(self) -> None:
        super().__init__()
        self.asked: list[str] = []

    async def lines_containing(self, path, text, *, ignore_case):
        self.asked.append(path.virtual)
        data = await self.read(path)
        return b"".join(
            line
            for line in data.splitlines(keepends=True)
            if text.encode() in line
        )


def _limited(cls: type[LimitedRAM], files: int) -> LimitedRAM:
    vfs = cls()
    vfs._store.dirs.update({"/d", "/d/secret"})
    vfs._store.files["/d/secret/b.txt"] = b"b\n"
    for i in range(files - 1):
        vfs._store.files[f"/d/a{i}.txt"] = b"a\n"
    return vfs


@pytest.mark.asyncio
@pytest.mark.parametrize("cls", [LimitedRAM, ListedRAM])
async def test_a_search_past_the_walk_limit_stops_there(cls):
    with Workspace({"/ram/": _limited(cls, 3)}) as ws:
        out = await ws.shell("grep -r a /ram/d")
        assert (await out.stdout_str(), out.stderr, out.exit_code) == (
            "/ram/d/a0.txt:a\n/ram/d/a1.txt:a\n",
            b"grep: /ram/d: stopped after 2 files (walk_limit); "
            b"narrow the path\n",
            2,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("cls", [LimitedRAM, ListedRAM])
@pytest.mark.parametrize(
    "line, out, code",
    [
        ("find /ram/d", "/ram/d\n/ram/d/a0.txt\n/ram/d/a1.txt\n", 1),
        ("ls -R /ram/d", "/ram/d:\na0.txt\na1.txt\n", 1),
        (
            "tree /ram/d",
            "/ram/d\n|-- a0.txt\n`-- a1.txt\n\n1 directory, 2 files\n",
            2,
        ),
        ("du -a /ram/d", "2\t/ram/d/a0.txt\n2\t/ram/d/a1.txt\n4\t/ram/d\n", 1),
    ],
)
async def test_a_listing_past_the_walk_limit_stops_there(cls, line, out, code):
    with Workspace({"/ram/": _limited(cls, 3)}) as ws:
        result = await ws.shell(line)
        name = line.split()[0]
        assert (
            await result.stdout_str(),
            result.stderr,
            result.exit_code,
        ) == (
            out,
            name.encode() + b": /ram/d: stopped after 2 files (walk_limit); "
            b"narrow the path\n",
            code,
        )


@pytest.mark.asyncio
async def test_a_listing_across_mounts_stops_at_each_mounts_limit():
    with Workspace(
        {"/a/": _limited(LimitedRAM, 3), "/b/": _limited(LimitedRAM, 3)}
    ) as ws:
        result = await ws.shell("ls -R /a/d /b/d")
        assert (
            await result.stdout_str(),
            result.stderr,
            result.exit_code,
        ) == (
            "/a/d:\na0.txt\na1.txt\n\n/b/d:\na0.txt\na1.txt\n",
            b"ls: /a/d: stopped after 2 files (walk_limit); "
            b"narrow the path\n"
            b"ls: /b/d: stopped after 2 files (walk_limit); "
            b"narrow the path\n",
            1,
        )


GLOB_REFUSED = (
    "/ram/d/*: matches more than 2 files (walk_limit); narrow the path"
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, out, err",
    [
        (
            "cat /ram/d/*; echo $?",
            "126\n",
            f"cat: Argument list too long\ncat: {GLOB_REFUSED}\n",
        ),
        (
            "echo /ram/d/*; echo $?",
            "126\n",
            f"echo: Argument list too long\necho: {GLOB_REFUSED}\n",
        ),
        (
            "for f in /ram/d/*; do echo $f; done; echo after",
            "",
            f"bash: {GLOB_REFUSED}\n",
        ),
        ("cat /ram/d/a*", "a\na\n", ""),
        ("echo /ram/d/*/b.txt", "/ram/d/secret/b.txt\n", ""),
    ],
)
async def test_a_glob_past_the_walk_limit_is_refused(line, out, err):
    with Workspace({"/ram/": _limited(LimitedRAM, 3)}) as ws:
        result = await ws.shell(line)
        assert (await result.stdout_str(), await result.stderr_str()) == (
            out,
            err,
        )


@pytest.mark.asyncio
async def test_a_named_file_counts_nothing_against_a_walk():
    vfs = LimitedRAM()
    vfs._store.dirs.add("/d")
    for i in range(2):
        vfs._store.files[f"/d/a{i}.txt"] = b"a\n"
    with Workspace({"/ram/": vfs}) as ws:
        out = await ws.shell("grep -r a /ram/d /ram/d/a0.txt")
        assert (
            await out.stdout_str(),
            await out.stderr_str(),
            out.exit_code,
        ) == ("/ram/d/a0.txt:a\n/ram/d/a1.txt:a\n/ram/d/a0.txt:a\n", "", 0)


@pytest.mark.asyncio
async def test_lines_a_search_hands_over_count_against_the_limit():
    vfs = LinedRAM()
    vfs._store.dirs.add("/d")
    for i in range(4):
        vfs._store.files[f"/d/f{i}.txt"] = b"hello\nother\n"
    with Workspace({"/ram/": vfs}) as ws:
        out = await ws.shell("grep -r hello /ram/d")
        assert (await out.stdout_str(), out.stderr, out.exit_code) == (
            "/ram/d/f0.txt:hello\n/ram/d/f1.txt:hello\n",
            b"grep: /ram/d: stopped after 2 files (walk_limit); "
            b"narrow the path\n",
            2,
        )
    assert vfs.asked == ["/ram/d/f0.txt", "/ram/d/f1.txt"]


@pytest.mark.asyncio
@pytest.mark.parametrize("sort", ["path", "modified"])
async def test_a_planned_rg_counts_each_file_against_its_own_mount(sort):
    top = RAMVFS(walk_limit=-1)
    top._store.files["/t.txt"] = b"hello\n"
    remote = RAMVFS(walk_limit=2)
    for i in range(4):
        remote._store.files[f"/r{i}.txt"] = b"hello\n"
    with Workspace({"/a/": top, "/a/remote/": remote}) as ws:
        out = await ws.shell(f"rg --sort {sort} -l hello /a")
        assert (
            sorted((await out.stdout_str()).splitlines()),
            out.stderr,
            out.exit_code,
        ) == (
            ["/a/remote/r0.txt", "/a/remote/r1.txt", "/a/t.txt"],
            b"rg: /a/remote: stopped after 2 files (walk_limit); "
            b"narrow the path\n",
            2,
        )


NESTED_REFUSED = (
    "/a/*/*.txt: matches more than 2 files (walk_limit); narrow the path"
)


@pytest.mark.asyncio
@pytest.mark.parametrize("command", ["cat", "echo"])
async def test_a_glob_counts_each_match_against_its_own_mount(command):
    top = RAMVFS(walk_limit=-1)
    top._store.dirs.add("/b")
    top._store.files["/b/t.txt"] = b"t\n"
    remote = RAMVFS(walk_limit=2)
    for i in range(3):
        remote._store.files[f"/r{i}.txt"] = b"r\n"
    with Workspace({"/a/": top, "/a/remote/": remote}) as ws:
        out = await ws.shell(f"{command} /a/*/*.txt; echo $?")
        assert (await out.stdout_str(), await out.stderr_str()) == (
            "126\n",
            f"{command}: Argument list too long\n"
            f"{command}: {NESTED_REFUSED}\n",
        )


@pytest.mark.asyncio
async def test_a_glob_through_a_link_counts_against_the_target_mount():
    top = RAMVFS(walk_limit=-1)
    top._store.dirs.add("/data")
    for i in range(3):
        top._store.files[f"/data/t{i}.txt"] = b"t\n"
    remote = RAMVFS(walk_limit=2)
    with Workspace(
        {"/a/": top, "/a/remote/": remote}, mode=MountMode.WRITE
    ) as ws:
        await ws.shell("ln -s /a/data /a/remote/link")
        out = await ws.shell("echo /a/*/*/*.txt; echo $?")
        assert (await out.stdout_str(), await out.stderr_str()) == (
            "/a/remote/link/t0.txt /a/remote/link/t1.txt"
            " /a/remote/link/t2.txt\n0\n",
            "",
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("cls", [LimitedRAM, ListedRAM])
async def test_rm_r_leaves_the_files_a_nested_mount_covers(cls):
    vfs = cls()
    vfs._store.dirs.update({"/d", "/d/sub"})
    vfs._store.files["/d/x.txt"] = b"x\n"
    for i in range(3):
        vfs._store.files[f"/d/sub/c{i}.txt"] = b"c\n"
    with Workspace(
        {"/ram/": vfs, "/ram/d/sub/": RAMVFS()}, mode=MountMode.WRITE
    ) as ws:
        out = await ws.shell("rm -r /ram/d; echo $?")
        assert (await out.stdout_str(), await out.stderr_str()) == (
            "1\n",
            "rm: skipping '/ram/d/sub', since it's on a different device\n",
        )
    assert sorted(vfs._store.files) == [
        "/d/sub/c0.txt",
        "/d/sub/c1.txt",
        "/d/sub/c2.txt",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("cls", [LimitedRAM, ListedRAM])
async def test_a_copy_past_the_walk_limit_is_refused(cls):
    with Workspace({"/ram/": _limited(cls, 3)}, mode=MountMode.WRITE) as ws:
        out = await ws.shell("tar -cf /ram/d.tar /ram/d")
        assert (await out.stdout_str(), out.stderr, out.exit_code) == (
            "",
            b"tar: more than 2 files in scope (walk_limit); narrow the path\n",
            1,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("cls", [LimitedRAM, ListedRAM])
async def test_a_copy_counts_no_file_a_nested_mount_covers(cls):
    vfs = cls()
    vfs._store.dirs.update({"/d", "/d/sub"})
    vfs._store.files["/d/x.txt"] = b"x\n"
    for i in range(3):
        vfs._store.files[f"/d/sub/c{i}.txt"] = b"c\n"
    with Workspace(
        {"/ram/": vfs, "/ram/d/sub/": RAMVFS()}, mode=MountMode.WRITE
    ) as ws:
        out = await ws.shell("tar -cf /ram/d.tar /ram/d; tar -tf /ram/d.tar")
        assert (await out.stdout_str(), out.exit_code) == (
            "ram/d/\nram/d/sub/\nram/d/x.txt\n",
            0,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("cls", [LimitedRAM, ListedRAM])
async def test_a_walk_within_the_walk_limit_runs(cls):
    with Workspace({"/ram/": _limited(cls, 2)}) as ws:
        out = await ws.shell("grep -rl a /ram/d")
        assert await out.stdout_str() == "/ram/d/a0.txt\n"
        assert out.exit_code == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("cls", [LimitedRAM, ListedRAM])
async def test_a_hidden_file_does_not_count_to_the_walk_limit(
    cls, secret_hidden
):
    vfs = _limited(cls, 3)
    with Workspace({"/ram/": vfs}) as ws:
        answer, _ = await ws.dispatch("before_full_walk", _path("/ram/d"))
    assert answer is None


@pytest.mark.asyncio
async def test_a_listed_count_stops_one_file_past_the_limit():
    vfs = ListedRAM()
    for i in range(6):
        vfs._store.dirs.add(f"/d/s{i}")
        vfs._store.files[f"/d/s{i}/f.txt"] = b"f\n"
    vfs._store.dirs.add("/d")
    with Workspace({"/ram/": vfs}) as ws:
        with pytest.raises(ValueError, match="more than 2 files"):
            await ws.dispatch("before_full_walk", _path("/ram/d"))
    assert len(vfs.listed) == 4


class CutRAM(RAMVFS):
    """A RAM mount whose listing stops at a walk's ``limit``."""

    def __init__(self) -> None:
        super().__init__()
        self.asked: list[int | None] = []
        self._store.dirs.add("/d")
        for name in ("a", "b", "sec"):
            self._store.files[f"/d/{name}"] = b""

    async def readdir(self, path, limit=None):
        self.asked.append(limit)
        rows = list(await super().readdir(path))
        if limit is None or len(rows) < limit:
            return rows
        return DirListing(rows[:limit], partial=True)


@pytest.mark.asyncio
async def test_a_cut_listing_is_not_kept_as_the_whole_directory():
    vfs = CutRAM()
    with Workspace({"/ram/": vfs}) as ws:
        cut, _ = await ws.dispatch("readdir", _path("/ram/d"), limit=2)
        whole, _ = await ws.dispatch("readdir", _path("/ram/d"))
    assert vfs.asked == [2, None]
    assert (len(cut), len(whole)) == (2, 3)


@pytest.mark.asyncio
async def test_a_hide_below_a_listing_drops_the_walks_limit():
    # The hide filters the listing after the backend answers, so a cut
    # one could leave nothing visible and still read as complete.
    vfs = CutRAM()
    with Workspace({"/ram/": vfs}) as ws:
        sess = ws.create_session(
            "veiled", profile={"paths": {"hide": ["/ram/d/sec"]}}
        )
        token = set_current_session(sess)
        try:
            listed, _ = await ws.dispatch("readdir", _path("/ram/d"), limit=2)
        finally:
            reset_current_session(token)
    assert vfs.asked == [None]
    assert listed == ["/ram/d/a", "/ram/d/b"]


@pytest.mark.asyncio
async def test_path_admission_checks_aliases_without_backend_io(monkeypatch):
    ram = RAMVFS()
    ws = Workspace({"/data": ram}, mode=MountMode.WRITE)
    try:
        await ws.shell("mkdir /data/real; ln -s /data/real /data/alias")
        call = AsyncMock(side_effect=AssertionError("unexpected backend call"))
        monkeypatch.setattr(MountEntry, "call", call)
        with pytest.raises(PermissionError):
            await ws.dispatch(
                "stat",
                _path("/data/alias/new"),
                caller=_by_command(_RefusingGate("/data/alias/new")),
                admit_only=True,
            )
        gate = _RefusingGate("/unrelated")
        result, _ = await ws.dispatch(
            "stat",
            _path("/data/alias/new"),
            caller=_by_command(gate),
            admit_only=True,
        )
        assert result is None
        assert gate.asked == ["/data/alias/new", "/data/real/new"]
        call.assert_not_awaited()
    finally:
        await ws.close()


class StreamWritingRAM(RAMVFS):
    def __init__(self):
        super().__init__()
        self.streamed = []
        self.chunk_sizes = []
        self.fail = False
        self.caches_reads = True

    async def write(self, path, data, *, atomic=False):
        if isinstance(data, bytes):
            return await super().write(path, data)
        self.streamed.append(("write", path.virtual))
        content = []
        async for chunk in data:
            self.chunk_sizes.append(len(chunk))
            if self.fail:
                await super().write(path, chunk)
                raise OSError("write failed after a prefix")
            content.append(chunk)
        await super().write(path, b"".join(content))

    async def append(self, path, data):
        if isinstance(data, bytes):
            return await super().append(path, data)
        self.streamed.append(("append", path.virtual))
        content = []
        async for chunk in data:
            self.chunk_sizes.append(len(chunk))
            content.append(chunk)
        await super().append(path, b"".join(content))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,target,expected",
    [
        ("cat /src/f > /dst/out", "/dst/out", b"a\nb\nc"),
        ("cat /src/f >> /dst/out", "/dst/out", b"a\nb\nc"),
        ("cat /src/f | tee /dst/out", "/dst/out", b"a\nb\nc"),
        ("cp /src/f /dst/out", "/dst/out", b"a\nb\nc"),
        ("split -l 2 /src/f /dst/part", "/dst/partab", b"c"),
        ("sed -n 'w /dst/out' /src/f", "/dst/out", b"a\nb\nc"),
        ("""awk '{ print > "/dst/out" }' /src/f""", "/dst/out", b"a\nb\nc\n"),
        ("sort -o /dst/out /src/f", "/dst/out", b"a\nb\nc\n"),
        ("xxd -p /src/f /dst/out", "/dst/out", b"610a620a63\n"),
        ("sed -i s/a/A/ /dst/edit", "/dst/edit", b"A\nb\nc"),
    ],
)
async def test_named_outputs_reach_native_stream_writers(
    line, target, expected
):
    destination = StreamWritingRAM()
    ws = Workspace(
        {"/src": RAMVFS(), "/dst": destination}, mode=MountMode.WRITE
    )
    try:
        await ws.vfs.write("/src/f", b"a\nb\nc")
        await ws.vfs.write("/dst/edit", b"a\nb\nc")
        result = await asyncio.wait_for(ws.shell(line), 5)
        await result.materialize_stdout()
        assert result.exit_code == 0, await result.stderr_str()
        assert any(path == target for _, path in destination.streamed)
        assert await ws.vfs.read(target) == expected
        assert max(destination.chunk_sizes) <= 16384
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_failed_streamed_write_invalidates_old_content_and_closes_input():
    destination = StreamWritingRAM()
    ws = Workspace({"/dst": destination}, mode=MountMode.WRITE)
    closed = []
    try:
        await ws.vfs.write("/dst/f", b"old")
        assert await ws.vfs.read("/dst/f") == b"old"
        destination.fail = True

        async def source():
            try:
                yield b"new"
                yield b"tail"
            finally:
                closed.append(True)

        with pytest.raises(OSError, match="write failed"):
            await ws.vfs.write("/dst/f", source())
        assert closed == [True]
        assert not await ws.cache.exists("/dst/f")
        assert await ws.vfs.read("/dst/f") == b"new"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("budget,kept", [(None, b"new"), (2, None)])
async def test_a_streamed_write_keeps_what_fits_the_drain_budget(
    budget, kept, monkeypatch
):
    destination = StreamWritingRAM()
    ws = Workspace({"/dst": destination}, mode=MountMode.WRITE)
    ws.cache.max_drain_bytes = budget
    tokens = []
    original = destination.write

    async def write(path, data, *, atomic=False):
        if isinstance(data, bytes):
            return await original(path, data)
        tokens.append((await ws.cache.fingerprints([path.virtual]))[0])
        assert not await ws.cache.exists(path.virtual)
        await original(path, data, atomic=atomic)
        record("write", path.virtual, "ram", 3, start_op(), fingerprint="v2")

    monkeypatch.setattr(destination, "write", write)
    try:
        await ws.vfs.write("/dst/f", b"old")
        await ws.cache.set("/dst/f", b"old", fingerprint="v1")
        await ws.vfs.write("/dst/f", yield_bytes(b"new"))
        assert tokens == ["v1"]
        assert await ws.cache.get("/dst/f") == kept
        assert (await ws.cache.fingerprints(["/dst/f"]))[0] == "v2"
    finally:
        await ws.close()


class UnreadWriteSource:
    def __init__(self):
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise AssertionError("a refused write pulled its input")

    async def aclose(self):
        self.closed = True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode,session_id,error",
    [
        (MountMode.READ, None, PermissionError),
        (MountMode.WRITE, "missing", KeyError),
    ],
)
async def test_refused_write_closes_input_without_pulling_it(
    mode, session_id, error
):
    ws = Workspace({"/dst": RAMVFS()}, mode=mode)
    source = UnreadWriteSource()
    try:
        with pytest.raises(error):
            await ws.vfs.write("/dst/f", source, session_id=session_id)
        assert source.closed
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_streamed_writes_record_the_bytes_they_sent():
    ws = Workspace({"/dst": StreamWritingRAM()}, mode=MountMode.WRITE)
    try:
        await ws.vfs.write("/dst/f", yield_bytes(b"new"))
        await ws.vfs.append("/dst/f", yield_bytes(b"tail"))
        assert [
            (r.op, r.bytes)
            for r in ws.vfs.records
            if r.op in ("write", "append")
        ] == [("write", 3), ("append", 4)]
    finally:
        await ws.close()


class QuietSource:
    def __init__(self):
        self.asked = asyncio.Event()
        self.done = asyncio.Event()

    def __aiter__(self):
        return self

    async def __anext__(self):
        self.asked.set()
        await self.done.wait()
        raise StopAsyncIteration


@pytest.mark.asyncio
async def test_an_empty_streamed_append_keeps_no_copy_from_before_it_waited():
    ws = Workspace({"/dst": StreamWritingRAM()}, mode=MountMode.WRITE)
    source = QuietSource()
    try:
        await ws.vfs.write("/dst/f", b"old")
        await ws.cache.set("/dst/f", b"old", fingerprint="v1")
        quiet = asyncio.create_task(ws.vfs.append("/dst/f", source))
        await source.asked.wait()
        await ws.vfs.append("/dst/f", b"new")
        source.done.set()
        await quiet
        assert await ws.cache.get("/dst/f") != b"old"
        assert await ws.vfs.read("/dst/f") == b"oldnew"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,expected",
    [
        ("cat /dst/f >> /dst/f", {"/dst/f": b"a\nb\nca\nb\nc"}),
        (
            "sed -n -e 'w /dst/a' -e 'w /dst/b' /dst/f",
            {"/dst/a": b"a\nb\nc", "/dst/b": b"a\nb\nc"},
        ),
    ],
)
async def test_streamed_writes_never_reread_or_reopen_their_output(
    line, expected
):
    destination = StreamWritingRAM()
    ws = Workspace({"/dst": destination}, mode=MountMode.WRITE)
    try:
        await ws.vfs.write("/dst/f", b"a\nb\nc")
        result = await asyncio.wait_for(ws.shell(line), 5)
        assert result.exit_code == 0, await result.stderr_str()
        for path, data in expected.items():
            assert await ws.vfs.read(path) == data
        streamed = [path for _, path in destination.streamed]
        assert "/dst/f" not in streamed
        assert all(streamed.count(path) <= 1 for path in expected)
    finally:
        await ws.close()


class _SealedReads(Policy):
    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        if not ctx.write and ctx.path.virtual == "/data/secret":
            return Deny("sealed")
        return None


@pytest.mark.asyncio
async def test_a_hide_answers_before_any_policy_and_leaves_no_record():
    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, policies=[_SealedReads()]
    )
    try:
        await ws.shell("echo s > /data/secret")
        ws.create_session(
            "veiled", profile={"paths": {"hide": ["/data/secret"]}}
        )
        with pytest.raises(FileNotFoundError) as hidden:
            await ws.vfs.read("/data/secret", session_id="veiled")
        assert getattr(hidden.value, "refusal", None) is None
        with pytest.raises(PermissionError) as denied:
            await ws.vfs.read("/data/secret")
        refusal = getattr(denied.value, "refusal", None)
        assert refusal is not None and refusal.reason == "sealed"
    finally:
        await ws.close()


class _Listening(Policy):
    def __init__(self) -> None:
        self.asked: list[str] = []

    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        self.asked.append(ctx.path.virtual)
        return None


@pytest.mark.asyncio
async def test_a_probe_of_a_hidden_path_answers_as_absent_before_any_policy():
    # A probe reads on the caller's behalf: a path the caller cannot see
    # is absent to it, as the walk answers, and neither a policy nor the
    # backend hears of it.
    listening = _Listening()
    dispatcher, _ = _dispatcher(Policies([listening]))
    dispatcher._namespace.symlink_targets = MagicMock(return_value={})
    mount = dispatcher._namespace.try_mount_for.return_value
    mount.answers_at = MagicMock(return_value=True)
    caller = Caller(
        session=SessionState(
            session_id="agent",
            visibility=Visibility(paths=HiddenPaths(paths=("/data/hid",))),
        )
    )
    with pytest.raises(FileNotFoundError):
        await dispatcher._probe_read(
            "stat", mount, _path("/data/hid/x"), caller
        )
    assert listening.asked == []
    mount.call.assert_not_called()
