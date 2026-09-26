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

import dataclasses
import errno

import pytest

import mirage.commands.builtin.generic_bind.adapter as adapter
from mirage.accessor.base import NOOPAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic_bind.adapter import (CommandIO, Operation,
                                                          dir_aware_stat,
                                                          dir_aware_stream,
                                                          with_dir_guard)
from mirage.commands.config import CommandOpts
from mirage.context import (reset_admission, reset_current_session,
                            reset_mount_gate, reset_op_policies, set_admission,
                            set_current_session, set_mount_gate,
                            set_op_policies)
from mirage.ops.types import NamespaceView
from mirage.policy import Action, Deny, OpsContext, Policy
from mirage.policy.policies import Policies
from mirage.types import (ContentType, FileStat, FileType, HiddenPaths,
                          MountMode, PathSpec, ShowEntry, ShownPaths)
from mirage.utils.errors import OperationNotSupportedError, format_fs_error
from mirage.utils.glob_walk import DEFAULT_MAX_GLOB_MATCHES
from mirage.workspace.session import SessionState

TREE = {
    "/notion/pages": [
        "/notion/pages/Demo_page__uuid1",
        "/notion/pages/Roadmap__uuid2",
    ],
}


async def fake_readdir(accessor, path, index=None):
    key = path.virtual.rstrip("/") or "/"
    if key not in TREE:
        raise FileNotFoundError(key)
    return TREE[key]


def glob_spec(virtual: str, prefix: str) -> PathSpec:
    last_slash = virtual.rfind("/")
    return PathSpec(
        virtual=virtual,
        directory=virtual[:last_slash + 1],
        vfs_path=virtual[len(prefix):].strip("/"),
        pattern=virtual[last_slash + 1:],
        resolved=False,
    )


def make_io(**kwargs) -> CommandIO:
    return CommandIO(readdir=fake_readdir,
                     read_bytes=fake_readdir,
                     read_stream=fake_readdir,
                     stat=fake_readdir,
                     is_mounted=lambda a: True,
                     **kwargs)


def test_command_io_default_glob_cap():
    assert make_io().max_glob_matches == DEFAULT_MAX_GLOB_MATCHES


@pytest.mark.asyncio
async def test_command_io_resolve_glob_binds_readdir():
    resolve = make_io().resolve_glob
    spec = glob_spec("/notion/pages/Demo*", "/notion")
    result = await resolve(NOOPAccessor(), [spec], None)
    assert [p.virtual for p in result] == ["/notion/pages/Demo_page__uuid1"]


@pytest.mark.asyncio
async def test_command_io_resolve_glob_honors_cap():
    resolve = make_io(max_glob_matches=1).resolve_glob
    spec = glob_spec("/notion/pages/*", "/notion")
    result = await resolve(NOOPAccessor(), [spec], None)
    assert len(result) == 1


@pytest.mark.asyncio
async def test_command_io_require_missing_op():
    # A missing op is refused where it is called, not where it is
    # required: a builder binds it up front and a line that never writes
    # never calls it. The refusal names the path the op would have
    # written, a copy's destination included.
    io = make_io()
    src = PathSpec.from_str_path("/a.txt")
    dst = PathSpec.from_str_path("/b.txt")
    with pytest.raises(OperationNotSupportedError) as write_exc:
        await io.require(Operation.WRITE)(NOOPAccessor(), src, b"x")
    assert (write_exc.value.errno, write_exc.value.filename) == (errno.ENOTSUP,
                                                                 "/a.txt")
    with pytest.raises(OperationNotSupportedError) as copy_exc:
        await io.require(Operation.COPY)(NOOPAccessor(), src, dst)
    assert copy_exc.value.filename == "/b.txt"
    assert make_io(write=fake_readdir).require(Operation.WRITE) is fake_readdir


def _probe_ops(missing: set[str],
               implicit_dirs: set[str] | None = None,
               explicit_dirs: set[str] | None = None) -> CommandIO:
    dirs = implicit_dirs or set()
    typed = explicit_dirs or set()

    async def stat(_accessor, path, _index):
        if path.virtual in missing or path.virtual in dirs:
            raise FileNotFoundError(path.virtual)
        if path.virtual in typed:
            return FileStat(name=path.virtual, type=FileType.DIRECTORY)
        return FileStat(type=FileType.FILE, name=path.virtual, size=0)

    async def readdir(_accessor, path, _index):
        target = path.virtual.rstrip("/") or "/"
        entries = [d for d in dirs if (d.rsplit("/", 1)[0] or "/") == target]
        if path.virtual in dirs:
            entries.append(path.virtual.rstrip("/") + "/child.txt")
        return entries

    async def read_stream(_accessor, _path, _index):
        yield b"data"

    async def unused(*_args):
        raise AssertionError("not used")

    return CommandIO(readdir=readdir,
                     read_bytes=unused,
                     read_stream=read_stream,
                     stat=stat,
                     is_mounted=lambda _a: True)


# No namespace facts, which is what a command bound outside a workspace
# gets: only the two probes below the backend can fire.
NO_NS = CommandOpts()


