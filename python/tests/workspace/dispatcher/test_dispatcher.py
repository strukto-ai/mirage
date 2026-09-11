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
from unittest.mock import AsyncMock, MagicMock

import pytest

from mirage.context import reset_current_session, set_current_session
from mirage.policy import (Action, CommandRule, Deny, OpsContext, Policies,
                           Policy, PolicyDenied)
from mirage.policy.rule import RulePolicy
from mirage.resource.ram import RAMResource
from mirage.types import (ConsistencyPolicy, FileType, HiddenPaths, MountMode,
                          PathSpec)
from mirage.utils.errors import ReadOnlyError
from mirage.workspace import Workspace
from mirage.workspace.dispatcher import Dispatcher
from mirage.workspace.dispatcher.dispatcher import _MountChannel
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.session import Session


class DenyLocked(Policy):

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        if ctx.path.virtual.startswith("/data/locked/"):
            return Deny("locked\n")
        return None


class DenyWrites(Policy):

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        if ctx.write:
            return Deny("no writes\n")
        return None


class DenyRemnantUnlink(Policy):

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        if ctx.op == "unlink" and ctx.path.virtual == "/a/d/sec/k":
            return Deny("protected\n")
        return None


def _path(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    resource_path="",
                    raw_path=virtual,
                    resolved=True)


def _dispatcher(policies: Policies) -> tuple[Dispatcher, MagicMock]:
    namespace = MagicMock()
    namespace.ensure_loaded = AsyncMock()
    namespace.follow = MagicMock(side_effect=lambda p: p)
    mount = MagicMock()
    mount.prefix = "/data/"
    mount.retiring = False
    mount.ensure_ready = AsyncMock()
    mount.resource.caches_reads = True
    mount.execute_op = AsyncMock(return_value=b"cold")
    namespace.try_mount_for = MagicMock(return_value=mount)
    namespace.registry.policies = policies
    cache = MagicMock()
    cache.get = AsyncMock(return_value=b"warm")
    dispatcher = Dispatcher(namespace, cache, ConsistencyPolicy.LAZY)
    reconciler = MagicMock()
    reconciler.may_serve_cached = AsyncMock(return_value=True)
    dispatcher._reconciler = reconciler
    return dispatcher, cache


@pytest.mark.asyncio
async def test_warm_cache_read_cannot_bypass_pre_ops():
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
    # A symlink create is a name-plane write the door itself answers;
    # the policy write classification must cover it like any mutation.
    policies = Policies()
    policies.add(DenyWrites())
    dispatcher, _ = _dispatcher(policies)
    ns = dispatcher._namespace
    ns.registry.mounts = MagicMock(
        return_value=[ns.try_mount_for.return_value])
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
        return_value=[ns.try_mount_for.return_value])
    ns.readlink = MagicMock(return_value="x.txt")
    result, _ = await dispatcher.dispatch("readlink", _path("/data/lk"))
    assert result == "x.txt"
    ns.follow.assert_not_called()


@pytest.mark.asyncio
async def test_spec_op_twin_holds_on_the_dispatch_door():
    policies = Policies()
    policies.add(
        RulePolicy(CommandRule(reason="frozen", paths=("/data/locked/*", ))))
    dispatcher, _ = _dispatcher(policies)
    with pytest.raises(PolicyDenied) as excinfo:
        await dispatcher.dispatch("read", _path("/data/locked/a.txt"))
    assert "frozen" in str(excinfo.value)


def _structure_only(dispatcher) -> None:
    """Point the mocks at a path no mount serves but structure knows:
    try_mount_for misses, while a mount deeper down makes the namespace
    answer readdir/stat for its parent."""
    namespace = dispatcher._namespace
    namespace.try_mount_for = MagicMock(return_value=None)
    deep = MagicMock()
    deep.prefix = "/data/locked/inner/deep/"
    namespace.registry.mounts = MagicMock(return_value=[deep])
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
    result, _ = await dispatcher.dispatch("readdir",
                                          _path("/data/locked/inner"))
    assert result == ["/data/locked/inner/deep"]


@pytest.fixture
def scoped_session():
    """Bind a session whose profile hides the parent mount's own content,
    leaving the mount nested below it reachable."""
    session = Session(session_id="agent",
                      hidden_paths=HiddenPaths(paths=("/data/locked/other",
                                                      "/data/locked/f.txt")))
    token = set_current_session(session)
    yield session
    reset_current_session(token)