def _ns_dir(directory: str) -> CommandOpts:
    """A bag whose namespace owes one path a child name and nothing else."""

    def child_mounts(parent: str) -> list[str]:
        return ["alpha"] if parent == directory else []

    return CommandOpts(ns=NamespaceView(child_mounts=child_mounts))


@pytest.mark.asyncio
async def test_dir_aware_stat_refuses_a_namespace_only_mount_parent():
    # No backend knows the path: its keys live in a mount nested under it,
    # so neither the stat nor the parent-listing probe can see it, and the
    # name plane is the only thing that can call it a directory.
    stat = dir_aware_stat(_probe_ops({"/ghost"}), None, _ns_dir("/ghost"))
    with pytest.raises(IsADirectoryError):
        await stat(PathSpec.from_str_path("/ghost"))


@pytest.mark.asyncio
async def test_dir_aware_stat_keeps_enoent_when_the_namespace_agrees():
    stat = dir_aware_stat(_probe_ops({"/ghost"}), None, _ns_dir("/elsewhere"))
    with pytest.raises(FileNotFoundError):
        await stat(PathSpec.from_str_path("/ghost"))


@pytest.mark.asyncio
async def test_dir_aware_stream_refuses_a_namespace_only_mount_parent():
    read = dir_aware_stream(_probe_ops({"/ghost"}), None, _ns_dir("/ghost"))
    with pytest.raises(IsADirectoryError):
        async for _ in read(PathSpec.from_str_path("/ghost")):
            raise AssertionError("no data expected")


@pytest.mark.asyncio
async def test_dir_aware_stat_refines_implicit_dir_to_eisdir():
    stat = dir_aware_stat(_probe_ops(set(), implicit_dirs={"/sub"}), None,
                          NO_NS)
    with pytest.raises(IsADirectoryError):
        await stat(PathSpec.from_str_path("/sub"))


@pytest.mark.asyncio
async def test_dir_aware_stat_refuses_explicit_dirs():
    stat = dir_aware_stat(_probe_ops(set(), explicit_dirs={"/sub"}), None,
                          NO_NS)
    with pytest.raises(IsADirectoryError):
        await stat(PathSpec.from_str_path("/sub"))


@pytest.mark.asyncio
async def test_dir_aware_stat_keeps_enoent_for_missing_files():
    stat = dir_aware_stat(_probe_ops({"/nope.txt"}), None, NO_NS)
    with pytest.raises(FileNotFoundError):
        await stat(PathSpec.from_str_path("/nope.txt"))


@pytest.mark.asyncio
async def test_dir_aware_stat_ignores_fabricated_children():
    # Synthetic hierarchies (postgres schema level) answer a readdir of
    # any missing name with fabricated children; only the parent listing
    # decides, so the original ENOENT stands.

    async def stat(_accessor, path, _index):
        raise FileNotFoundError(path.virtual)

    async def readdir(_accessor, path, _index):
        target = path.virtual.rstrip("/") or "/"
        if target == "/":
            return ["/real.txt"]
        return [f"{target}/tables", f"{target}/views"]

    async def unused(*_args):
        raise AssertionError("not used")

    ops = CommandIO(readdir=readdir,
                    read_bytes=unused,
                    read_stream=unused,
                    stat=stat,
                    is_mounted=lambda _a: True)
    bound = dir_aware_stat(ops, None, NO_NS)
    with pytest.raises(FileNotFoundError):
        await bound(PathSpec.from_str_path("/nope.txt"))


@pytest.mark.asyncio
async def test_dir_aware_stat_probe_swallows_driver_errors():
    # A backend whose readdir raises a non-FS driver error for missing
    # names (lancedb: "Table ... was not found") must not leak it through
    # the probe; the original ENOENT stands.

    async def stat(_accessor, path, _index):
        raise FileNotFoundError(path.virtual)

    async def readdir(_accessor, path, _index):
        raise ValueError("Table 'nope.txt' was not found")

    async def unused(*_args):
        raise AssertionError("not used")

    ops = CommandIO(readdir=readdir,
                    read_bytes=unused,
                    read_stream=unused,
                    stat=stat,
                    is_mounted=lambda _a: True)
    bound = dir_aware_stat(ops, None, NO_NS)
    with pytest.raises(FileNotFoundError):
        await bound(PathSpec.from_str_path("/nope.txt"))


@pytest.mark.asyncio
async def test_dir_aware_stream_raises_eisdir_for_dirs():
    read = dir_aware_stream(_probe_ops(set(), implicit_dirs={"/sub"}), None,
                            NO_NS)
    with pytest.raises(IsADirectoryError):
        async for _ in read(PathSpec.from_str_path("/sub")):
            raise AssertionError("no data expected")


@pytest.mark.asyncio
async def test_dir_aware_stream_streams_files():
    read = dir_aware_stream(_probe_ops(set()), None, NO_NS)
    chunks = [c async for c in read(PathSpec.from_str_path("/f.txt"))]
    assert chunks == [b"data"]


class _Gate:
    """An EntryGate that refuses one path and remembers what it was asked."""

    def __init__(self, refused: str) -> None:
        self.scoped = True
        self.refused = refused
        self.asked: list[str] = []

    def check(self, virtual: str) -> None:
        self.asked.append(virtual)
        if virtual == self.refused:
            raise PermissionError(virtual)


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    vfs_path=virtual,
                    resolved=True)


@pytest.mark.asyncio
async def test_rule_guard_asks_the_bound_gate_and_leaves_stat_alone():
    from mirage.commands.builtin.generic_bind.adapter import with_rule_guard
    from mirage.context import reset_admission, set_admission
    calls: list[tuple[str, ...]] = []

    async def read_bytes(accessor, path, index=None):
        calls.append(("read", path.virtual))
        return b"x"

    async def stat(accessor, path, index=None):
        calls.append(("stat", path.virtual))
        return FileStat(name="k",
                        type=FileType.FILE,
                        content=ContentType.TEXT,
                        size=1)

    async def readdir(accessor, path, index=None):
        calls.append(("readdir", path.virtual))
        return ["/data/locked/y"]

    async def rename(accessor, src, dst):
        calls.append(("rename", src.virtual, dst.virtual))

    ops = with_rule_guard(
        CommandIO(readdir=readdir,
                  read_bytes=read_bytes,
                  read_stream=read_bytes,
                  stat=stat,
                  is_mounted=lambda a: True,
                  rename=rename))
    acc = NOOPAccessor()
    # No gate bound: every slot runs as is.
    assert await ops.read_bytes(acc, _spec("/data/locked/y")) == b"x"
    gate = _Gate(refused="/data/locked/y")
    token = set_admission(gate)
    try:
        with pytest.raises(PermissionError):
            await ops.read_bytes(acc, _spec("/data/locked/y"))
        # stat is not a guarded slot: deny is present and refused.
        assert (await ops.stat(acc, _spec("/data/locked/y"))).size == 1
        # readdir asks about the directory, never filters its names.
        assert await ops.readdir(acc,
                                 _spec("/data/locked")) == ["/data/locked/y"]
        # A pair op asks about both paths.
        with pytest.raises(PermissionError):
            await ops.rename(acc, _spec("/data/a"), _spec("/data/locked/y"))
        await ops.rename(acc, _spec("/data/a"), _spec("/data/b"))
    finally:
        reset_admission(token)
    assert gate.asked == [
        "/data/locked/y", "/data/locked", "/data/a", "/data/locked/y",
        "/data/a", "/data/b"
    ]
    assert ("read", "/data/locked/y") in calls
    assert ("rename", "/data/a", "/data/locked/y") not in calls
    assert ("rename", "/data/a", "/data/b") in calls


class _SealedRead(Policy):
    """Refuse reads of one path; record every op asked."""

    def __init__(self, sealed: str) -> None:
        self.sealed = sealed
        self.asked: list[tuple[str, str, bool]] = []

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        self.asked.append((ctx.op, ctx.path.virtual, ctx.write))
        if not ctx.write and ctx.path.virtual == self.sealed:
            return Deny("sealed")
        return None


def _policy_probe_ops(calls: list[tuple[str, ...]]) -> CommandIO:
    """A CommandIO whose slots record their calls; closures on `calls`."""

    async def read_bytes(accessor, path, index=None):
        calls.append(("read", path.virtual))
        return b"x"

    def read_stream(accessor, path, index=None):
        return _probe_chunks(calls, path)

    async def stat(accessor, path, index=None):
        calls.append(("stat", path.virtual))
        return FileStat(name="k",
                        type=FileType.FILE,
                        content=ContentType.TEXT,
                        size=1)

    async def readdir(accessor, path, index=None):
        calls.append(("readdir", path.virtual))
        return ["a"]

    async def copy(accessor, src, dst):
        calls.append(("copy", src.virtual, dst.virtual))

    async def unlink(accessor, path, index=None):
        calls.append(("unlink", path.virtual))

    return CommandIO(readdir=readdir,
                     read_bytes=read_bytes,
                     read_stream=read_stream,
                     stat=stat,
                     is_mounted=lambda a: True,
                     copy=copy,
                     unlink=unlink)


async def _probe_chunks(calls: list[tuple[str, ...]], path: PathSpec):
    calls.append(("stream", path.virtual))
    yield b"x"