@pytest.mark.asyncio
async def test_a_structure_answer_still_clears_the_sessions_hides(
        scoped_session):
    # The synthetic answer passes the session's view as well as the
    # policy chain: it is produced above every backend, so a path the
    # profile hides would otherwise be served by the one code path that
    # asks no mount anything.
    dispatcher, _ = _dispatcher(Policies())
    _structure_only(dispatcher)
    result, _ = await dispatcher.dispatch("readdir",
                                          _path("/data/locked/inner"))
    assert result == ["/data/locked/inner/deep"]
    with pytest.raises(FileNotFoundError):
        await dispatcher.dispatch("readdir", _path("/data/locked/other"))


@pytest.mark.asyncio
async def test_a_hidden_path_denies_a_read_and_refuses_a_create(
        scoped_session):
    # The hide's two verdicts, at the door every surface comes through:
    # absent on a read, EACCES on a create, and a write is never served
    # from structure.
    dispatcher, _ = _dispatcher(Policies())
    _structure_only(dispatcher)
    with pytest.raises(FileNotFoundError):
        await dispatcher.dispatch("stat", _path("/data/locked/other"))
    with pytest.raises(PermissionError):
        await dispatcher.dispatch("write",
                                  _path("/data/locked/f.txt"),
                                  data=b"x")


@pytest.mark.asyncio
async def test_unlink_removes_a_namespace_link():
    # The door creates links (`symlink`), so it has to remove them too:
    # a link has no backend entry, so forwarding the unlink reaches a
    # backend that has never heard of the name and answers ENOENT,
    # leaving the link in place. That is what left `git checkout` unable
    # to drop a link the other branch does not have.
    with Workspace({"/ram/": RAMResource()}, mode=MountMode.WRITE) as ws:
        await ws.execute("echo hi > /ram/a.txt")
        await ws.execute("ln -s a.txt /ram/link")
        assert ws._namespace.is_link("/ram/link")
        await ws.dispatch("unlink", PathSpec.from_str_path("/ram/link"))
        assert not ws._namespace.is_link("/ram/link")
        listing = await ws.execute("ls /ram")
        assert b"link" not in (listing.stdout or b"")


@pytest.mark.asyncio
async def test_unlink_of_an_ordinary_file_still_reaches_the_backend():
    with Workspace({"/ram/": RAMResource()}, mode=MountMode.WRITE) as ws:
        await ws.execute("echo hi > /ram/a.txt")
        await ws.dispatch("unlink", PathSpec.from_str_path("/ram/a.txt"))
        listing = await ws.execute("ls /ram")
        assert (listing.stdout or b"").strip() == b""


@pytest.mark.asyncio
async def test_rename_moves_a_namespace_link():
    # Same fact as the unlink above, one verb along: a guest's os.rename
    # of a link forwarded to a backend that had never heard of the name,
    # so it answered ENOENT with the link still under the old one.
    with Workspace({"/ram/": RAMResource()}, mode=MountMode.WRITE) as ws:
        await ws.execute("echo hi > /ram/a.txt")
        await ws.execute("ln -s a.txt /ram/link")
        await ws.dispatch("rename",
                          PathSpec.from_str_path("/ram/link"),
                          dst=PathSpec.from_str_path("/ram/moved"))
        assert not ws._namespace.is_link("/ram/link")
        assert ws._namespace.readlink("/ram/moved") == "a.txt"