@pytest.mark.asyncio
async def test_policy_guard_admits_slots_and_leaves_stat_alone():
    from mirage.commands.builtin.generic_bind.adapter import with_policy_guard
    from mirage.context import (reset_mount_gate, reset_op_policies,
                                set_mount_gate, set_op_policies)
    from mirage.policy.policies import Policies
    from mirage.types import MountMode

    calls: list[tuple[str, ...]] = []
    raw = _policy_probe_ops(calls)
    acc = NOOPAccessor()
    # No binding: every slot runs as is, and no hook fires.
    assert await with_policy_guard(raw).read_bytes(
        acc, _spec("/data/secret")) == b"x"
    calls.clear()

    policy = _SealedRead("/data/secret")
    ptoken = set_op_policies(Policies([policy]))
    gtoken = set_mount_gate("/data", MountMode.WRITE)
    try:
        ops = with_policy_guard(raw)
        with pytest.raises(PermissionError) as excinfo:
            await ops.read_bytes(acc, _spec("/data/secret"))
        assert excinfo.value.errno == errno.EACCES
        assert ("read", "/data/secret") not in calls
        # The stream gates before its first chunk.
        with pytest.raises(PermissionError):
            async for _ in ops.read_stream(acc, _spec("/data/secret")):
                pass
        assert ("stream", "/data/secret") not in calls
        # stat is not a guarded slot: deny is present and refused.
        assert (await ops.stat(acc, _spec("/data/secret"))).size == 1
        # readdir asks about the directory it lists.
        assert await ops.readdir(acc, _spec("/data/dir")) == ["a"]
        # A copy's source is a read; its destination is a write.
        await ops.copy(acc, _spec("/data/src"), _spec("/data/dst"))
        # A write slot asks with write=True.
        await ops.unlink(acc, _spec("/data/gone"))
    finally:
        reset_mount_gate(gtoken)
        reset_op_policies(ptoken)
    assert ("read_bytes", "/data/secret", False) in policy.asked
    assert ("read_stream", "/data/secret", False) in policy.asked
    assert ("readdir", "/data/dir", False) in policy.asked
    assert ("copy", "/data/src", False) in policy.asked
    assert ("copy", "/data/dst", True) in policy.asked
    assert ("unlink", "/data/gone", True) in policy.asked
    assert not any(op == "stat" for op, _, _ in policy.asked)


@pytest.mark.asyncio
async def test_policy_guard_wrap_time_capture_covers_late_drains():
    # head/tail/wc bind lazy readers the pipeline drains after dispatch
    # has reset the context; the guard captured at wrap time still
    # answers (_live_policy_scope).
    from mirage.commands.builtin.generic_bind.adapter import with_policy_guard
    from mirage.context import (reset_mount_gate, reset_op_policies,
                                set_mount_gate, set_op_policies)
    from mirage.policy.policies import Policies
    from mirage.types import MountMode

    calls: list[tuple[str, ...]] = []
    raw = _policy_probe_ops(calls)
    acc = NOOPAccessor()
    policy = _SealedRead("/data/secret")
    ptoken = set_op_policies(Policies([policy]))
    gtoken = set_mount_gate("/data", MountMode.WRITE)
    try:
        ops = with_policy_guard(raw)
    finally:
        reset_mount_gate(gtoken)
        reset_op_policies(ptoken)
    # Both the slot call and the drain happen outside the window now.
    with pytest.raises(PermissionError):
        async for _ in ops.read_stream(acc, _spec("/data/secret")):
            pass
    assert ("stream", "/data/secret") not in calls
    with pytest.raises(PermissionError):
        await ops.read_bytes(acc, _spec("/data/secret"))


@pytest.mark.asyncio
async def test_policy_guard_admits_before_a_warm_serve():
    # The guard wraps outside the cache tier (`finish` in the factory),
    # so a warm reader below it never answers a refused read.
    from mirage.commands.builtin.generic_bind.adapter import with_policy_guard
    from mirage.context import (reset_mount_gate, reset_op_policies,
                                set_mount_gate, set_op_policies)
    from mirage.policy.policies import Policies
    from mirage.types import MountMode

    calls: list[tuple[str, ...]] = []
    warm = dataclasses.replace(_policy_probe_ops(calls), read_bytes=_warm_read)
    acc = NOOPAccessor()
    policy = _SealedRead("/data/secret")
    ptoken = set_op_policies(Policies([policy]))
    gtoken = set_mount_gate("/data", MountMode.WRITE)
    try:
        ops = with_policy_guard(warm)
        with pytest.raises(PermissionError):
            await ops.read_bytes(acc, _spec("/data/secret"))
        assert await ops.read_bytes(acc, _spec("/data/open")) == b"warm"
    finally:
        reset_mount_gate(gtoken)
        reset_op_policies(ptoken)


async def _warm_read(accessor, path, index=None):
    return b"warm"


def _keyed_read_ops(implicit_dirs: set[str] | None = None,
                    explicit_dirs: set[str] | None = None,
                    files: dict[str, bytes] | None = None,
                    read_error: type[BaseException] = FileNotFoundError,
                    children: dict[str, list[str]] | None = None) -> CommandIO:
    """A keyed backend: no directory objects, so a read of one misses.

    Reads raise ``read_error`` for anything that is not a stored file,
    which is what RAM/S3/Redis do for a directory (there is no key
    there) and what an sftp read of a directory does with a non-OSError
    (asyncssh SFTPFailure).
    """
    dirs = implicit_dirs or set()
    typed = explicit_dirs or set()
    stored = files or {}
    owed = children or {}

    async def stat(_accessor, path, _index):
        if path.virtual in typed:
            return FileStat(name=path.virtual, type=FileType.DIRECTORY)
        if path.virtual in stored:
            return FileStat(type=FileType.FILE,
                            name=path.virtual,
                            size=len(stored[path.virtual]))
        raise FileNotFoundError(path.virtual)

    async def readdir(_accessor, path, _index):
        target = path.virtual.rstrip("/") or "/"
        entries = [d for d in dirs if (d.rsplit("/", 1)[0] or "/") == target]
        if path.virtual in dirs:
            entries.append(path.virtual.rstrip("/") + "/child.txt")
        return entries

    async def read_bytes(_accessor, path, _index=None, **_kwargs):
        if path.virtual in stored:
            return stored[path.virtual]
        raise read_error(path.virtual)

    async def read_stream(_accessor, path, _index=None, **_kwargs):
        if path.virtual in stored:
            yield stored[path.virtual]
            return
        raise read_error(path.virtual)

    async def read_range(_accessor, path, _index=None, **_kwargs):
        if path.virtual in stored:
            return stored[path.virtual]
        raise read_error(path.virtual)

    return CommandIO(
        readdir=readdir,
        read_bytes=read_bytes,
        read_stream=read_stream,
        read_range=read_range,
        stat=stat,
        is_mounted=lambda _a: True,
        glob_children=(lambda p: owed.get(p, [])) if owed else None)


async def _drain(stream) -> list[bytes]:
    return [chunk async for chunk in stream]


@pytest.mark.asyncio
async def test_dir_guard_refuses_an_explicit_directory_on_every_slot():
    ops = with_dir_guard(_keyed_read_ops(explicit_dirs={"/sub"}))
    path = PathSpec.from_str_path("/sub")
    with pytest.raises(IsADirectoryError):
        await ops.read_bytes(None, path)
    with pytest.raises(IsADirectoryError):
        await ops.read_range(None, path)
    with pytest.raises(IsADirectoryError):
        await _drain(ops.read_stream(None, path))


@pytest.mark.asyncio
async def test_dir_guard_refuses_an_implicit_keyed_directory():
    ops = with_dir_guard(_keyed_read_ops(implicit_dirs={"/sub"}))
    path = PathSpec.from_str_path("/sub")
    with pytest.raises(IsADirectoryError):
        await ops.read_bytes(None, path)
    with pytest.raises(IsADirectoryError):
        await _drain(ops.read_stream(None, path))


@pytest.mark.asyncio
async def test_dir_guard_refuses_a_namespace_only_directory():
    # /a/b holds no key in this backend; it exists because a mount or a
    # link sits under it, which only the namespace can see.
    ops = with_dir_guard(_keyed_read_ops(children={"/a/b": ["inner"]}))
    path = PathSpec.from_str_path("/a/b")
    with pytest.raises(IsADirectoryError):
        await ops.read_bytes(None, path)


@pytest.mark.asyncio
async def test_dir_guard_refines_a_non_oserror_read_failure():
    # An sftp read of a directory raises asyncssh's SFTPFailure, which is
    # not an OSError, so the errno-only path cannot see it. The stat says
    # directory, and that is what decides.
    ops = with_dir_guard(
        _keyed_read_ops(explicit_dirs={"/sub"}, read_error=RuntimeError))
    with pytest.raises(IsADirectoryError):
        await ops.read_bytes(None, PathSpec.from_str_path("/sub"))


@pytest.mark.asyncio
async def test_dir_guard_leaves_a_real_miss_alone():
    ops = with_dir_guard(_keyed_read_ops())
    path = PathSpec.from_str_path("/nope.txt")
    with pytest.raises(FileNotFoundError):
        await ops.read_bytes(None, path)
    with pytest.raises(FileNotFoundError):
        await _drain(ops.read_stream(None, path))


@pytest.mark.asyncio
async def test_dir_guard_reraises_an_unrelated_failure_untouched():
    ops = with_dir_guard(_keyed_read_ops(read_error=PermissionError))
    with pytest.raises(PermissionError):
        await ops.read_bytes(None, PathSpec.from_str_path("/locked.txt"))


@pytest.mark.asyncio
async def test_dir_guard_leaves_a_successful_read_alone():
    ops = with_dir_guard(_keyed_read_ops(files={"/f.txt": b"data"}))
    path = PathSpec.from_str_path("/f.txt")
    assert await ops.read_bytes(None, path) == b"data"
    assert await _drain(ops.read_stream(None, path)) == [b"data"]
    assert await ops.read_range(None, path) == b"data"


@pytest.mark.asyncio
async def test_dir_guard_names_the_virtual_path_not_the_backend_one():
    # A raw disk error names the host path; the refusal is built from the
    # operand's own PathSpec so the mount's host root never leaks.
    ops = with_dir_guard(
        _keyed_read_ops(
            explicit_dirs={"/mnt/sub"},
            read_error=lambda _p: IsADirectoryError("/private/var/host/sub")))
    with pytest.raises(IsADirectoryError) as caught:
        await ops.read_bytes(None, PathSpec.from_str_path("/mnt/sub"))
    assert str(caught.value) == "/mnt/sub"


@pytest.mark.asyncio
async def test_dir_guard_probe_failure_keeps_the_reads_own_error():
    # A probe that blows up is a negative probe. Surfacing it would swap
    # the read's error for one from a call the user never made.
    async def stat(_accessor, _path, _index):
        raise RuntimeError("transport reset")

    async def readdir(_accessor, _path, _index):
        raise RuntimeError("transport reset")

    async def read_bytes(_accessor, path, _index=None, **_kwargs):
        raise PermissionError(path.virtual)

    async def unused(*_args):
        raise AssertionError("not used")

    ops = with_dir_guard(
        CommandIO(readdir=readdir,
                  read_bytes=read_bytes,
                  read_stream=unused,
                  stat=stat,
                  is_mounted=lambda _a: True))
    with pytest.raises(PermissionError):
        await ops.read_bytes(None, PathSpec.from_str_path("/locked.txt"))