@pytest.mark.asyncio
async def test_a_no_follow_stat_answers_a_links_own_row():
    # lstat asks for the row only the node table holds. Without it every
    # surface rebuilt the row from the target string and reported epoch
    # zero, so a no-follow utime persisted and stayed invisible.
    with Workspace({"/ram/": RAMResource()}, mode=MountMode.WRITE) as ws:
        await ws.execute("echo hi > /ram/a.txt")
        await ws.execute("ln -s a.txt /ram/link")
        link = PathSpec.from_str_path("/ram/link")
        row, _ = await ws.dispatch("stat", link, nofollow=True)
        assert row.type == FileType.SYMLINK
        assert row.size == len("a.txt")
        await ws.dispatch("setattr",
                          link,
                          mode=None,
                          uid=None,
                          gid=None,
                          atime=None,
                          mtime="2020-01-02T03:04:05Z",
                          nofollow=True)
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
    with Workspace({"/ram/": RAMResource()}, mode=MountMode.WRITE) as ws:
        await ws.execute("echo hi > /ram/a.txt")
        await ws.execute("echo tgt > /ram/t.txt")
        await ws.execute("ln -s t.txt /ram/link")
        await ws.dispatch("rename",
                          PathSpec.from_str_path("/ram/a.txt"),
                          dst=PathSpec.from_str_path("/ram/link"))
        assert not ws._namespace.is_link("/ram/link")
        assert (await ws.execute("cat /ram/link")).stdout == b"hi\n"


@pytest.mark.asyncio
async def test_a_read_grant_refuses_link_writes_like_file_writes():
    # The mode gate on the table ops. A read grant refused a file's
    # unlink with EROFS while the same session deleted, created and
    # renamed its sibling link: the table verbs ran no mode check at
    # all, so `mounts: {"/extra": "read"}` protected everything on the
    # mount except its names.
    with Workspace({"/extra/": RAMResource()}, mode=MountMode.WRITE) as ws:
        await ws.execute("echo b > /extra/plain.txt")
        await ws.execute("ln -s plain.txt /extra/lk")
        sess = ws.create_session("agent", mounts={"/extra/": "read"})
        token = set_current_session(sess)
        try:
            for coro in (
                    ws.dispatch("unlink", PathSpec.from_str_path("/extra/lk")),
                    ws.dispatch("symlink",
                                PathSpec.from_str_path("/extra/lk2"),
                                target="plain.txt"),
                    ws.dispatch("rename",
                                PathSpec.from_str_path("/extra/lk"),
                                dst=PathSpec.from_str_path("/extra/mv")),
            ):
                with pytest.raises(ReadOnlyError) as exc:
                    await coro
                assert exc.value.errno == errno.EROFS
        finally:
            reset_current_session(token)
        assert ws._namespace.readlink("/extra/lk") == "plain.txt"
        assert not ws._namespace.is_link("/extra/lk2")


@pytest.mark.asyncio
async def test_a_read_mount_still_takes_a_link_sessionless():
    # The mount's own mode is NOT this gate. `mode: read` says the
    # backend cannot write, and a symlink is namespace state needing no
    # write capability from it -- which is why a link above postgres,
    # mongodb, chroma and qdrant (all mounted read) is pinned working in
    # integ/resources/<svc>/sym.json. Only a session grant binds here.
    with Workspace({"/ro/": (RAMResource(), MountMode.READ)}) as ws:
        await ws.dispatch("symlink",
                          PathSpec.from_str_path("/ro/lk"),
                          target="t")
        assert ws._namespace.is_link("/ro/lk")
        # And the backend write on that same mount is still refused, so
        # the two planes are told apart rather than both waved through.
        with pytest.raises(ReadOnlyError):
            await ws.dispatch("write",
                              PathSpec.from_str_path("/ro/f.txt"),
                              data=b"x")


@pytest.mark.asyncio
async def test_a_rename_destination_is_judged_on_its_own_turf():
    # The endpoints need not share a turf, and each is scored against
    # its own prefix: a grant writing /rw but only reading /ro refuses,
    # blaming the destination, the way the backend gate checks both ends
    # of a rename. The grant is what binds, so both mounts are writable
    # and the session is the only thing narrowing either.
    with Workspace({
            "/rw/": RAMResource(),
            "/ro/": RAMResource()
    },
                   mode=MountMode.WRITE) as ws:
        await ws.execute("ln -s t /rw/lk")
        sess = ws.create_session("agent",
                                 mounts={
                                     "/rw/": "write",
                                     "/ro/": "read"
                                 })
        token = set_current_session(sess)
        try:
            with pytest.raises(ReadOnlyError) as exc:
                await ws.dispatch("rename",
                                  PathSpec.from_str_path("/rw/lk"),
                                  dst=PathSpec.from_str_path("/ro/lk"))
            assert exc.value.filename == "/ro/lk"
        finally:
            reset_current_session(token)
        assert ws._namespace.is_link("/rw/lk")