@pytest.mark.asyncio
async def test_dir_guard_keeps_a_refusal_on_a_file_the_parent_lists():
    # A rule guard refuses the read of a real file. Its parent's listing
    # names it, so the implicit-directory probe would answer "directory"
    # if it were consulted, and `grep -r` reported EISDIR where GNU
    # reports the refusal. A stat that answered has already settled it.
    async def stat(_accessor, path, _index):
        return FileStat(type=FileType.FILE, name=path.virtual, size=1)

    async def readdir(_accessor, path, _index):
        return [path.virtual.rstrip("/") + "/a"]

    async def read_bytes(_accessor, path, _index=None, **_kwargs):
        raise PermissionError(path.virtual)

    async def unused(*_args):
        raise AssertionError("not used")

    ops = with_dir_guard(
        CommandIO(readdir=readdir,
                  read_bytes=read_bytes,
                  read_stream=unused,
                  stat=stat,
                  is_mounted=lambda _a: True))
    with pytest.raises(PermissionError):
        await ops.read_bytes(None, PathSpec.from_str_path("/asked/a"))


@pytest.mark.asyncio
async def test_guarded_rmdir_threads_the_index_to_the_fallback_listing(
        monkeypatch):
    # The remnant fallback lists the refused directory raw; on an
    # indexed backend those listings only resolve through the
    # invocation's index, so the wrapper must hand it on rather than
    # falling back to NULL_INDEX — to the classification readdir and to
    # every listing the shared cascade walk takes after it.
    marker = IndexCacheStore()
    seen: list[IndexCacheStore | None] = []
    removed: list[tuple[str, str]] = []
    files = {"/m/d/h"}

    async def rmdir(_accessor, path, index=None):
        if files:
            raise OSError(errno.ENOTEMPTY, "not empty")
        removed.append(("rmdir", path.virtual))

    async def readdir(_accessor, _path, index=None):
        seen.append(index)
        return ["h"] if files else []

    async def stat_fn(_accessor, path, index=None):
        if path.virtual in files:
            return FileStat(type=FileType.FILE, name=path.virtual)
        raise FileNotFoundError(path.virtual)

    async def unlink(_accessor, path):
        files.discard(path.virtual)
        removed.append(("unlink", path.virtual))

    monkeypatch.setattr(adapter, "hidden_paths_intersect", lambda _v: True)
    monkeypatch.setattr(adapter, "path_allowed", lambda v: v == "/m/d")
    spec = PathSpec(virtual="/m/d", directory="/m", vfs_path="d")
    await adapter._guarded_rmdir(rmdir,
                                 readdir,
                                 stat_fn,
                                 unlink,
                                 None,
                                 NOOPAccessor(),
                                 spec,
                                 index=marker)
    assert seen == [marker, marker]
    assert removed == [("unlink", "/m/d/h"), ("rmdir", "/m/d")]


@pytest.mark.asyncio
async def test_guarded_rmdir_answers_a_cascade_failure_with_the_refusal(
        monkeypatch):
    # A deletion the channel refuses (a mode-protected entry) must
    # surface as the backend's own not-empty refusal, never as the
    # cascade's error: the session was told the directory is empty, and
    # the protected content stays.
    async def rmdir(_accessor, _path, index=None):
        raise OSError(errno.ENOTEMPTY, "not empty")

    async def readdir(_accessor, _path, index=None):
        return ["h"]

    async def stat_fn(_accessor, path, index=None):
        return FileStat(type=FileType.FILE, name=path.virtual)

    async def unlink(_accessor, path):
        raise PermissionError(errno.EROFS, "Read-only file system",
                              path.virtual)

    monkeypatch.setattr(adapter, "hidden_paths_intersect", lambda _v: True)
    monkeypatch.setattr(adapter, "path_allowed", lambda v: v == "/m/d")
    spec = PathSpec(virtual="/m/d", directory="/m", vfs_path="d")
    with pytest.raises(OSError) as exc:
        await adapter._guarded_rmdir(rmdir, readdir, stat_fn, unlink, None,
                                     NOOPAccessor(), spec)
    assert exc.value.errno == errno.ENOTEMPTY


@pytest.mark.asyncio
async def test_guarded_rmdir_folds_a_non_oserror_cascade_failure(monkeypatch):
    # An API backend's failure is not always an errno (box raises its
    # own error type); a raw backend exception escaping the fold would
    # reveal exactly what the refusal exists to hide.
    async def rmdir(_accessor, _path, index=None):
        raise OSError(errno.ENOTEMPTY, "not empty")

    async def readdir(_accessor, _path, index=None):
        return ["h"]

    async def stat_fn(_accessor, path, index=None):
        return FileStat(type=FileType.FILE, name=path.virtual)

    async def unlink(_accessor, _path):
        raise RuntimeError("api exploded")

    monkeypatch.setattr(adapter, "hidden_paths_intersect", lambda _v: True)
    monkeypatch.setattr(adapter, "path_allowed", lambda v: v == "/m/d")
    spec = PathSpec(virtual="/m/d", directory="/m", vfs_path="d")
    with pytest.raises(OSError) as exc:
        await adapter._guarded_rmdir(rmdir, readdir, stat_fn, unlink, None,
                                     NOOPAccessor(), spec)
    assert exc.value.errno == errno.ENOTEMPTY


@pytest.mark.asyncio
async def test_guarded_rmdir_folds_a_failed_fallback_listing(monkeypatch):
    # A backend that cannot list the remnants keeps the original
    # refusal, whatever error type it failed with, exactly as the ops
    # plane answers.
    async def rmdir(_accessor, _path, index=None):
        raise OSError(errno.ENOTEMPTY, "not empty")

    async def readdir(_accessor, _path, index=None):
        raise RuntimeError("api exploded")

    async def stat_fn(_accessor, path, index=None):
        return FileStat(type=FileType.FILE, name=path.virtual)

    async def unlink(_accessor, _path):
        raise AssertionError("never reached")

    monkeypatch.setattr(adapter, "hidden_paths_intersect", lambda _v: True)
    monkeypatch.setattr(adapter, "path_allowed", lambda v: v == "/m/d")
    spec = PathSpec(virtual="/m/d", directory="/m", vfs_path="d")
    with pytest.raises(OSError) as exc:
        await adapter._guarded_rmdir(rmdir, readdir, stat_fn, unlink, None,
                                     NOOPAccessor(), spec)
    assert exc.value.errno == errno.ENOTEMPTY


@pytest.mark.asyncio
async def test_guarded_rmdir_counts_a_visible_mounted_child_as_content(
        monkeypatch):
    # The backend listing holds only hidden entries, but the namespace
    # owes the directory a visible mounted child no backend can list.
    # The children fact joins the emptiness judgment, so the refusal
    # stays and the cascade never starts.
    removed: list[str] = []

    async def rmdir(_accessor, _path, index=None):
        raise OSError(errno.ENOTEMPTY, "not empty")

    async def readdir(_accessor, _path, index=None):
        return ["h"]

    async def stat_fn(_accessor, path, index=None):
        return FileStat(type=FileType.FILE, name=path.virtual)

    async def unlink(_accessor, path):
        removed.append(path.virtual)

    monkeypatch.setattr(adapter, "hidden_paths_intersect", lambda _v: True)
    monkeypatch.setattr(adapter, "path_allowed", lambda v: v in
                        ("/m/d", "/m/d/m"))
    spec = PathSpec(virtual="/m/d", directory="/m", vfs_path="d")
    with pytest.raises(OSError) as exc:
        await adapter._guarded_rmdir(rmdir, readdir, stat_fn, unlink,
                                     lambda _v: ["m"], NOOPAccessor(), spec)
    assert exc.value.errno == errno.ENOTEMPTY
    assert removed == []


@pytest.mark.asyncio
async def test_hidden_guard_rmdir_reads_the_stamped_children(monkeypatch):
    # The guard is applied over an adapter already stamped with the
    # invocation's glob_children (the factory's per-invocation order),
    # so a visible mounted child joins its emptiness judgment and the
    # builder keeps calling ops.rmdir unchanged.
    removed: list[str] = []

    async def rmdir(_accessor, _path, index=None):
        raise OSError(errno.ENOTEMPTY, "not empty")

    async def readdir(_accessor, _path, index=None):
        return ["h"]

    async def stat_fn(_accessor, path, index=None):
        return FileStat(type=FileType.FILE, name=path.virtual)

    async def unlink(_accessor, path):
        removed.append(path.virtual)

    async def unused(*_args):
        raise AssertionError("not used")

    monkeypatch.setattr(adapter, "hidden_paths_intersect", lambda _v: True)
    monkeypatch.setattr(adapter, "path_allowed", lambda v: v in
                        ("/m/d", "/m/d/m"))
    base = CommandIO(readdir=readdir,
                     read_bytes=unused,
                     read_stream=unused,
                     stat=stat_fn,
                     is_mounted=lambda _a: True,
                     unlink=unlink,
                     rmdir=rmdir,
                     glob_children=lambda _v: ["m"])
    ops = adapter.with_hidden_guard(base)
    assert ops.rmdir is not None
    spec = PathSpec(virtual="/m/d", directory="/m", vfs_path="d")
    with pytest.raises(OSError) as exc:
        await ops.rmdir(NOOPAccessor(), spec)
    assert exc.value.errno == errno.ENOTEMPTY
    assert removed == []


def _glob_ops(mounted: bool) -> CommandIO:

    async def readdir(_accessor, path, _index):
        return ["/a.txt", "/b.txt"]

    async def unused(*_args):
        raise AssertionError("not used")

    return CommandIO(readdir=readdir,
                     read_bytes=unused,
                     read_stream=unused,
                     stat=unused,
                     is_mounted=lambda _a: mounted)


@pytest.mark.asyncio
async def test_resolve_or_empty_expands_globs():
    spec = PathSpec(virtual="/*.txt",
                    directory="/",
                    vfs_path="*.txt",
                    pattern="*.txt",
                    resolved=False)
    resolved = await adapter.resolve_or_empty(_glob_ops(True), None, [spec],
                                              None)
    assert [p.virtual for p in resolved] == ["/a.txt", "/b.txt"]