@pytest.mark.asyncio
@pytest.mark.parametrize("occupied",
                         ["/ram/a.txt", "/ram/d", "/ram/link", "/ram"])
async def test_symlink_refuses_an_occupied_name(occupied):
    # symlink(2) is EEXIST on a name that is taken, and only the door can
    # tell: a file and a directory are the backend's, a link is the node
    # table's, and a mount root is the registry's. Unchecked, the node
    # went on top and buried whatever was there.
    with Workspace({"/ram/": RAMResource()}, mode=MountMode.WRITE) as ws:
        await ws.execute("echo hi > /ram/a.txt; mkdir /ram/d")
        await ws.execute("ln -s a.txt /ram/link")
        with pytest.raises(FileExistsError):
            await ws.dispatch("symlink",
                              PathSpec.from_str_path(occupied),
                              target="elsewhere")
        assert (await ws.execute("cat /ram/a.txt")).stdout == b"hi\n"


@pytest.mark.asyncio
async def test_the_remnant_channel_invalidates_each_deletion():
    # The cascade's execute_op calls run outside the cache-manager
    # context command execution establishes, so the channel discharges
    # the dispatcher's write invalidation itself, per deletion, and
    # holds each deletion to the pre-ops admission with its own child
    # path; the dispatch-level invalidation of the rmdir target covers
    # only the root and its ancestors. Reads stay gate- and
    # invalidation-free, and a failing deletion still invalidates: a
    # missing-path failure means the tree changed under the walk, and
    # the walk's own earlier listing must not survive it.
    mount = MagicMock()
    mount.execute_op = AsyncMock(return_value=["h"])
    seen: list[str] = []
    admitted: list[tuple[str, str]] = []

    async def admit(op: str, spec: PathSpec) -> None:
        admitted.append((op, spec.virtual))

    async def invalidate(spec: PathSpec) -> None:
        seen.append(spec.virtual)

    channel = _MountChannel(mount, admit, invalidate)
    await channel.readdir(_path("/data/d"))
    await channel.stat(_path("/data/d/h"))
    assert seen == []
    assert admitted == []
    await channel.unlink(_path("/data/d/h"))
    await channel.rmdir(_path("/data/d"))
    assert seen == ["/data/d/h", "/data/d"]
    assert admitted == [("unlink", "/data/d/h"), ("rmdir", "/data/d")]
    mount.execute_op = AsyncMock(side_effect=FileNotFoundError("/data/d/h"))
    with pytest.raises(FileNotFoundError):
        await channel.unlink(_path("/data/d/h"))
    assert seen == ["/data/d/h", "/data/d", "/data/d/h"]