@pytest.mark.asyncio
async def test_resolve_or_empty_unmounted_means_stdin_mode():
    resolved = await adapter.resolve_or_empty(
        _glob_ops(False), None, [PathSpec.from_str_path("/a.txt")], None)
    assert resolved == []


@pytest.mark.asyncio
async def test_resolve_or_empty_no_paths():
    assert await adapter.resolve_or_empty(_glob_ops(True), None, [],
                                          None) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("available", [False, True])
@pytest.mark.parametrize("operation", [
    Operation.WRITE, Operation.MKDIR, Operation.UNLINK, Operation.RENAME,
    Operation.COPY, Operation.TRUNCATE
])
@pytest.mark.parametrize("region,expected", [
    ("locked", errno.EROFS),
    ("hidden", errno.ENOENT),
    ("build", errno.ENOTSUP),
])
async def test_capability_and_mode_share_path_guards(available, operation,
                                                     region, expected):
    calls = []

    async def backend(*args, **kwargs):
        calls.append(args)

    session = SessionState(
        session_id="guard-matrix",
        mount_modes={"/data": MountMode.READ},
        hidden_paths=HiddenPaths(paths=("/data/hidden", )),
        shown_paths=ShownPaths(
            entries=(ShowEntry("/data/build", MountMode.WRITE), )))
    st = set_current_session(session)
    mt = set_mount_gate("/data", MountMode.WRITE)
    try:
        ops = adapter.with_policy_guard(
            adapter.with_path_guards(
                make_io(**{operation.value: backend} if available else {})))
        path = _spec(f"/data/{region}/f")
        args = [NOOPAccessor(), path]
        if operation in (Operation.COPY, Operation.RENAME):
            args = [NOOPAccessor(), _spec("/data/build/src"), path]
        if available and region == "build":
            await ops.require(operation)(*args)
            assert len(calls) == 1
        else:
            with pytest.raises(OSError) as error:
                await ops.require(operation)(*args)
            assert error.value.errno == expected
            named = path
            if operation == Operation.RENAME and region == "build":
                named = args[1]
            assert error.value.filename == named.virtual
            if expected == errno.EROFS:
                assert format_fs_error("probe", error.value) == (
                    f"probe: {path.virtual}: Read-only file system\n"
                ).encode()
            assert calls == []
    finally:
        reset_mount_gate(mt)
        reset_current_session(st)


@pytest.mark.asyncio
@pytest.mark.parametrize("available", [False, True])
async def test_copy_reads_source_but_rename_mutates_source_and_subtrees(
        available):
    calls = []

    async def backend(*args, **kwargs):
        calls.append(args)

    session = SessionState(
        session_id="pair-guards",
        shown_paths=ShownPaths(
            entries=(ShowEntry("/data/src", MountMode.READ),
                     ShowEntry("/data/tree/locked", MountMode.READ))))
    st = set_current_session(session)
    mt = set_mount_gate("/data", MountMode.WRITE)
    try:
        ops = adapter.with_path_guards(
            make_io(**{
                "copy": backend,
                "rename": backend
            } if available else {}))
        src, dst = _spec("/data/src"), _spec("/data/dst")
        if available:
            await ops.require(Operation.COPY)(NOOPAccessor(), src, dst)
        else:
            with pytest.raises(OperationNotSupportedError) as error:
                await ops.require(Operation.COPY)(NOOPAccessor(), src, dst)
            assert error.value.filename == dst.virtual
        for source, blame in [(src, src.virtual),
                              (_spec("/data/tree"), "/data/tree/locked")]:
            with pytest.raises(OSError) as error:
                await ops.require(Operation.RENAME)(NOOPAccessor(), source,
                                                    dst)
            assert (error.value.errno, error.value.filename) == (errno.EROFS,
                                                                 blame)
        assert len(calls) == int(available)
    finally:
        reset_mount_gate(mt)
        reset_current_session(st)


@pytest.mark.asyncio
async def test_missing_capability_obeys_rule_before_mode():
    path = _spec("/data/locked")
    gate = _Gate(path.virtual)
    at = set_admission(gate)
    mt = set_mount_gate("/data", MountMode.READ)
    try:
        with pytest.raises(PermissionError) as error:
            await make_io().require(Operation.WRITE)(NOOPAccessor(), path,
                                                     b"x")
        assert error.value.errno is None
        assert gate.asked == [path.virtual]
    finally:
        reset_mount_gate(mt)
        reset_admission(at)


@pytest.mark.asyncio
async def test_missing_copy_admits_source_as_read_before_capability_failure():
    policy = _SealedRead("/data/secret")
    token = set_op_policies(Policies([policy]))
    try:
        with pytest.raises(PermissionError) as error:
            await make_io().require(Operation.COPY)(NOOPAccessor(),
                                                    _spec("/data/secret"),
                                                    _spec("/data/dst"))
        assert error.value.errno == errno.EACCES
        assert policy.asked == [("copy", "/data/secret", False)]
    finally:
        reset_op_policies(token)