@pytest.mark.asyncio
async def test_ops_rmdir_cascade_invalidates_each_remnant(monkeypatch):
    # A direct dispatcher caller (FUSE, ws.fs) establishes no
    # cache-manager context, so the cores' own invalidation cannot land
    # during the remnant cascade; every deletion must reach the
    # dispatcher's write invalidation, not only the rmdir target, or
    # the cached listings and bodies below the directory survive its
    # deletion.
    ws = Workspace({"/a": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute("mkdir -p /a/d/sec && printf 'k\\n' > /a/d/sec/k")
    assert io.exit_code == 0, io.stderr
    sess = ws.create_session("rev", profile={"paths": {"hide": ["/a/d/sec"]}})
    recorded: list[str] = []
    real = Dispatcher.invalidate_after_write

    async def spy(self, mount, path, observed=None):
        recorded.append(path.virtual)
        await real(self, mount, path, observed=observed)

    monkeypatch.setattr(Dispatcher, "invalidate_after_write", spy)
    token = set_current_session(sess)
    try:
        await ws.fs.rmdir("/a/d")
    finally:
        reset_current_session(token)
    assert "/a/d/sec/k" in recorded
    assert "/a/d/sec" in recorded
    assert "/a/d" in recorded
    gone = await ws.execute("test -e /a/d")
    assert gone.exit_code == 1


@pytest.mark.asyncio
async def test_a_policy_denied_remnant_keeps_the_refusal():
    # The gate that admitted the rmdir judged the directory; each
    # cascade deletion answers pre_ops with its own child path, so a
    # policy that protects the hidden file refuses its unlink, the
    # cascade folds the denial into the original not-empty refusal,
    # and the protected content survives.
    ws = Workspace({"/a": RAMResource()},
                   mode=MountMode.WRITE,
                   policies=[DenyRemnantUnlink()])
    io = await ws.execute("mkdir -p /a/d/sec && printf 'k\\n' > /a/d/sec/k")
    assert io.exit_code == 0, io.stderr
    sess = ws.create_session("rev", profile={"paths": {"hide": ["/a/d/sec"]}})
    token = set_current_session(sess)
    try:
        with pytest.raises(OSError) as exc:
            await ws.fs.rmdir("/a/d")
    finally:
        reset_current_session(token)
    assert exc.value.errno in (errno.ENOTEMPTY, errno.EEXIST)
    kept = await ws.execute("cat /a/d/sec/k")
    assert (kept.stdout or b"") == b"k\n"


@pytest.mark.asyncio
async def test_ops_rmdir_takes_hidden_namespace_links_with_it():
    # A hidden link is invisible to every backend, so the cascade walk
    # cannot take it; left in the node table it synthesizes /a/d right
    # back once the hide lifts, resurfacing the removed tree.
    ws = Workspace({"/a": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute("mkdir -p /a/d/sec && printf 'k\\n' > /a/d/sec/k"
                          " && ln -s /a/t /a/d/lnk")
    assert io.exit_code == 0, io.stderr
    sess = ws.create_session(
        "rev", profile={"paths": {
            "hide": ["/a/d/sec", "/a/d/lnk"]
        }})
    token = set_current_session(sess)
    try:
        await ws.fs.rmdir("/a/d")
    finally:
        reset_current_session(token)
    # No session, no hides: the tree must be gone, link included.
    linkless = await ws.execute("readlink /a/d/lnk")
    assert linkless.exit_code != 0
    gone = await ws.execute("test -e /a/d")
    assert gone.exit_code == 1


@pytest.mark.asyncio
async def test_a_visible_link_below_keeps_the_rmdir_refusal():
    # A visible link joins the merged emptiness judgment, so the
    # refusal stands and nothing (backend remnant or node table) is
    # destroyed.
    ws = Workspace({"/a": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute("mkdir -p /a/d/sec && printf 'k\\n' > /a/d/sec/k"
                          " && ln -s /a/t /a/d/lnk")
    assert io.exit_code == 0, io.stderr
    sess = ws.create_session("rev", profile={"paths": {"hide": ["/a/d/sec"]}})
    token = set_current_session(sess)
    try:
        with pytest.raises(OSError) as exc:
            await ws.fs.rmdir("/a/d")
    finally:
        reset_current_session(token)
    assert exc.value.errno in (errno.ENOTEMPTY, errno.EEXIST)
    kept = await ws.execute("cat /a/d/sec/k")
    assert (kept.stdout or b"") == b"k\n"
    link = await ws.execute("readlink /a/d/lnk")
    assert link.exit_code == 0


@pytest.mark.asyncio
async def test_a_non_oserror_cascade_failure_keeps_the_refusal(monkeypatch):
    # An API backend's failure is not always an errno (box raises its
    # own error type); a raw backend exception escaping the fold would
    # reveal exactly what the refusal exists to hide.
    ws = Workspace({"/a": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute("mkdir -p /a/d/sec && printf 'k\\n' > /a/d/sec/k")
    assert io.exit_code == 0, io.stderr
    sess = ws.create_session("rev", profile={"paths": {"hide": ["/a/d/sec"]}})
    real = MountEntry.execute_op

    async def boom(self, op, virtual, **kwargs):
        if op == "unlink" and virtual == "/a/d/sec/k":
            raise RuntimeError("api exploded")
        return await real(self, op, virtual, **kwargs)

    monkeypatch.setattr(MountEntry, "execute_op", boom)
    token = set_current_session(sess)
    try:
        with pytest.raises(OSError) as exc:
            await ws.fs.rmdir("/a/d")
    finally:
        reset_current_session(token)
    assert exc.value.errno in (errno.ENOTEMPTY, errno.EEXIST)
    kept = await ws.execute("cat /a/d/sec/k")
    assert (kept.stdout or b"") == b"k\n"
