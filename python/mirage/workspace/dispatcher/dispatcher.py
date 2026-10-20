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
import functools
import logging
import posixpath
import time
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Collection,
    Mapping,
)
from contextlib import AbstractAsyncContextManager, AsyncExitStack
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from mirage.cache.file import io as cache_io
from mirage.cache.index.ram import ListingCheckStore
from mirage.cache.lock import KeyLock
from mirage.cache.manager import CacheManager
from mirage.commands.builtin.utils.limit import run_with_timeout
from mirage.commands.builtin.utils.paths import (
    dot_refusal,
    hidden_walk,
    read_hit_a_dir,
    walk_spelling,
)
from mirage.context import (
    Caller,
    bind_caller,
    current_caller,
    hidden_refusal,
    reset_caller,
)
from mirage.context.session_context import (
    effective_path_mode,
    session_access,
)
from mirage.errors.constants import MISS_ERRORS
from mirage.errors.fs import (
    eacces,
    eexist,
    einval,
    eisdir,
    eloop,
    enoent,
    enotdir,
    enotempty,
    enotsup,
    erofs,
    exdev,
    no_mount,
    no_xattr,
    walk_declined,
    walk_refusal,
)
from mirage.io import IOResult, OpReport
from mirage.io.stream import close_quietly
from mirage.io.types import PipeStream
from mirage.observe.context import (
    RecordingScope,
    active_lost,
    active_recorder,
    command_records,
    record,
    start_op,
)
from mirage.observe.record import (
    RETRACT_FINGERPRINT_OPS,
    WRITE_FINGERPRINT_OPS,
    OpRecord,
)
from mirage.policy.boundary import Boundary
from mirage.policy.constants import METADATA_OPS
from mirage.policy.errors import PolicyDenied, PolicyError
from mirage.policy.types import EntryGate
from mirage.shell.bytes import encode_text
from mirage.types import (
    DEFAULT_READ_TTL,
    CacheFacts,
    CapacityResult,
    CapacityState,
    FileStat,
    FileType,
    MountMode,
    PathSpec,
    VFSName,
    Visibility,
    WritePolicy,
)
from mirage.utils.filetype import get_extension
from mirage.utils.hidden import (
    hidden_under,
    leads_hidden,
    move_reveals,
    path_visible,
)
from mirage.utils.key_prefix import mount_key, under_path
from mirage.utils.path import (
    CycleError,
    ends_at_dot,
    norm,
    norm_dir,
    owner_prefix,
    parent,
)
from mirage.utils.ranges import slice_window
from mirage.utils.remnants import remove_remnants, visible_below
from mirage.utils.stat_view import ident
from mirage.vfs.call import declared
from mirage.vfs.constants import WRITE_EFFECTS
from mirage.vfs.types import Effect, Target, VfsCall
from mirage.view.namespace_view import (
    merge_readdir,
    namespace_listing,
    namespace_stat,
)
from mirage.workspace.dispatcher.constants import (
    CALLS,
    COPY_OPS,
    DESTINATION_OPS,
    DIRECTORY_OPEN_OPS,
    DISPATCH_READ_OPS,
    DISPATCH_WRITE_OPS,
    ENTRY_CREATE_OPS,
    FILE_CREATE_OPS,
    HIDDEN_CREATE_OPS,
    HIDE_FILTERED_OPS,
    LINK_ENTRY_OPS,
    NAMESPACE_TABLE_OPS,
    NATIVE_WALK_OPS,
    NO_FOLLOW_OPS,
    POLICY_WRITE_OPS,
    READ_AHEAD_BYTES,
    READ_STAND_IN_OPS,
    SERIAL_WRITE_OPS,
    SETATTR_KEYS,
    STAMP_WRITE_OPS,
    XATTR_OPS,
)
from mirage.workspace.dispatcher.stream import (
    _LentPayload,
    _memory_answered,
    _primed,
    _served,
)
from mirage.workspace.mount import MountEntry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.mount.namespace.overlay import merge_overlay_stat
from mirage.workspace.reconcile import Reconciler
from mirage.workspace.snapshot.drift import DriftQueue

logger = logging.getLogger(__name__)


async def _sized(mount: MountEntry, path: PathSpec, row: Any) -> Any:
    """A stat row with the length the file cache holds, when the backend
    named none.

    An API mount cannot size a file without fetching it, so once a read
    kept its bytes, their length is the size, for every caller of the
    dispatcher (a command, ``ws.vfs``, FUSE, a runtime's ``os.stat``). The
    length alone, read without revalidating: it serves no content.

    Args:
        mount (MountEntry): the mount that answered the stat.
        path (PathSpec): the path it answered for.
        row (Any): the stat's answer.
    """
    manager = mount.cache_manager
    if (
        not isinstance(row, FileStat)
        or row.type is not FileType.FILE
        or row.size is not None
        or manager is None
    ):
        return row
    size = await manager.cached_size(path)
    return row if size is None else row.model_copy(update={"size": size})


def _appends_nothing(name: str, kwargs: dict[str, Any]) -> bool:
    """Whether a completed write op was an append of no bytes.

    That is an open for appending (``true >> f``): it may create the
    file, but it leaves an existing one's times as they were.

    Args:
        name (str): the write op that ran.
        kwargs (dict[str, Any]): its kwargs; an append's ``data``.
    """
    return name == "append" and not kwargs.get("data")


async def _mkdir_on_read_only(
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    prefix: str,
    mode: MountMode,
    path: PathSpec,
    parents: bool,
    caller: Caller,
) -> None:
    """Answer a mkdir on a read-only region the way the filesystem would.

    A read-only filesystem refuses only a create it would really make,
    so the answer is whatever the create runs into first, walking the
    components from the mount root: a missing one is refused with EROFS,
    a file in the chain is ENOTDIR, an existing leaf is EEXIST, and
    ``mkdir -p`` of a directory that is already there succeeds. The
    blamed path is the first component that would have been made, as
    GNU's ``mkdir -p`` names it (``'/ro/n'`` for ``/ro/n/m``). Pinned
    against GNU coreutils 9.7 on a read-only tmpfs.

    Args:
        stat (Callable[[PathSpec], Awaitable[FileStat]]): the
            dispatcher's own stat, raising when nothing is there.
        prefix (str): the mount prefix.
        mode (MountMode): the mount's mode.
        path (PathSpec): the directory to make.
        parents (bool): ``-p``.
        caller (Caller): who makes it, whose grants decide the blame.
    """
    base = prefix.rstrip("/")
    leaf = path.virtual.rstrip("/") or "/"
    if leaf != base and not leaf.startswith(base + "/"):
        raise erofs(path.virtual)
    parts = [part for part in leaf[len(base) :].split("/") if part]
    chain = [
        PathSpec.from_str_path(f"{base}/{'/'.join(parts[:depth])}")
        for depth in range(1, len(parts) + 1)
    ]
    for index, component in enumerate(chain):
        try:
            row = await stat(component)
        except FileNotFoundError as exc:
            if not parents and index < len(chain) - 1:
                raise enoent(path) from exc
            blame = next(
                (
                    spec
                    for spec in chain[index:]
                    if effective_path_mode(
                        spec.virtual,
                        prefix,
                        mode,
                        session_access(caller.session),
                    )
                    == MountMode.READ
                ),
                path,
            )
            raise erofs(blame.virtual) from exc
        if row.type is not FileType.DIRECTORY:
            if index == len(chain) - 1:
                raise eexist(path)
            raise enotdir(component if parents else path)
    if not parents:
        raise eexist(path)


def _visible_entries(
    entries: list[str], parent: str, vis: Visibility | None
) -> list[str]:
    """Drop listing entries the bound session hides.

    Entry shapes vary by backend (bare names, trailing-slash names,
    full paths), so each is keyed by its final segment against the
    listed directory, the same normalization ``merge_readdir`` dedups
    by.

    Args:
        entries (list[str]): the merged listing.
        parent (str): the directory that was listed, as a virtual path.
        vis (Visibility | None): the session's view.
    """
    base = parent.rstrip("/")
    return [
        e
        for e in entries
        if path_visible(vis, f"{base}/{e.rstrip('/').rsplit('/', 1)[-1]}")
    ]


def _visible_answer(
    name: str, vis: Visibility | None, path: PathSpec, result: Any
) -> Any:
    """A one-call read's answer without the entries the session hides.

    What the walk the read stands in for would see, since every call it
    makes reads a hidden path as absent: a ``read_tree`` answer keeps the
    entries left visible, keyed below ``path``; ``files_containing``
    keeps the files left visible; ``search`` keeps the records whose
    path is visible.

    Args:
        name (str): the op, one of ``HIDE_FILTERED_OPS``.
        vis (Visibility | None): the session's visibility.
        path (PathSpec): the directory the read answered for.
        result (Any): the backend's answer.
    """
    if name == "read_tree":
        base = path.virtual.rstrip("/")
        return {
            key: st
            for key, st in result.items()
            if path_visible(vis, f"{base}/{key}")
        }
    if name == "files_containing":
        return [hit for hit in result if path_visible(vis, hit.virtual)]
    return [hit for hit in result if path_visible(vis, hit[0])]


def _answer_paths(result: Any) -> list[str] | None:
    """The virtual path each item of a custom function's answer names,
    None when the answer is not a list of paths or of records with a
    ``path`` (an attribute, or a key of a mapping).

    Args:
        result (Any): the function's answer.
    """
    if not isinstance(result, (list, tuple)):
        return None
    named: list[str] = []
    for item in result:
        path: Any
        if isinstance(item, PathSpec):
            path = item
        elif isinstance(item, Mapping):
            path = item.get("path")
        else:
            path = getattr(item, "path", None)
        if not isinstance(path, PathSpec):
            return None
        named.append(path.virtual)
    return named


def _fits_read_ahead(entry: FileStat | None, batched: bool) -> bool:
    """Whether a read-ahead fetches a retained entry: a file its listing
    sizes within ``READ_AHEAD_BYTES``, and where
    the store reads a batch, also a file the listing does not size.

    Args:
        entry (FileStat | None): the retained index row, if any.
        batched (bool): whether the store reads a batch.
    """
    if entry is not None and entry.type is FileType.DIRECTORY:
        return False
    if entry is None or entry.size is None:
        return batched
    return entry.size <= READ_AHEAD_BYTES


async def _answered(
    batch: Awaitable[dict[str, bytes]], virtual: str
) -> bytes | None:
    """The bytes a batch read answered for ``virtual``, None when it left
    the file out.

    Args:
        batch (Awaitable[dict[str, bytes]]): the batch read, shared by
            every file it was asked for.
        virtual (str): the file's virtual path.
    """
    return (await batch).get(virtual)


async def _is_directory(mount: MountEntry, path: PathSpec) -> bool:
    """Whether a scan guard's path is a directory: a file or a missing
    name has nothing below it to scan.

    Args:
        mount (MountEntry): the mount serving the path.
        path (PathSpec): the guard's path.
    """
    try:
        found = await mount.call("stat", path.virtual)
    except (FileNotFoundError, NotADirectoryError) as exc:
        logger.debug("scan guard at %s: %s", path.virtual, exc)
        return False
    return found is not None and found.type is FileType.DIRECTORY


def _record_of(
    records: list[OpRecord], ops: Collection[str], virtual: str
) -> OpRecord | None:
    """The last of a write's records that one of ``ops`` made at
    ``virtual``.

    Args:
        records (list[OpRecord]): the records the write emitted.
        ops (Collection[str]): the op names to look for.
        virtual (str): the path the write ran on.
    """
    return next(
        (
            rec
            for rec in reversed(records)
            if rec.op in ops and rec.path == virtual
        ),
        None,
    )


def _lists(listing: list[str], virtual: str) -> bool:
    """Whether a backend listing holds the final name of `virtual`.

    Compared on the final segment, because backends disagree on entry
    shape: bare names, a trailing slash to mark a directory, or full
    paths. The same normalization ``merge_readdir`` dedupes on.

    Args:
        listing (list[str]): the parent's entries.
        virtual (str): the path whose name to look for.
    """
    name = virtual.rstrip("/").rsplit("/", 1)[-1]
    return any(
        str(entry).rstrip("/").rsplit("/", 1)[-1] == name for entry in listing
    )


def _session_id(caller: Caller) -> str:
    """The id of the session a call acts as, empty for the unbound host
    view; the same session the hides and modes above read.

    Args:
        caller (Caller): who makes the call.
    """
    return caller.session.session_id if caller.session is not None else ""


def _window(kwargs: dict[str, Any]) -> tuple[int, int | None]:
    """The byte window a read asked for, whole file when it asked none.

    Args:
        kwargs (dict[str, Any]): the op's keyword arguments.
    """
    offset = kwargs.get("offset")
    size = kwargs.get("size")
    return (
        offset if isinstance(offset, int) else 0,
        size if isinstance(size, int) else None,
    )


def _whole_read(kwargs: dict[str, Any]) -> dict[str, Any]:
    """A read's keyword arguments with its range dropped: the whole file.

    Args:
        kwargs (dict[str, Any]): the op's keyword arguments.
    """
    return {k: v for k, v in kwargs.items() if k not in ("offset", "size")}


@dataclass(frozen=True, slots=True)
class _MountChannel:
    """The ops plane's remnant channel: every step goes through
    ``Mount.call``, the same entry point a first-class op takes, so the
    mode axis refuses a protected path exactly as normal dispatch
    would. Only the dispatcher's own visibility filter sits above that
    entry point, which is what lets the cascade see hidden entries.

    Each deletion answers the same pre-vfs admission a dispatched op
    answers, with its own child path, and the running command's path
    rules: the gate that admitted the rmdir judged the directory, not
    what the cascade found under it, and a policy or rule that protects
    one of those paths must refuse its deletion exactly as it would
    refuse a first-class op. Each deletion also
    discharges the dispatcher's own write invalidation, the way normal
    dispatch does for its one op and the TS ``fencedCall`` does per
    call: ``call`` runs outside the cache-manager context command
    execution establishes, so the cores' invalidation cannot land, and
    the dispatch-level invalidation of the rmdir target covers the root
    and its ancestors, never the cascade's descendants. Invalidation
    runs even when the op fails: a missing-path failure means the tree
    changed under the walk, and the walk's own earlier listing is
    exactly the entry that must not survive.

    Args:
        mount (MountEntry): the mount owning the subtree.
        boundary (Boundary): the dispatcher's op boundary for that
            mount; its admit raises to refuse a deletion. A deletion is
            not completed through post_vfs, which could only refuse
            after the entry is gone and strand the cascade.
        invalidate (Callable): the dispatcher's write invalidation,
            bound to that mount.
        rule_gate (EntryGate | None): the running command's gate, None
            for a call no command issued.
    """

    mount: MountEntry
    boundary: Boundary
    invalidate: Callable[[PathSpec], Awaitable[None]]
    rule_gate: EntryGate | None

    async def readdir(self, spec: PathSpec) -> list[str]:
        return await self.mount.call("readdir", spec.virtual)

    async def stat(self, spec: PathSpec) -> FileStat:
        return await self.mount.call("stat", spec.virtual)

    async def unlink(self, spec: PathSpec) -> None:
        if self.rule_gate is not None:
            self.rule_gate.check(spec.virtual)
        await self.boundary.admit(
            CALLS["unlink"], spec, True, check_hidden=False
        )
        try:
            await self.mount.call("unlink", spec.virtual)
        finally:
            await self.invalidate(spec)

    async def rmdir(self, spec: PathSpec) -> None:
        if self.rule_gate is not None:
            self.rule_gate.check(spec.virtual)
        await self.boundary.admit(
            CALLS["rmdir"], spec, True, check_hidden=False
        )
        try:
            await self.mount.call("rmdir", spec.virtual)
        finally:
            await self.invalidate(spec)


def _facts_of(mount: MountEntry | None) -> CacheFacts:
    """The cache facts of the mount that owns a path.

    Args:
        mount (MountEntry | None): the owning mount, None when there is
            none (or it is no longer the one the command started with).
    """
    if mount is None or mount.retiring or not mount.vfs.caches_reads:
        return CacheFacts(cacheable=False, ttl=DEFAULT_READ_TTL)
    return CacheFacts(
        cacheable=True,
        ttl=mount.read.ttl,
        keeps_versions=mount.write is WritePolicy.CONDITIONAL,
    )


def _judge(gate: EntryGate, *paths: PathSpec | None) -> None:
    """Ask a command's gate once about each distinct path an op reaches.

    Args:
        gate (EntryGate): the gate the command was admitted under.
        *paths (PathSpec | None): the spellings in the order the dispatcher
            met them; None (no rename destination) is skipped.
    """
    for virtual in dict.fromkeys(
        p.virtual for p in paths if isinstance(p, PathSpec)
    ):
        gate.check(virtual)


def _follow_or_loop(
    namespace: Namespace,
    path: PathSpec,
    last: bool,
    spelled: str | None = None,
) -> str:
    """The dispatcher's link follow of one path, with a loop as ELOOP.

    Args:
        namespace (Namespace): the namespace whose links are followed.
        path (PathSpec): the path the follow answers for.
        last (bool): follow the final name too, not only the names above.
        spelled (str | None): the spelling to follow, ``path.virtual``
            when None.
    """
    virtual = path.virtual if spelled is None else spelled
    try:
        if last:
            return namespace.follow(virtual)
        return namespace.follow_parent(virtual)
    except CycleError:
        raise eloop(path) from None


def _retracted(virtual: str) -> bool:
    """Whether the running line's newest word on ``virtual`` is that a
    change it made took the path's version (a copy, a move, a removal).

    Bytes cached before that change are not served: a later step of the
    same op can still be running, and the path is evicted only once the
    op ends. A read or write since stamps a newer record.

    Args:
        virtual (str): the path read.
    """
    recorder = active_recorder()
    if recorder is None:
        return False
    rec = recorder.index.newest_version(virtual)
    return rec is not None and rec.op in RETRACT_FINGERPRINT_OPS


def _spelled_under(call: "_Call", entries: list[str]) -> list[str]:
    """A listing's names spelled under the directory the caller asked for.

    Listing a link to a directory lists the directory it reaches, and
    readdir names its children under the path it was handed, as a walk
    through the link spells them. A caller that handed the directory the
    link reaches, its typed spelling riding along, asked for that one.

    Args:
        call (_Call): the readdir that ran.
        entries (list[str]): its names, under the followed directory.
    """
    reached = call.path.virtual.rstrip("/")
    if call.walked is None or call.typed.virtual.rstrip("/") == reached:
        return entries
    asked = call.walked.virtual.rstrip("/")
    return [
        asked + entry[len(reached) :]
        if entry.startswith(reached + "/")
        else entry
        for entry in entries
    ]


def _operands(name: str, kwargs: dict[str, Any]) -> list[tuple[str, PathSpec]]:
    """A custom function's other path arguments, by keyword.

    A rename's or a copy's destination is walked on its own and is not
    one.

    Args:
        name (str): the dispatched function name.
        kwargs (dict[str, Any]): its arguments.
    """
    if name in DESTINATION_OPS:
        return []
    return [
        (key, value)
        for key, value in kwargs.items()
        if isinstance(value, PathSpec)
    ]


@dataclass(slots=True)
class _Call:
    """One op on its way through the dispatcher, as the stages hand it on.

    Args:
        name (str): the dispatched op name.
        path (PathSpec): the op's path: walked, then followed.
        typed (PathSpec): the path as the caller named it.
        dst (PathSpec | None): a rename's or a copy's walked
            destination.
        kwargs (dict[str, Any]): the op's arguments, forwarded to the
            backend.
        vis (Visibility | None): the session's view, read once at the
            dispatcher.
        caller (Caller): who makes the op.
        rule_gate (EntryGate | None): the running command's gate.
        report (OpReport | None): the caller's report.
        no_follow (bool): whether the op acts on the final name itself.
        write (bool): whether policy judges the op a write: its POSIX
            name, or the effect the mount's VFS declares for it.
        stream (bool): whether a read is answered as it is pulled.
        direct (bool): whether a read skips the file cache, neither
            served from it nor kept in it.
        warm (bool): whether a read only asks whether the file cache
            holds a copy: True once the caller's rule lets the read
            through, else None; never the bytes, never the backend.
        fresh (bool): whether a stat asks the backend past the mount's
            index, through a throwaway store as a ``read: fresh`` probe
            does, with the index's rows only as hints, and reconciles the
            index and file cache with the answer; it runs under its path's
            writer hold, so no write to the path lands between the two.
        walked (PathSpec | None): the path before a link at its final
            name was followed, the one a listing's names are spelled
            under; None when nothing was followed.
    """

    name: str
    path: PathSpec
    typed: PathSpec
    dst: PathSpec | None
    kwargs: dict[str, Any]
    vis: Visibility | None
    caller: Caller
    rule_gate: EntryGate | None
    report: OpReport | None
    no_follow: bool
    write: bool
    stream: bool = False
    direct: bool = False
    warm: bool = False
    fresh: bool = False
    walked: PathSpec | None = None

    @property
    def window(self) -> tuple[int, int | None]:
        """The byte window a read asked for, whole file when none."""
        return _window(self.kwargs)

    def renders_read(self, mount: MountEntry) -> bool:
        """Whether a filetype renderer answers this read on ``mount``.

        Asked each time, since a renderer can land while the read runs.

        Args:
            mount (MountEntry): the mount serving the path.
        """
        filetype = (
            self.kwargs["filetype"]
            if "filetype" in self.kwargs
            else get_extension(self.path.virtual)
        )
        return mount.renders(filetype)


def _probed(call: _Call, mount: MountEntry) -> FileStat | None:
    """What the freshness probe of the running command got from the
    backend for a stat's path, None when it asked nothing.

    Under ``read: fresh`` the probe already asked the backend about the
    command's operand; asking again resolves through listings the command
    has not re-checked. A stat that asks for what the backend holds now
    (``fresh``) is the probe's own question, so it is asked.

    Args:
        call (_Call): the admitted op.
        mount (MountEntry): the mount serving its path.
    """
    manager = mount.cache_manager
    if call.name != "stat" or call.fresh or manager is None:
        return None
    return manager.probed_stat(call.path)


class Dispatcher:
    """Route a single VFS op to its mount and keep the file cache + index
    consistent.

    Owns the cache/IO coordination that used to live on Workspace: cache
    lookups for read-caching backends, post-write file-cache eviction,
    and parent index invalidation. Constructed with the namespace (for
    addressing), cache store, and consistency policy; holds no other
    workspace state. The snapshot drift queue rides along because this
    is the one dispatcher: a strict restore's pending fingerprint checks must
    run before ANY op can touch a mount, and FUSE and ``ws.vfs``
    reach here without passing Workspace.dispatch. So does the
    workspace's write admission, which holds a write while a capture
    reads.
    """

    def __init__(
        self,
        namespace: Namespace,
        cache,
        drift: DriftQueue | None = None,
        admit_write: Callable[[Caller], AbstractAsyncContextManager[Caller]]
        | None = None,
    ) -> None:
        self._namespace = namespace
        self._cache = cache
        self._reconciler = Reconciler(cache, namespace)
        self._drift = drift
        self._admit_write = admit_write
        self._writers = KeyLock()

    def _boundary(self, mount: MountEntry | None, caller: Caller) -> Boundary:
        """The policy boundary for an op on a path ``mount`` owns.

        The mount's prefix and mode, or for a path above every mount an
        empty prefix and full write, governed by ``/``
        (``MountModePolicy``).

        Args:
            mount (MountEntry | None): the mount owning the path, None
                when no mount does.
            caller (Caller): who makes the op.
        """
        return Boundary(
            self._namespace.registry.policies,
            mount.prefix if mount is not None else "",
            mount.mode if mount is not None else MountMode.WRITE,
            self._namespace.registry.decisions,
            caller,
        )

    @property
    def reconciler(self) -> Reconciler:
        return self._reconciler

    def _namespace_result(
        self, name: str, virtual: str, vis: Visibility | None
    ) -> list[str] | FileStat | None:
        """The namespace's own answer for a path no backend serves.

        Child mounts and symlinks are structure the dispatcher owns, so a
        directory that exists only because a mount or link sits below it
        still lists and stats. None for any other op, or when the
        namespace knows nothing at ``virtual``.

        Args:
            name (str): the dispatched op name.
            virtual (str): the virtual path being answered.
            vis (Visibility | None): the session's view.
        """
        prefixes = [
            m.prefix for m in self._namespace.registry.visible_mounts()
        ]
        if name == "readdir":
            return namespace_listing(vis, prefixes, self._namespace, virtual)
        if name == "stat":
            return namespace_stat(vis, prefixes, self._namespace, virtual)
        return None

    async def _gated_namespace(
        self,
        name: str,
        path: PathSpec,
        fallback: "list[str] | FileStat",
        report: OpReport | None,
        caller: Caller,
    ) -> Any:
        """Gate a namespace-served answer exactly like a backend one.

        The answer has no owning prefix (the gates see ""), but
        admission still fires: a policy that bounds readdir or stat by
        path must cover the synthetic answer too.

        Args:
            name (str): the dispatched op name.
            path (PathSpec): the op's path scope.
            fallback (list[str] | FileStat): the namespace's answer.
            report (OpReport | None): the caller's report, stamped when
                the answer is in hand.
            caller (Caller): who makes the op.
        """
        boundary = self._boundary(None, caller)
        write = name in POLICY_WRITE_OPS
        # A pre gate refuses before the answer exists, so it is not a
        # completed op and stays before the stamp.
        await boundary.admit(CALLS[name], path, write)
        _memory_answered(report)
        if name == "readdir" and isinstance(fallback, list):
            fallback = _visible_entries(
                fallback, path.virtual, caller.visibility
            )
        return await boundary.complete(CALLS[name], path, write, fallback)

    async def dispatch(
        self,
        name: str,
        path: PathSpec,
        /,
        *,
        caller: Caller | None = None,
        report: OpReport | None = None,
        **kwargs: Any,
    ) -> tuple[Any, IOResult]:
        """Run one op as ``caller`` on the mount that serves its path.

        Args:
            name (str): the op.
            path (PathSpec): the path it names.
            caller (Caller | None): who makes the op; None for the caller
                bound here, as a host call outside any line is.
            report (OpReport | None): the caller's report.
            **kwargs (Any): the op's own arguments.
        """
        try:
            if caller is None:
                caller = current_caller()
            if self._admit_write is None or name not in POLICY_WRITE_OPS:
                return await self._bound(name, path, caller, report, kwargs)
            async with self._admit_write(caller) as held:
                return await self._bound(name, path, held, report, kwargs)
        finally:
            if name in ("write", "append"):
                await close_quietly(kwargs.get("data"))

    async def _bound(
        self,
        name: str,
        path: PathSpec,
        caller: Caller,
        report: OpReport | None,
        kwargs: dict[str, Any],
    ) -> tuple[Any, IOResult]:
        """Run one op with ``caller`` bound, so what runs below the
        dispatcher (a policy, a backend's record) reads the caller the
        dispatcher judges by. Its rule gate stays here: a policy's own
        read below is no call of the command's.

        Args:
            name (str): the op.
            path (PathSpec): the path it names.
            caller (Caller): who makes the op.
            report (OpReport | None): the caller's report.
            kwargs (dict[str, Any]): the op's own arguments.
        """
        token = bind_caller(dataclasses.replace(caller, rule_gate=None))
        try:
            if name == "read" and not kwargs.get("warm"):
                return await self._read_refusing_dirs(
                    path, caller, report, kwargs
                )
            return await self._dispatch(
                name, path, caller, report=report, **kwargs
            )
        finally:
            reset_caller(token)

    async def _read_refusing_dirs(
        self,
        path: PathSpec,
        caller: Caller,
        report: OpReport | None,
        kwargs: dict[str, Any],
    ) -> tuple[Any, IOResult]:
        """A read that refuses a directory with GNU's EISDIR, at the path
        it was handed.

        A store answers a read of a directory in its own voice: ENOENT
        from a keyed store, whose directory is a set of keys rather than
        an object, an opaque error from sftp, no bytes from some drivers.
        So a read that fails or answers no bytes asks whether its path is
        a directory (``read_hit_a_dir``), and any other answer stands. A
        stream is judged as it is pulled; a live pipe is no directory.

        Args:
            path (PathSpec): the path as the caller named it.
            caller (Caller): who makes the read.
            report (OpReport | None): the caller's report.
            kwargs (dict[str, Any]): the read's own arguments.
        """
        try:
            data, io = await self._dispatch(
                "read", path, caller, report=report, **kwargs
            )
        except Exception as exc:
            if await self._read_hit_a_dir(path, caller, exc):
                raise eisdir(path) from None
            raise
        if isinstance(data, PipeStream):
            return data, io
        if hasattr(data, "__aiter__"):
            drained = self._drain_refusing_dirs(path, caller, data)
            await anext(drained)
            return drained, io
        if not data and await self._read_hit_a_dir(path, caller, None):
            raise eisdir(path)
        return data, io

    async def _drain_refusing_dirs(
        self, path: PathSpec, caller: Caller, source: AsyncIterator[bytes]
    ) -> AsyncIterator[bytes]:
        """A streamed read that refuses a directory once it fails or
        ends with no bytes.

        Run to its empty first step before it is handed on, as
        ``_primed`` runs a stream, so a caller that closes it before
        pulling still closes the read.

        Args:
            path (PathSpec): the path as the caller named it.
            caller (Caller): who makes the read.
            source (AsyncIterator[bytes]): the read's stream.
        """
        empty = True
        try:
            yield b""
            async for chunk in source:
                empty = empty and not chunk
                yield chunk
        except Exception as exc:
            if await self._read_hit_a_dir(path, caller, exc):
                raise eisdir(path) from None
            raise
        finally:
            await close_quietly(source)
        if empty and await self._read_hit_a_dir(path, caller, None):
            raise eisdir(path)

    async def _read_hit_a_dir(
        self, path: PathSpec, caller: Caller, exc: BaseException | None
    ) -> bool:
        """Whether a read of ``path`` that failed or answered no bytes
        reached a directory, probed as the caller.

        The probes are the dispatcher's own, no call of the command's, so
        its path rules do not judge them; the caller's hides do. A
        policy's refusal is the dispatcher's own answer rather than a
        store's, so it stands, and a dry run asks the gates only, so it
        probes nothing.

        Args:
            path (PathSpec): the path as the caller named it.
            caller (Caller): who made the read.
            exc (BaseException | None): the failure, None for no bytes.
        """
        if caller.explaining is not None or isinstance(
            exc, (PolicyDenied, PolicyError)
        ):
            return False
        # A name the caller cannot see, or one whose walk crosses hidden
        # space, stays missing: probing past it, to its link's target,
        # would tell that it is there.
        vis = caller.visibility
        if not path_visible(vis, path.virtual) or leads_hidden(
            vis, path.virtual, self._namespace.symlink_targets()
        ):
            return False
        prober = dataclasses.replace(caller, rule_gate=None)
        # A read follows a final link, so the kind is its target's, as
        # GNU's cat calls a link to a directory one; the error keeps the
        # name as typed.
        try:
            followed = self._namespace.follow(path.virtual)
        except CycleError:
            return False
        return await read_hit_a_dir(
            functools.partial(self._lstat, prober),
            functools.partial(self._listing, prober),
            (
                path
                if followed == path.virtual
                else PathSpec.from_str_path(followed)
            ),
            exc,
        )

    async def _lstat(self, caller: Caller, path: PathSpec) -> FileStat:
        """The entry at ``path`` itself, as lstat answers; raises when
        nothing is there.

        Args:
            caller (Caller): who asks.
            path (PathSpec): the path.
        """
        row, _ = await self.dispatch(
            "stat", path, caller=caller, nofollow=True
        )
        if not isinstance(row, FileStat):
            raise enoent(path)
        return row

    async def _listing(self, caller: Caller, path: PathSpec) -> list[str]:
        """The entries of the directory at ``path``.

        Args:
            caller (Caller): who asks.
            path (PathSpec): the directory.
        """
        entries, _ = await self.dispatch("readdir", path, caller=caller)
        return list(entries)

    async def _dispatch(
        self,
        name: str,
        path: PathSpec,
        caller: Caller,
        /,
        *,
        report: OpReport | None = None,
        **kwargs: Any,
    ) -> tuple[Any, IOResult]:
        # The dispatcher's own keywords: a read answered as it is pulled, a
        # read of what the backend holds now, past the file cache, a read
        # of what the file cache alone holds, and a stat of what the
        # backend holds now, past the mount's index.
        admit_only = name in {"write", "stat"} and bool(
            kwargs.pop("admit_only", False)
        )
        stream = name == "read" and bool(kwargs.pop("stream", False))
        direct = name == "read" and bool(kwargs.pop("direct", False))
        warm = name == "read" and bool(kwargs.pop("warm", False))
        fresh = name == "stat" and bool(kwargs.pop("fresh", False))
        # The command's gate judges its own calls; a metadata call passes,
        # as its guards let stat pass, unless it only asks admission, and a
        # scan guard reads nothing: the rule judges each read it guards. A
        # warm read is judged in the cache stage, held or not: its answer
        # stands in for the read (a search's ruled-out file is read as
        # empty), so it meets the rule the read would.
        rule_gate = (
            None
            if (name in METADATA_OPS and not admit_only)
            or name == "before_full_scan"
            or warm
            else caller.rule_gate
        )
        if name == "read_many":
            await self._read_many([path, *kwargs.pop("paths", ())], caller)
            return None, IOResult()
        scopes = kwargs.pop("scopes", ()) if name == "search" else ()
        if scopes:
            hits = await self._search_together(
                [path, *scopes], caller, report, kwargs
            )
            return hits, IOResult()
        await self._prepare(caller)
        # With no scan guard on any mount, no path reaches one to ask.
        if name == "before_full_scan" and not any(
            m.vfs.supports(name) for m in self._namespace.registry.mounts()
        ):
            return None, IOResult()
        call = await self._walk(
            name, path, kwargs, rule_gate, report, caller, fresh
        )
        call.stream = stream
        call.direct = direct
        call.warm = warm
        call.fresh = fresh
        await self._refuse_rename(call)
        if report is not None:
            report.path = call.path.virtual
        if admit_only:
            self._follow(call)
            if name == "stat":
                _memory_answered(report)
                return None, IOResult()
            mount = self._namespace.try_mount_for(call.path.virtual)
            if mount is None:
                raise enoent(call.path.virtual)
            await self._admit(call, mount, CALLS["write"])
            _memory_answered(report)
            return None, IOResult()
        if self._table_answers(name, call.path.virtual, kwargs):
            return (
                self._on_device(
                    name,
                    call.path.virtual,
                    await self._table_call(
                        name, call.path, kwargs, report, caller
                    ),
                ),
                IOResult(),
            )
        self._follow(call)
        if report is not None:
            report.path = call.path.virtual
        await self._walk_operands(call)
        if name in XATTR_OPS:
            return (
                await self._answer_xattr(
                    name, call.path, kwargs, report, caller
                ),
                IOResult(),
            )
        if name == "statfs":
            return await self._statfs(call.path, caller), IOResult()
        mount = self._namespace.try_mount_for(call.path.virtual)
        # A mount with no scan guard has nothing to refuse, so a command
        # asks every mount it walks and only a guard costs a call.
        if name == "before_full_scan" and (
            mount is None or not mount.vfs.supports(name)
        ):
            return None, IOResult()
        # The cache stage answers first where the file cache decides: a
        # call standing in for a read gives way to the read for a file it
        # holds, which is judged, and a warm read answers whether it holds
        # one, judged as the read it stands in for.
        if name in READ_STAND_IN_OPS and await self._held(call, mount):
            _memory_answered(report)
            return None, IOResult()
        if warm:
            held = await self._held(call, mount)
            if caller.rule_gate is not None:
                _judge(caller.rule_gate, call.typed, call.walked, call.path)
            _memory_answered(report)
            return (True if held else None), IOResult()
        if mount is None:
            return (
                self._on_device(
                    name, call.path.virtual, await self._answer_unmounted(call)
                ),
                IOResult(),
            )
        across = self._copy_target(call, mount)
        if across is None:
            await self._refuse_cross_mount(call, mount)
        if await self._declines(call):
            if across is not None:
                raise exdev(call.path)
            if call.name in ("search", "files_containing"):
                return None, IOResult()
            raise walk_declined(str(mount.vfs.name), call.name, call.path)
        mark = declared(type(mount.vfs), name) or CALLS.get(name)
        if mark is None:
            raise enotsup(str(mount.vfs.name), name, call.path)
        # mkdir(2) looks its name up first, so on a read-only region that
        # lookup answers for the mode, after every other policy has spoken.
        # A dry run never looks, so it explains the mode's refusal.
        looks_up = (
            name == "mkdir"
            and caller.explaining is None
            and effective_path_mode(
                call.path.virtual,
                mount.prefix,
                mount.mode,
                session_access(caller.session),
            )
            == MountMode.READ
        )
        boundary = await self._admit(
            call, mount, mark, judge_mode=not looks_up
        )
        if looks_up:
            await _mkdir_on_read_only(
                functools.partial(self._walk_stat, caller),
                mount.prefix,
                mount.mode,
                call.path,
                bool(call.kwargs.get("parents")),
                caller,
            )
            await boundary.complete(mark, call.path, call.write, None)
            return None, IOResult()
        if across is not None:
            await self._copy_across(call, mount, across)
            await boundary.complete(mark, call.path, call.write, None)
            return None, IOResult()
        await mount.ensure_ready()
        served = await self._serve_cached(call, mount, boundary, mark)
        if served is not None:
            return served, IOResult()
        settles = (
            name in DISPATCH_WRITE_OPS
            or (call.write and name not in POLICY_WRITE_OPS)
        ) and name not in SERIAL_WRITE_OPS
        try:
            ran = await (
                self._fresh_call(call, mount)
                if call.fresh
                else self._call(call, mount, self._filler(call, mount))
            )
        except BaseException:
            if settles:
                await self._evict_failed_write(mount, name, call.path, kwargs)
            raise
        result = self._filter(call, ran)
        if settles:
            await self._settle_write(
                mount, name, call.path, kwargs, call.vis, created=ran
            )
        if name not in CALLS:
            result = self._custom_answer(call, mount, result)
        result = await boundary.complete(mark, call.path, call.write, result)
        return result, IOResult()

    async def _search_together(
        self,
        scopes: list[PathSpec],
        caller: Caller,
        report: OpReport | None,
        kwargs: dict[str, Any],
    ) -> list[tuple[str, str]] | None:
        """Rank several scopes as one query, as a store's ``search_many``
        does.

        One call answers for them all where one mount serves every scope
        and its VFS ranks a batch, past the same checks each scope's own
        search meets: each is walked and followed, a path rule or a coded
        pre_vfs policy reaching below any of them declines the batch
        (None), and every hit the session hides is dropped. Otherwise, and
        while a post_vfs policy speaks for the session (it judges each
        scope's answer on its own), each scope is searched on its own and
        the hits joined in scope order.

        Args:
            scopes (list[PathSpec]): the scopes, as the caller named them.
            caller (Caller): who makes the search.
            report (OpReport | None): the caller's report.
            kwargs (dict[str, Any]): the search's own arguments.
        """
        await self._prepare(caller)
        calls: list[_Call] = []
        for typed in scopes:
            call = await self._walk(
                "search", typed, dict(kwargs), caller.rule_gate, report, caller
            )
            self._follow(call)
            calls.append(call)
        mount = self._namespace.try_mount_for(calls[0].path.virtual)
        if (
            mount is None
            or not mount.vfs.supports("search_many")
            or any(
                self._namespace.try_mount_for(call.path.virtual) is not mount
                for call in calls
            )
            or await self._namespace.registry.policies.wants_for(
                "post_vfs", _session_id(caller)
            )
        ):
            hits: list[tuple[str, str]] = []
            for typed in scopes:
                answer, _ = await self._dispatch(
                    "search", typed, caller, report=report, **kwargs
                )
                if answer is None:
                    return None
                hits.extend(answer)
            return hits
        for call in calls:
            if await self._declines(call):
                return None
        mark = declared(type(mount.vfs), "search") or CALLS["search"]
        boundary = self._boundary(mount, caller)
        for call in calls:
            boundary = await self._admit(call, mount, mark)
        await mount.ensure_ready()
        result = await mount.search_many(
            [call.path.virtual for call in calls], **kwargs
        )
        _served(report, result)
        if result is not None:
            result = [
                hit
                for hit in result
                if path_visible(caller.visibility, hit[0])
            ]
        return await boundary.complete(mark, calls[0].path, False, result)

    async def _read_many(self, typed: list[PathSpec], caller: Caller) -> None:
        """Keep the small files ``typed`` names in the read cache, for the
        reads a command is about to make of them; nothing is answered.

        Each read that follows still meets every check of its own and is
        served what this kept, so nothing is fetched where a check could
        refuse that read before its backend is asked: nothing in a dry
        run or while a coded pre_vfs policy speaks for the session (the
        rule a one-call walk meets in ``_declines``), and no path the
        session hides or a path rule reaches. A file already kept, one a
        renderer answers, one pinned to a revision and one on a mount
        that keeps no reads or holds its data locally (read as fast when
        asked) is passed over. A store that reads a batch
        (``read_many``) is asked once for the rest of its files; any
        other is asked for each file its listing sizes within
        ``READ_AHEAD_BYTES``. A failure is logged and dropped: the read
        that follows meets it itself.

        Args:
            typed (list[PathSpec]): the files, as the caller named them.
            caller (Caller): who makes the reads.
        """
        if (
            caller.explaining is not None
            or await self._namespace.registry.policies.wants_for(
                "pre_vfs",
                _session_id(caller),
                rules_only=caller.refusals is not None,
            )
        ):
            return
        await self._prepare(caller)
        gate = caller.rule_gate
        batches: dict[
            str, tuple[MountEntry, CacheManager, list[PathSpec]]
        ] = {}
        for path in typed:
            try:
                call = await self._walk("read", path, {}, None, None, caller)
                self._follow(call)
            except OSError as exc:
                logger.debug("read-ahead passes over %s: %s", path, exc)
                continue
            mount = self._namespace.try_mount_for(call.path.virtual)
            manager = None if mount is None else self._filler(call, mount)
            if (
                mount is None
                or manager is None
                or mount.retiring
                or mount.vfs.local
                or call.path.virtual in mount.revisions
                or (
                    gate is not None
                    and (
                        gate.scopes(path.virtual)
                        or gate.scopes(call.path.virtual)
                    )
                )
            ):
                continue
            batches.setdefault(mount.prefix, (mount, manager, []))[2].append(
                call.path
            )
        scope = RecordingScope(active=active_recorder() is None)
        try:
            for mount, manager, paths in batches.values():
                await mount.ensure_ready()
                batched = mount.vfs.supports("read_many")
                entries = await mount.index.get_many(
                    [p.virtual for p in paths]
                )
                wanted = [
                    p
                    for p in paths
                    if _fits_read_ahead(entries.get(p.virtual), batched)
                    and not await manager.is_cached(p)
                ]
                if not wanted:
                    continue
                answers: asyncio.Future[dict[str, bytes]] = (
                    asyncio.get_running_loop().create_future()
                )
                fills = [
                    asyncio.ensure_future(
                        manager.fill(
                            p,
                            functools.partial(_answered, answers, p.virtual)
                            if batched
                            else functools.partial(
                                mount.call, "read", p.virtual
                            ),
                        )
                    )
                    for p in wanted
                ]
                try:
                    if batched:
                        # Each fill takes its generation, and the place its
                        # records start, before the one request goes out: a
                        # write landing while it runs keeps none of it.
                        await asyncio.sleep(0)
                        try:
                            answers.set_result(
                                await mount.read_many(
                                    [p.virtual for p in wanted],
                                    READ_AHEAD_BYTES,
                                )
                            )
                        except Exception as exc:
                            answers.set_exception(exc)
                    for failure in await asyncio.gather(
                        *fills, return_exceptions=True
                    ):
                        if isinstance(failure, BaseException):
                            logger.debug("read-ahead dropped: %s", failure)
                finally:
                    answers.cancel()
                    for fill in fills:
                        fill.cancel()
        finally:
            scope.close()

    async def _prepare(self, caller: Caller) -> None:
        """Load the namespace and run what a snapshot restore left owed.

        Pending fingerprint checks from a strict snapshot restore run
        before the op can touch a mount, whichever surface called: FUSE
        and ``ws.vfs`` come straight here, so a drain that lived any
        higher would let a first write clobber drifted state. drain()
        clears pending before it stats, so its own probes cannot recurse
        into it. A dry run leaves them pending, its policies' reads
        included: the check is no policy's answer, and the op that does
        run still owes it.

        Args:
            caller (Caller): who makes the op.
        """
        await self._namespace.ensure_loaded()
        if (
            self._drift is not None
            and self._drift.pending
            and caller.explaining is None
        ):
            await self._drift.drain(self._namespace.registry.try_mount_for)

    async def _walk(
        self,
        name: str,
        path: PathSpec,
        kwargs: dict[str, Any],
        rule_gate: EntryGate | None,
        report: OpReport | None,
        caller: Caller,
        fresh: bool = False,
    ) -> _Call:
        """Walk the op's path, as the kernel does before a call sees it.

        Hidden paths answer before anything else can: the typed path is
        checked so a link inside hidden space cannot be followed out of
        it, a link that leads into hidden space answers as hidden under
        the name it was reached by, the followed path is re-checked
        (``_follow``) so a visible link cannot lead in, and a rename's or
        a copy's destination is a create. Every
        link above the final name is then followed, whatever the op does
        with the name: command dispatch walks the operands it classifies,
        and this is the same walk for every other caller (a relative word
        ln resolves itself, ``ws.vfs``, a runtime's os.symlink), so a
        link made, read or removed under a linked directory lands in the
        directory the link names.

        Args:
            name (str): the dispatched op name.
            path (PathSpec): the path as the caller named it.
            kwargs (dict[str, Any]): the op's arguments; a rename's or a
                copy's ``dst`` is replaced by its walked spelling.
            rule_gate (EntryGate | None): the running command's gate.
            report (OpReport | None): the caller's report.
            caller (Caller): who makes the op.
            fresh (bool): whether the names the walk checks are asked of
                the backend past the mount's index, as a fresh stat asks.
        """
        vis = caller.visibility
        links = self._namespace.symlink_targets()
        hidden = not path_visible(vis, path.virtual)
        if hidden or leads_hidden(vis, path.virtual, links):
            # An op that follows a link into hidden space lands there,
            # so it answers as a create under a hidden directory does.
            follows = name not in NO_FOLLOW_OPS and not kwargs.get("nofollow")
            raise hidden_refusal(
                vis,
                path.virtual,
                name in HIDDEN_CREATE_OPS and (hidden or not follows),
                links,
            )
        dst = kwargs.get("dst") if name in DESTINATION_OPS else None
        if isinstance(dst, PathSpec):
            dst_hidden = not path_visible(vis, dst.virtual)
            if dst_hidden or leads_hidden(vis, dst.virtual, links):
                raise hidden_refusal(
                    vis, dst.virtual, dst_hidden or name not in COPY_OPS, links
                )
        # An operand the walk already refused (the empty name, a link
        # loop) names nothing an op can reach, whatever `virtual` says.
        for walked in (path, dst):
            if isinstance(walked, PathSpec) and walked.walk_error is not None:
                raise walk_refusal(walked)
        # A `.` or `..` resolves against the directory it sits in, so
        # every name in front of one has to be a directory: `virtual`
        # simplified the dots away and reaches `f` through a missing
        # `nope/..`, the typed spelling (`dotted`) does not. A trailing
        # slash is part of that spelling: `x/` must be a directory, so a
        # create of one is EISDIR before anything is looked up, as GNU tee
        # and truncate answer `missing/` and `f/`. Behind a dot (`x/./`)
        # the walk through the dot answers first, ENOENT or ENOTDIR, as
        # GNU does. Deliberate divergence: under a parent that is itself
        # absent GNU reports the parent first (ENOENT); the spelling is
        # refused here without a round trip, so that corner reads EISDIR.
        slashed = name in FILE_CREATE_OPS and (
            (path.dotted or "").endswith("/") or path.raw_path.endswith("/")
        )
        if slashed and not ends_at_dot(path.raw_path or path.dotted or ""):
            raise eisdir(path)
        follow = self._namespace.follow
        visible = functools.partial(path_visible, vis)
        refusal = hidden_walk(path, follow, visible)
        if refusal is None and isinstance(dst, PathSpec):
            refusal = hidden_walk(dst, follow, visible)
        stat = functools.partial(self._walk_stat, caller, fresh=fresh)
        if refusal is None:
            refusal = await dot_refusal(
                stat, path, follow, name in ENTRY_CREATE_OPS
            )
        if refusal is None and isinstance(dst, PathSpec):
            refusal = await dot_refusal(stat, dst, follow)
        if refusal is not None:
            raise refusal
        if slashed:
            raise eisdir(path)
        typed, typed_dst = path, dst
        path = self._walked(path, name in HIDDEN_CREATE_OPS, vis)
        if isinstance(dst, PathSpec):
            dst = kwargs["dst"] = self._walked(dst, True, vis)
        # The command's gate judges each spelling, as handed in and as
        # walked, once both walks have answered for hidden space: here
        # for an op on the name itself and for a destination, in
        # ``_follow`` for the rest.
        if typed.virtual.endswith("/") or typed.raw_path.endswith("/"):
            # A trailing slash names the directory a link at the final
            # name reaches, as path resolution reads ``link/``.
            kwargs.pop("nofollow", None)
        no_follow = name in NO_FOLLOW_OPS or bool(kwargs.get("nofollow"))
        if rule_gate is not None and no_follow:
            _judge(rule_gate, typed, path, typed_dst, dst)
        elif rule_gate is not None:
            _judge(rule_gate, typed_dst, dst)
        return _Call(
            name=name,
            path=path,
            typed=typed,
            dst=dst if isinstance(dst, PathSpec) else None,
            kwargs=kwargs,
            vis=vis,
            caller=caller,
            rule_gate=rule_gate,
            report=report,
            no_follow=no_follow,
            write=name in POLICY_WRITE_OPS,
        )

    async def _refuse_rename(self, call: _Call) -> None:
        """Refuse a rename the namespace forbids before any backend runs.

        A rename re-anchors everything below its source while the hides
        stay where they are written, so hidden content would land at
        paths the session can see. Destroying hidden content is silent
        (rm_r, the remnant rmdir); relocating it into view is refused.
        Only a directory has anything below it to re-anchor, so a file
        source passes. rename(2) also replaces a destination directory
        only when it is empty, and the node table is half of what empty
        means here: a link is invisible to every backend, so a
        destination the backend reads as empty can still hold one. Left
        to the backend the rename succeeded and the purge then deleted
        the link with it, losing namespace state silently where POSIX
        promises ENOTEMPTY.

        Args:
            call (_Call): the walked op.
        """
        dst = call.dst
        if call.name != "rename" or dst is None:
            return
        if move_reveals(
            call.vis, call.path.virtual, dst.virtual
        ) and await self._moved_source_is_dir(call.path):
            raise eacces(call.path.virtual)
        if self._namespace.link_stats_below(dst.virtual):
            raise enotempty(dst.virtual)

    def _follow(self, call: _Call) -> None:
        """Follow the final name, unless the op acts on the name itself.

        ``nofollow`` is the caller's AT_SYMLINK_NOFOLLOW: an op that acts
        on a link entry itself (chown -h writing the link's own attrs)
        keeps the typed path. Consumed here, never forwarded. A copy
        writes its destination as a write does, through a link at the
        final name; a rename moves the name itself. A copy whose two ends
        then name one file is refused: a backend that replaces its
        destination would delete the source first.

        Args:
            call (_Call): the walked op; its ``path`` becomes the target.
        """
        walked = call.path
        nofollow = call.kwargs.pop("nofollow", False)
        if call.name in COPY_OPS and call.dst is not None and not nofollow:
            dst = PathSpec.from_str_path(
                _follow_or_loop(self._namespace, call.dst, True)
            )
            if dst.virtual != call.dst.virtual:
                if not path_visible(call.vis, dst.virtual):
                    raise hidden_refusal(call.vis, dst.virtual, True)
                if call.rule_gate is not None:
                    _judge(call.rule_gate, dst)
                call.dst = call.kwargs["dst"] = dst
        if (
            nofollow
            and call.name in DIRECTORY_OPEN_OPS
            and self._namespace.is_link(call.path.virtual)
        ):
            raise enotdir(call.path.virtual)
        if call.name not in NO_FOLLOW_OPS and not nofollow:
            followed = _follow_or_loop(self._namespace, call.path, True)
            if followed != call.path.virtual:
                call.walked = call.path
                call.path = PathSpec.from_str_path(followed)
                if not path_visible(call.vis, call.path.virtual):
                    raise hidden_refusal(
                        call.vis,
                        call.path.virtual,
                        call.name in HIDDEN_CREATE_OPS,
                    )
        if call.rule_gate is not None and not call.no_follow:
            _judge(call.rule_gate, call.typed, walked, call.path)
        if (
            call.name in COPY_OPS
            and call.dst is not None
            and call.dst.virtual == call.path.virtual
        ):
            raise einval(call.dst)

    async def _walk_operands(self, call: _Call) -> None:
        """Walk and follow each other path argument as the path is.

        The same hides, spelling checks and rule gate apply, so a second
        path is no way around them; the followed spelling replaces it.

        Args:
            call (_Call): the followed op; its path arguments are walked.
        """
        for key, typed in _operands(call.name, call.kwargs):
            other = await self._walk(
                call.name, typed, {}, call.rule_gate, None, call.caller
            )
            self._follow(other)
            call.kwargs[key] = other.path

    async def _answer_unmounted(self, call: _Call) -> Any:
        """Answer an op on a path no mount serves.

        The namespace may still know a directory there (a deeper mount,
        a link). No mount means no cache to keep straight. The merged
        names are session-filtered individually. A setattr lands in the
        overlay (a link above every mount still takes chown -h), gated
        exactly like the mounted overlay write.

        Args:
            call (_Call): the followed op.
        """
        if call.name == "setattr":
            boundary = self._boundary(None, call.caller)
            await boundary.admit(CALLS["setattr"], call.path, True)
            applied = await self._overlay_setattr(call.path, call.kwargs)
            _memory_answered(call.report)
            await boundary.complete(CALLS["setattr"], call.path, True, applied)
            return applied
        fallback = self._namespace_result(
            call.name, call.path.virtual, call.vis
        )
        if fallback is None:
            raise no_mount(call.path.virtual)
        return await self._gated_namespace(
            call.name, call.path, fallback, call.report, call.caller
        )

    def _copy_target(
        self, call: _Call, mount: MountEntry
    ) -> MountEntry | None:
        """The mount a copy's destination is on, when that is another
        mount whose store may copy from this one's; None otherwise.

        Args:
            call (_Call): the followed op.
            mount (MountEntry): the mount serving its path.
        """
        if call.name != "copy" or call.dst is None:
            return None
        other = self._namespace.try_mount_for(call.dst.virtual)
        if (
            other is None
            or other is mount
            or not other.vfs.supports("copy_from")
        ):
            return None
        return other

    async def _copy_across(
        self, call: _Call, mount: MountEntry, other: MountEntry
    ) -> None:
        """Copy a file onto another mount, store to store.

        Admission judged the source as a read and the destination as a
        create under its own mount's mode, as for a copy within one
        mount. The destination's store copies from the source's where it
        can (one bucket to another under one set of credentials);
        otherwise it answers EXDEV, as a copy between two mounts always
        did, and the caller moves the bytes itself. The destination's
        name is held, and its caches settled, on its own mount.

        Args:
            call (_Call): the admitted copy.
            mount (MountEntry): the mount serving its source.
            other (MountEntry): the mount serving its destination.
        """
        dst = call.dst
        if dst is None:
            raise exdev(call.path)
        await mount.ensure_ready()
        await other.ensure_ready()
        if not await other.can_copy_from(mount, call.path.virtual):
            raise exdev(call.path)
        key = f"{id(other.vfs)}:{mount_key(dst.virtual, other.prefix.rstrip('/'))}"
        async with self._writers.with_lock(key):
            try:
                await other.copy_from(mount, call.path.virtual, dst.virtual)
            except BaseException:
                await self._evict_failed_write(
                    other, "copy", call.path, {"dst": dst}
                )
                raise
            await self._settle_write(
                other,
                "copy",
                call.path,
                {"dst": dst},
                call.vis,
                created=None,
            )

    async def _refuse_cross_mount(
        self, call: _Call, mount: MountEntry
    ) -> None:
        """Answer EXDEV for a rename or a copy between two mounts.

        A mount is a filesystem boundary: rename(2) moves a name within
        one and answers EXDEV across two, before any permission is
        weighed, so `mv` falls back to copy and unlink instead of the
        source's backend taking the destination for one of its keys; a
        backend copies only within itself, the same way. It resolves
        both parent directories first, so a missing one is ENOENT
        (ENOTDIR through a file) ahead of EXDEV.

        Args:
            call (_Call): the followed op.
            mount (MountEntry): the mount serving its path.
        """
        dst = call.dst
        if (
            dst is not None
            and self._namespace.try_mount_for(dst.virtual) is not mount
        ):
            # A copy between two stores that cannot make it is the caller's
            # cue to move the bytes, whose read and write word any missing
            # parent themselves, so it asks the backends nothing.
            if call.name == "copy":
                raise exdev(call.path)
            refusal = await self._parent_refusal(call.path, call.caller)
            refusal = refusal or await self._parent_refusal(dst, call.caller)
            raise refusal or exdev(call.path)
        # A function runs on one backend, so every path it is handed
        # must be on the mount that serves it.
        for _, other in _operands(call.name, call.kwargs):
            if self._namespace.try_mount_for(other.virtual) is not mount:
                raise exdev(other)

    async def _declines(self, call: _Call) -> bool:
        """Whether a one-call walk gives way to the caller's own walk.

        A backend's find, du, search, tree copy or tree removal answers
        for every entry under its path in one call, past the checks each
        entry would meet on its own. So when the command's path rules or,
        for a ``ws.vfs`` call, a coded pre_vfs policy reach below one of
        its paths, it is declined and the caller walks, entry by entry,
        through calls that are each judged. Inside a running line only the
        profile's path rules judge an entry, so a coded policy declines no
        walk there. A path rule declines no ``files_containing``: its
        answer only rules files out of a walk that still lists every one,
        and each file it rules out meets the rule as a warm read, so one
        the rule refuses reports ``Permission denied`` as its read would.
        A hide declines the copies and the removal, which
        would reach hidden entries; a read in ``HIDE_FILTERED_OPS`` runs
        and ``_filter`` drops what the session hides from its answer. A
        file copy is declined the same way: the bytes it moves never pass
        through a read. A tree copy is declined too when a link stands
        below its destination: the backend writes each child name as it
        is, where the walk's copies follow the link.

        Args:
            call (_Call): the followed op.
        """
        if call.name not in NATIVE_WALK_OPS:
            return False
        if (
            call.name == "dir_copy"
            and call.dst is not None
            and self._namespace.link_stats_below(call.dst.virtual)
        ):
            return True
        paths = [call.path] if call.dst is None else [call.path, call.dst]
        if call.name not in HIDE_FILTERED_OPS and any(
            hidden_under(call.vis, p.virtual) for p in paths
        ):
            return True
        if call.rule_gate is not None:
            return call.name != "files_containing" and any(
                call.rule_gate.scopes(p.virtual) for p in paths
            )
        return await self._namespace.registry.policies.wants_for(
            "pre_vfs",
            _session_id(call.caller),
            rules_only=call.caller.refusals is not None,
        )

    async def _admit(
        self,
        call: _Call,
        mount: MountEntry,
        mark: VfsCall,
        judge_mode: bool = True,
    ) -> Boundary:
        """Run admission for an op on a mounted path.

        Admission policies fire at the dispatcher, before the warm-cache early
        return: a cached read must be refused exactly like a cold one, or
        the cache becomes a policy bypass. A rename's or a copy's
        destination is a create there: it passes the same gate as the
        source, so a path rule holds against moving or copying into a
        protected scope (or onto the directory that holds one) the way it
        holds against writing there, under the mode of the mount that owns
        it. A copy only reads its source.

        Args:
            call (_Call): the followed op.
            mount (MountEntry): the mount serving its path.
            mark (VfsCall): what the mount's VFS declares for the call.
            judge_mode (bool): whether the mount's mode is judged here;
                False when the op answers for it itself.

        Returns:
            Boundary: the boundary the op completes through.
        """
        # A function the VFS declares a write is judged as one, whatever
        # its name: the POSIX names are known here, a custom one only to
        # the VFS that defines it.
        call.write = call.write or mark.effect in WRITE_EFFECTS
        boundary = self._boundary(mount, call.caller)
        if not judge_mode:
            boundary = dataclasses.replace(boundary, mode=None)
        await boundary.admit(
            mark,
            call.path,
            call.write and call.name not in COPY_OPS,
            final=call.dst is None,
        )
        if call.dst is not None:
            await self._boundary(
                self._namespace.try_mount_for(call.dst.virtual), call.caller
            ).admit(mark._replace(creates=True), call.dst, True)
        for _, other in _operands(call.name, call.kwargs):
            await boundary.admit(mark, other, call.write)
        links = self._namespace.symlink_targets()
        if call.name == "rmdir" and any(
            path_visible(call.vis, link)
            and not leads_hidden(call.vis, link, links)
            for link, _ in self._namespace.link_stats_below(call.path.virtual)
        ):
            raise enotempty(call.path.virtual)
        return boundary

    async def _held(self, call: _Call, mount: MountEntry | None) -> bool:
        """Whether the file cache holds a copy of the call's path.

        Asked of the store without fetching the bytes or checking the
        copy against the backend: a read of a held file is checked as it
        is served.

        Args:
            call (_Call): the followed op.
            mount (MountEntry | None): the mount serving its path.
        """
        manager = mount.cache_manager if mount is not None else None
        return manager is not None and await manager.is_cached(call.path)

    async def _serve_cached(
        self,
        call: _Call,
        mount: MountEntry,
        boundary: Boundary,
        mark: VfsCall,
    ) -> bytes | None:
        """Answer a read from the file cache, or None to read the backend.

        The file cache holds what commands read, keyed on the path alone:
        the stored bytes, which are the rendering for a VFS with no
        ``read`` of its own. A read through a filetype renderer (whoever
        registered it) asks for a different value under the same key, so
        it is neither served from that cache nor kept in it, and neither
        is a direct read (``direct=True``), which asks for what the
        backend holds now: a follow's poll for bytes the cached copy
        cannot have yet. The cache holds the whole object, so a ranged
        read is answered by slicing it, never by handing back the whole
        file: the window is what the caller asked for instead of the
        file, and git reads pack indexes this way. slice_window is the
        same helper the ranged read op falls back to, so warm and cold
        agree.

        Args:
            call (_Call): the admitted op.
            mount (MountEntry): the mount serving its path.
            boundary (Boundary): the boundary the op completes through.
            mark (VfsCall): what the mount's VFS declares for the call.
        """
        if (
            call.direct
            or not mount.vfs.caches_reads
            or call.name not in DISPATCH_READ_OPS
        ):
            return None
        cached = await self._cache.get(call.path.virtual)
        if (
            cached is None
            or _retracted(call.path.virtual)
            or not await self._reconciler.may_serve_cached(
                mount, call.path.virtual
            )
            or call.renders_read(mount)
            or mount.retiring
            or self._namespace.try_mount_for(call.path.virtual) is not mount
        ):
            return None
        mount.refuse_keywords(call.name, call.kwargs)
        offset, size = call.window
        served = slice_window(cached, offset, size)
        # Nothing crossed the network, and neither a gate nor a hard cap
        # leaves the caller able to tell: without the stamp a refused
        # warm read is recorded against the backend and counted as
        # traffic that never happened.
        _memory_answered(call.report, len(served))
        return await boundary.complete(mark, call.path, call.write, served)

    def _filler(self, call: _Call, mount: MountEntry) -> CacheManager | None:
        """The cache manager a cold read fills, or None to keep nothing.

        A cold read keeps the whole file it fetched for the next reader,
        through the mount's own manager, the one a command's read fills:
        a write racing the fetch retires its generation, so the bytes it
        read are not kept. A ranged read comes from the store only where
        the store can serve one; elsewhere the read op would fetch the
        whole file and slice it for every range, so the whole file is
        read once, kept, and each range sliced from it. The op is
        resolved only once the mount is ready, so a renderer can land
        after this check; the fill asks again before it keeps anything.

        Args:
            call (_Call): the admitted op.
            mount (MountEntry): the mount serving its path.
        """
        offset, size = call.window
        if (
            mount.vfs.caches_reads
            and not call.direct
            and call.name in DISPATCH_READ_OPS
            and size != 0
            and (
                (offset, size) == (0, None)
                or not mount.reads_ranges(call.path.virtual)
            )
            and not call.renders_read(mount)
        ):
            return mount.cache_manager
        return None

    async def _call(
        self,
        call: _Call,
        mount: MountEntry,
        filler: CacheManager | None,
    ) -> Any:
        """Run the op on its mount and stamp what it moved.

        Args:
            call (_Call): the admitted op.
            mount (MountEntry): the mount serving its path.
            filler (CacheManager | None): the manager a cold read fills.

        Returns:
            Any: the op's answer (each op has its own shape).
        """
        kwargs = call.kwargs
        # Every path argument beside the path (a rename's destination, a
        # custom function's other paths) is addressed against the same
        # mount, so the backend sees a mount-relative path.
        prefix = mount.prefix.rstrip("/")
        for key, value in list(kwargs.items()):
            if isinstance(value, PathSpec):
                kwargs[key] = PathSpec(
                    virtual=value.virtual,
                    directory=value.virtual.rsplit("/", 1)[0] or "/",
                    vfs_path=mount_key(value.virtual, prefix),
                )
        result: Any
        # A fill keeps the token its backend records with the read; a
        # read outside a line (FUSE, ws.vfs) records into a scope of its
        # own for that.
        scope = RecordingScope(
            active=filler is not None and active_recorder() is None
        )
        try:
            if call.name == "setattr":
                result = await self._apply_setattr(
                    mount, call.path, kwargs, call.vis
                )
            elif await self._streams(call, mount):
                return await self._open_stream(call, mount, filler)
            elif filler is not None:
                offset, size = call.window
                kept = await filler.fill(
                    call.path,
                    functools.partial(
                        mount.call,
                        call.name,
                        call.path.virtual,
                        **_whole_read(kwargs),
                    ),
                    keep=lambda: not call.renders_read(mount),
                )
                result = (
                    kept
                    if (offset, size) == (0, None)
                    else slice_window(kept, offset, size)
                )
            elif call.name in SERIAL_WRITE_OPS:
                result = await self._serial_write(call, mount)
            elif call.name == "before_full_scan" and not await _is_directory(
                mount, call.path
            ):
                result = None
            else:
                if call.name == "before_full_scan":
                    kwargs["files"] = await self._visible_files(mount, call)
                if call.fresh:
                    kwargs["index"] = ListingCheckStore(hints=mount.index)
                probed = _probed(call, mount)
                result = (
                    probed
                    if probed is not None
                    else await mount.call(
                        call.name,
                        call.path
                        if call.name == "readdir"
                        else call.path.virtual,
                        **kwargs,
                    )
                )
                if call.fresh:
                    await self._reconciler.on_fresh_stat(
                        mount, call.path.virtual, result
                    )
                if call.name == "stat":
                    result = await _sized(mount, call.path, result)
        except (FileNotFoundError, NotADirectoryError):
            result = self._namespace_result(
                call.name, call.path.virtual, call.vis
            )
            if result is None:
                if call.fresh:
                    await self._reconciler.on_fresh_stat(
                        mount, call.path.virtual, None
                    )
                else:
                    await self._reconciler.on_enoent(
                        mount, call.name, call.path.virtual
                    )
                raise
            _memory_answered(call.report)
        except OSError as exc:
            if call.name != "rmdir" or exc.errno not in (
                errno.ENOTEMPTY,
                errno.EEXIST,
            ):
                raise
            await self._rmdir_remnants(
                mount, call.path, exc, call.rule_gate, call.caller
            )
            result = None
            if call.report is not None:
                call.report.served(None, None)
        else:
            # The op ran, whatever invalidation, the post gate, or an
            # output cap do next: stamped here so a failure in any of
            # them cannot erase a transfer the backend already made.
            _served(call.report, result)
        finally:
            scope.close()
        return result

    async def _fresh_call(self, call: _Call, mount: MountEntry) -> Any:
        """Run a fresh stat under its path's writer hold.

        No local write to the path lands between the backend's answer and
        its reconcile. The wait for the hold is bounded by the stat's own
        timeout, since a write the clock gave up on may still hold the
        path; once admitted, the backend call keeps its own timeout and
        the reconcile runs to its end under the hold, so a deadline never
        stops it between dropping a version and keeping it.

        Args:
            call (_Call): the admitted fresh stat.
            mount (MountEntry): the mount serving its path.
        """
        prefix = mount.prefix.rstrip("/")
        key = f"{id(mount.vfs)}:{mount_key(call.path.virtual, prefix)}"
        async with AsyncExitStack() as held:
            await run_with_timeout(
                held.enter_async_context(self._writers.with_lock(key)),
                mount.op_timeout("stat"),
                "stat",
            )
            return await self._call(call, mount, self._filler(call, mount))

    async def _visible_files(
        self, mount: MountEntry, call: _Call
    ) -> int | None:
        """How many files the session sees under a scan guard's path.

        Counted off the mount's ``read_tree`` with every hidden file
        dropped, so a guard's refusal never counts what the session
        cannot see; None when the mount cannot answer the subtree in one
        call.

        Args:
            mount (MountEntry): the mount serving the path.
            call (_Call): the guard's call.
        """
        if not mount.vfs.supports("read_tree"):
            return None
        found = await mount.call("read_tree", call.path.virtual)
        if found is None:
            return None
        visible = _visible_answer("read_tree", call.vis, call.path, found)
        return sum(st.type is FileType.FILE for st in visible.values())

    async def _streams(self, call: _Call, mount: MountEntry) -> bool:
        """Whether a read is answered as it is pulled.

        A whole read of stored bytes streams through the VFS's own
        ``read_stream``. A window, a rendering, a VFS with no stream and
        a post_vfs policy that may read the result each get the whole
        bytes instead, which are a stream of one chunk. A read a running
        line makes reaches no post_vfs policy, so it streams either way.

        Args:
            call (_Call): the admitted read.
            mount (MountEntry): the mount serving its path.
        """
        if not (
            call.stream
            and call.window == (0, None)
            and mount.vfs.supports("read_stream")
            and not call.renders_read(mount)
        ):
            return False
        return call.caller.refusals is not None or not (
            await self._namespace.registry.policies.wants_for(
                "post_vfs", _session_id(call.caller)
            )
        )

    async def _open_stream(
        self,
        call: _Call,
        mount: MountEntry,
        filler: CacheManager | None,
    ) -> AsyncIterator[bytes]:
        """Open a streamed read, its first chunk pulled before it returns.

        A cold read fills the cache as it is pulled. A live pipe's read is
        neither pulled nor cached: it answers as a ``PipeStream``.

        Args:
            call (_Call): the admitted read.
            mount (MountEntry): the mount serving its path.
            filler (CacheManager | None): the manager a cold read fills.
        """
        with command_records() as records:
            stream = mount.read_stream(call.path.virtual)
        pipe = mount.live_pipe(call.path.virtual)
        if pipe is not None:
            live = PipeStream(
                await _primed(stream, call.report, pull=False), call.path, pipe
            )
            pipe.readers.add(live)
            return live
        if filler is not None:
            stream = filler.fill_stream(
                call.path,
                stream,
                records,
                keep=lambda: not call.renders_read(mount),
            )
        return await _primed(stream, call.report)

    async def _serial_write(self, call: _Call, mount: MountEntry) -> Any:
        """Run a write with its names held, one writer at a time per name.

        Held by the store's own object, so one store mounted twice is one
        file, and a rename holds both of its names, taken in one order so
        two renames between the same pair cannot deadlock. What the write
        changes beside the store (caches, the node table's links and
        attributes) changes under the same hold: a chain of renames
        finishing out of order would move one name's attributes onto
        another.

        Args:
            call (_Call): the admitted write.
            mount (MountEntry): the mount serving its path.
        """
        kwargs = call.kwargs
        names = {call.path.virtual}
        if isinstance(kwargs.get("dst"), PathSpec):
            names.add(kwargs["dst"].virtual)
            if any(mount.live_pipe(name) is not None for name in names):
                # A copy meeting a live pipe holds no name: the pipe's other
                # end may need it (`cp f >(cat > f)`).
                names = set()
        prefix = mount.prefix.rstrip("/")
        keys = {f"{id(mount.vfs)}:{mount_key(name, prefix)}" for name in names}
        async with AsyncExitStack() as held:
            holds = [
                await held.enter_async_context(self._writers.with_lock(key))
                for key in sorted(keys)
            ]
            before = await self._cached_before(call, mount)
            payload = (
                _LentPayload(
                    kwargs["data"],
                    holds,
                    self._cache.drain_budget
                    if _facts_of(mount).cacheable
                    else 0,
                )
                if call.name in ("write", "append")
                and not isinstance(kwargs.get("data"), bytes)
                else None
            )
            if payload is not None:
                await self._invalidate_stream(mount, call.path)
                kwargs = {**kwargs, "data": payload.chunks()}
            scope = RecordingScope(active=active_recorder() is None)
            try:
                with command_records() as mine:
                    result = await mount.call(
                        call.name, call.path.virtual, **kwargs
                    )
            except BaseException:
                await self._evict_failed_write(
                    mount, call.name, call.path, kwargs
                )
                raise
            finally:
                scope.close()
                if payload is not None:
                    await self._invalidate_stream(mount, call.path)
            _served(
                call.report,
                result,
                None if payload is None else payload.moved,
            )
            await self._settle_write(
                mount, call.name, call.path, kwargs, call.vis, created=result
            )
            await self._keep_written(
                call,
                mount,
                mine,
                before if payload is None or payload.moved else None,
                call.kwargs.get("data")
                if payload is None
                else payload.whole(),
            )
        return result

    async def _invalidate_stream(
        self, mount: MountEntry, path: PathSpec
    ) -> None:
        """Drop content without losing the conditional-write baseline.

        Args:
            mount (MountEntry): destination mount.
            path (PathSpec): destination.
        """
        manager = self._manager_for(mount)
        version = await manager.read_version(path)
        await self.invalidate_after_write(mount, path, times=False)
        if version is not None:
            await manager.keep_version(path, version)

    async def _cached_before(
        self, call: _Call, mount: MountEntry
    ) -> tuple[bytes, str | None] | None:
        """The cached copy an append may extend, read under its name's
        hold before the append runs: its bytes and their token.

        Args:
            call (_Call): the write about to run.
            mount (MountEntry): the mount it runs on.
        """
        if call.name != "append" or not _facts_of(mount).cacheable:
            return None
        kept = await self._cache.get(call.path.virtual)
        if kept is None:
            return None
        return kept, await self._cache.fingerprint(call.path.virtual)

    async def _keep_written(
        self,
        call: _Call,
        mount: MountEntry,
        records: list[OpRecord],
        before: tuple[bytes, str | None] | None,
        data: bytes | None,
    ) -> None:
        """Keep a write's bytes for the next read, under its name's hold.

        The write's own record labels them with the token the backend
        answered, so a ``fresh`` mount does not refetch what it just wrote;
        a record moving another length than was sent keeps nothing, and so
        does a name another mount took while the write ran, read under the
        cache's lock. An append extends the cached copy only where the
        file is proven to have been that copy: the backend rewrote it
        whole, its read saw the copy's token, and its write moved the
        copy's length plus the appended bytes. A store with no tokens, or
        one that appends by itself, proves nothing, so the copy stays
        dropped. An append of nothing that wrote nothing (``cmd >> f``
        opening ``f``) leaves the copy as it was; one that made the file
        anew drops it, and so does a streamed one, whose name another
        writer could take while it waited.

        Args:
            call (_Call): the write that ran.
            mount (MountEntry): the mount it ran on.
            records (list[OpRecord]): the records the write emitted.
            before (tuple[bytes, str | None] | None): an append's cached
                copy and its token, from before it ran.
            data (bytes | None): the bytes it sent, None for a stream the
                cache's drain budget could not hold.
        """
        if (
            call.name not in ("write", "append")
            or not _facts_of(mount).cacheable
        ):
            return
        record = _record_of(records, WRITE_FINGERPRINT_OPS, call.path.virtual)
        fingerprint = (
            record.fingerprint or None if record is not None else None
        )
        if not isinstance(data, bytes):
            if fingerprint is not None:
                await self._manager_for(mount).keep_version(
                    call.path, fingerprint
                )
            return
        if call.name == "append":
            if before is None:
                return
            kept, token = before
            read = _record_of(records, {"read"}, call.path.virtual)
            if not data and record is None:
                data, fingerprint = kept, token
            elif (
                record is None
                or read is None
                or not read.fingerprint
                or read.fingerprint != token
                or record.bytes != len(kept) + len(data)
            ):
                return
            else:
                data = kept + data
        elif record is not None and record.bytes != len(data):
            await self._cache.remove(call.path.virtual)
            return
        await cache_io.set_cached(
            self._cache,
            call.path.virtual,
            data,
            fingerprint,
            lambda path: _facts_of(
                mount if self._namespace.try_mount_for(path) is mount else None
            ),
        )

    def _filter(self, call: _Call, result: Any) -> Any:
        """Merge the namespace into a backend answer and drop hidden names.

        A listing gains the child mounts and links the namespace holds
        below it and loses every name the session hides; a stat gains the
        attribute overlay recorded at its path.

        Args:
            call (_Call): the op that ran.
            result (Any): the backend's answer.
        """
        if call.name == "readdir":
            return _spelled_under(
                call,
                _visible_entries(
                    merge_readdir(
                        call.vis,
                        result,
                        [
                            m.prefix
                            for m in self._namespace.registry.visible_mounts()
                        ],
                        self._namespace,
                        call.path.virtual,
                    ),
                    call.path.virtual,
                    call.vis,
                ),
            )
        if call.name == "stat" and isinstance(result, FileStat):
            name = call.path.virtual.rstrip("/").rsplit("/", 1)[-1]
            if result.name == "/" and name:
                # A mount's root answers as the backend's own root; in
                # the namespace it is the name it is mounted at.
                result = result.model_copy(update={"name": name})
            return self._on_device(
                call.name,
                call.path.virtual,
                merge_overlay_stat(
                    self._namespace.meta_for(call.path.virtual), result
                ),
            )
        if call.name == "read_tree" and isinstance(result, dict):
            result = self._on_device(
                call.name,
                call.path.virtual,
                self._overlaid(
                    call.path, self._with_links(call.path, result, call.vis)
                ),
            )
        # A tree read keys its entries below the path; a search names each
        # hit itself, and a store can rank a hit from outside the scope (a
        # whole table, a filter it ignores), so every hit is checked.
        if (
            call.name in HIDE_FILTERED_OPS
            and result is not None
            and (
                call.name != "read_tree"
                or hidden_under(call.vis, call.path.virtual)
            )
        ):
            return _visible_answer(call.name, call.vis, call.path, result)
        return result

    def _custom_answer(
        self, call: _Call, mount: MountEntry, result: Any
    ) -> Any:
        """A custom function's answer as the session may see it.

        A list of paths, or of records with a ``path``, loses what the
        session hides, as a ``files_containing`` answer does. Any other
        answer cannot be told apart from what it names, so it is
        declined while the session hides anything under the call's path.
        No answer reveals nothing.

        Args:
            call (_Call): the function that ran.
            mount (MountEntry): the mount serving its path.
            result (Any): the function's answer.
        """
        if result is None:
            return result
        named = _answer_paths(result)
        if named is not None:
            links = self._namespace.symlink_targets()
            return type(result)(
                item
                for item, virtual in zip(result, named)
                if path_visible(call.vis, virtual)
                and not leads_hidden(call.vis, virtual, links)
            )
        if hidden_under(call.vis, call.path.virtual):
            raise walk_declined(str(mount.vfs.name), call.name, call.path)
        return result

    def _on_device(self, name: str, virtual: str, result: Any) -> Any:
        """A stat, or a subtree's stats, on the device of the mount
        serving ``virtual``.

        The device is the id a runtime reports as a guest's st_dev, so
        ``stat %d`` and ``os.stat`` name one device, and a walk tells a
        mount boundary by it. A path no mount serves is on the
        namespace's own, the one a root mount would have.

        Args:
            name (str): the op that answered.
            virtual (str): the path the answer is for.
            result (Any): the answer; anything but a stat or a subtree's
                stats passes unchanged.
        """
        if name not in ("stat", "read_tree") or not isinstance(
            result, (FileStat, dict)
        ):
            return result
        mount = self._namespace.try_mount_for(virtual)
        dev = ident("/" if mount is None else mount.prefix)
        if isinstance(result, FileStat):
            return result.model_copy(update={"dev": dev})
        return {
            key: (
                row.model_copy(update={"dev": dev})
                if isinstance(row, FileStat)
                else row
            )
            for key, row in result.items()
        }

    def _with_links(
        self,
        path: PathSpec,
        tree: dict[str, FileStat],
        vis: Visibility | None,
    ) -> dict[str, FileStat]:
        """A subtree read with the links the namespace holds below
        ``path`` on the same mount, each as the link it is.

        No backend stores a link, so a walk that reads the subtree in one
        call meets them only here, as a listing meets them in ``readdir``;
        a link that leads where the session cannot see is left out, as a
        listing leaves it out.

        Args:
            path (PathSpec): the directory the read answered for.
            tree (dict[str, FileStat]): the backend's answer, keyed below
                ``path``.
            vis (Visibility | None): the session's view.
        """
        base = path.virtual.rstrip("/")
        owner = self._namespace.try_mount_for(path.virtual)
        links = self._namespace.symlink_targets()
        merged = dict(tree)
        for virtual, row in self._namespace.link_stats_below(path.virtual):
            if self._namespace.try_mount_for(
                virtual
            ) is not owner or leads_hidden(vis, virtual, links):
                continue
            merged.setdefault(virtual[len(base) + 1 :], row)
        return merged

    def _overlaid(
        self, path: PathSpec, tree: dict[str, FileStat]
    ) -> dict[str, FileStat]:
        """A subtree read with the attributes the overlay holds for each
        entry, the ones a stat of that entry carries.

        Args:
            path (PathSpec): the directory the read answered for.
            tree (dict[str, FileStat]): the answer, keyed below ``path``.
        """
        base = path.virtual.rstrip("/")
        return {
            rel: merge_overlay_stat(
                self._namespace.meta_for(f"{base}/{rel}"), row
            )
            for rel, row in tree.items()
        }

    async def _settle_write(
        self,
        mount: MountEntry,
        name: str,
        path: PathSpec,
        kwargs: dict[str, Any],
        vis: Visibility | None,
        created: Any = None,
    ) -> None:
        """What a write changes beside the store: the caches above the
        path, and the node table's links and attributes at its names.

        A copy reads its path, so only its ``dst`` changes: the copy is
        a new file there, or a new tree. A create that answers its new
        entry's stat has it kept where its parent's listing names it, in
        place of dropping that listing for a re-list: the create is the
        one change to it, and the next level of a nested create finds
        its parent there.

        Args:
            mount (MountEntry): the mount the write ran on.
            name (str): the write op that ran.
            path (PathSpec): the path it wrote, after any follow.
            kwargs (dict[str, Any]): the op's kwargs; a rename's or a
                copy's ``dst`` is the moved or copied name.
            vis (Visibility | None): the writer's view.
            created (Any): what the op answered; a ``FileStat`` is the
                stat of the entry it created or replaced.
        """
        opened = _appends_nothing(name, kwargs)
        observed = (
            time.time() if name in STAMP_WRITE_OPS and not opened else None
        )
        row = created if isinstance(created, FileStat) else None
        dst = kwargs.get("dst") if name in DESTINATION_OPS else None
        if name in COPY_OPS and isinstance(dst, PathSpec):
            await self.invalidate_after_write(mount, dst, created=row)
            if name == "dir_copy":
                await self._settle_tree_copy(mount, path, dst)
            return
        # rename(2) moves a file without touching its times, which the
        # node table carries to the new name below.
        await self.invalidate_after_write(
            mount,
            path,
            observed=observed,
            times=not opened and name != "rename",
            removed=name in ("unlink", "rmdir", "rm_r"),
            created=None if name == "rename" else row,
        )
        for _, other in _operands(name, kwargs):
            await self.invalidate_after_write(mount, other)
        if name == "rm_r":
            # Everything below went with it: the cached bodies and
            # listings, and the links and overlays only the node table
            # holds there.
            await self._invalidate_tree(mount, path)
            await self._namespace.purge_under(path.virtual)
        if name in ("unlink", "rmdir", "rm_r"):
            # The name no longer holds that file, so what was set on
            # it (overlay mode and owner, extended attributes) goes
            # with it, as the shell's rm already drops it: a file
            # created there next starts bare on every surface.
            await self._namespace.drop_overlay(path.virtual)
            if name == "rmdir":
                # The link check ran before the backend was asked, so
                # a visible link below now was created since: it is
                # younger than this rmdir, lands after it in the
                # serial order (a link synthesizes its parents), and
                # the purge taking the directory's hidden nodes must
                # not take it too.
                links = self._namespace.symlink_targets()
                arrived = frozenset(
                    link
                    for link, _ in self._namespace.link_stats_below(
                        path.virtual
                    )
                    if path_visible(vis, link)
                    and not leads_hidden(vis, link, links)
                )
                await self._namespace.purge_under(path.virtual, keep=arrived)
        if name == "rename" and isinstance(kwargs.get("dst"), PathSpec):
            await self.invalidate_after_rename(mount, path, kwargs["dst"])
            if row is not None:
                await self._keep_created(mount, kwargs["dst"], row)
            # rename(2) replaces the destination, so a node the
            # table holds at that name does not survive the move.
            # A link left there shadowed the file that had just
            # landed: the listing showed the new file, every read
            # followed the old link, and the moved content was
            # reachable under no name at all.
            await self._namespace.unlink(kwargs["dst"].virtual)
            # The subtree moves with it, and only the node table can
            # move the part of it no backend holds: a link or an
            # attr overlay below the source is addressed by absolute
            # path, so it would otherwise stay behind at a name the
            # rename has emptied. The destination's own subtree is
            # replaced first, as rename(2) replaces what it lands on.
            await self._namespace.purge_under(kwargs["dst"].virtual)
            # The node at the source itself is not part of the
            # subtree below it, so re-anchoring that subtree leaves
            # it behind: the mode or ownership a chmod recorded
            # stayed at the emptied name, never reached the
            # landing, and was inherited by whatever was created at
            # the old name next. Shell mv compensates for this in
            # its own prepare step; a verb reaching the dispatcher
            # directly, as git mv does, had nothing to.
            await self._namespace.rename(path.virtual, kwargs["dst"].virtual)
            await self._namespace.rename_under(
                path.virtual, kwargs["dst"].virtual
            )

    async def _evict_failed_write(
        self,
        mount: MountEntry,
        name: str,
        path: PathSpec,
        kwargs: dict[str, Any],
    ) -> None:
        """Drop what a write that raised may have made stale.

        A write that fails partway may already have changed the store (a
        paginated delete, a copy that merged some children), so the
        caches at and below every name it reaches go either way; the
        node table moves only with a write that landed. The version the
        line held for each name is kept, so the next write there stays
        conditioned on what the agent read, and so is each version the
        line marked lost under them, which a refused conditional write
        kept: a retry without a read is refused again. Over-dropping costs
        a refetch. An eviction error is logged, not raised, so the caller
        still learns why the write failed.

        Args:
            mount (MountEntry): the mount the write ran on.
            name (str): the write op that raised.
            path (PathSpec): the path it wrote.
            kwargs (dict[str, Any]): the op's kwargs; a rename's or a
                copy's ``dst`` is the other name it reaches.
        """
        dst = kwargs.get("dst") if name in DESTINATION_OPS else None
        names = [] if name in COPY_OPS else [path]
        if isinstance(dst, PathSpec):
            names.append(dst)
        names.extend(other for _, other in _operands(name, kwargs))
        for target in names:
            try:
                for owner, alias in self._aliases(mount, target):
                    manager = self._manager_for(owner)
                    version = await manager.read_version(alias)
                    await manager.invalidate_subtree(alias)
                    await manager.invalidate_ancestors(alias)
                    if version:
                        await manager.keep_version(alias, version)
            except Exception as exc:
                logger.debug("evicting after a failed %s: %s", name, exc)
        lost = active_lost()
        if lost is None:
            return
        for key in list(lost.marks):
            version = lost.version(key)
            if not version or not any(
                under_path(key, target.virtual) for target in names
            ):
                continue
            try:
                spec = PathSpec.from_str_path(key)
                for owner, alias in self._aliases(mount, spec):
                    await self._manager_for(owner).keep_version(alias, version)
            except Exception as exc:
                logger.debug("keeping %s after a refusal: %s", key, exc)

    async def _settle_tree_copy(
        self, mount: MountEntry, src: PathSpec, dst: PathSpec
    ) -> None:
        """What a tree copy changed under ``dst``: each entry it wrote.

        The copy merges into what ``dst`` already held, so a file it left
        keeps its cached copy and the version a conditional write needs;
        the files and directories it wrote are the source's, listed after
        the copy, so an empty directory it made drops its folder's
        listing too.

        Args:
            mount (MountEntry): the mount the copy ran on.
            src (PathSpec): the copied tree.
            dst (PathSpec): where it landed.
        """
        base = src.virtual.rstrip("/")
        landing = dst.virtual.rstrip("/")
        for virtual in await self._entries_below(mount, src.virtual):
            await self.invalidate_after_write(
                mount, PathSpec.from_str_path(landing + virtual[len(base) :])
            )

    async def _entries_below(self, mount: MountEntry, root: str) -> list[str]:
        """Every file and directory at any depth under ``root``, through
        the mount's own listing.

        Args:
            mount (MountEntry): the mount serving ``root``.
            root (str): absolute virtual directory path.
        """
        entries: list[str] = []
        pending = [root]
        while pending:
            directory = pending.pop()
            for entry in await mount.call("readdir", directory):
                child = entry.rstrip("/")
                entries.append(child)
                row = await mount.call("stat", child)
                if row.type is FileType.DIRECTORY:
                    pending.append(child)
        return entries

    async def _moved_source_is_dir(self, path: PathSpec) -> bool:
        """Whether a rename's source stats as a directory.

        Only a directory can carry hidden content into view, so the
        reveal refusal probes the source before it fires and lets a
        file rename pass. An absent source moves nothing (the rename
        itself reports it); a source the mount cannot classify fails
        toward refusal, the same stance the pattern arm takes.

        Args:
            path (PathSpec): the rename's source.
        """
        mount = self._namespace.try_mount_for(path.virtual)
        if mount is None:
            return True
        try:
            row = await mount.call("stat", path.virtual)
        except (FileNotFoundError, NotADirectoryError):
            return False
        except OSError:
            return True
        return not isinstance(row, FileStat) or row.type is FileType.DIRECTORY

    async def _rmdir_remnants(
        self,
        mount: MountEntry,
        path: PathSpec,
        refusal: OSError,
        rule_gate: EntryGate | None,
        caller: Caller,
    ) -> None:
        """Take a visibly-empty directory's hidden remnants with it.

        The backend refused the rmdir because entries remain, but when
        the session's view of the directory is empty the refusal would
        leak that something invisible exists. A session's mutation may
        destroy what it cannot see, never learn of it, so the remnants
        go with the directory through the shared ``remove_remnants``
        walk; a visible child (in the backend listing or owed by the
        namespace), or any cascade failure (a mode-protected entry, a
        policy-refused deletion, a visible entry appearing mid-walk),
        re-raises the backend's refusal. The folds catch ``Exception``,
        not just ``OSError``, because an API backend's failure is not
        always an errno (box raises its own error type), and a raw
        backend exception here would reveal exactly what the refusal
        exists to hide; cancellation and system exits still propagate.

        Args:
            mount (MountEntry): the mount owning the directory.
            path (PathSpec): the directory being removed.
            refusal (OSError): the backend's not-empty error.
            rule_gate (EntryGate | None): the running command's gate,
                judged on each deletion.
            caller (Caller): who removes the directory.
        """
        vis = caller.visibility
        if not hidden_under(vis, path.virtual):
            raise refusal
        try:
            entries = await mount.call("readdir", path.virtual)
        except Exception as exc:
            # A backend that cannot list (or later, remove) the
            # remnants keeps the original refusal: the dispatcher has no way
            # to take them.
            raise refusal from exc
        # Emptiness is the dispatcher's own readdir pipeline: backend entries
        # merged with the namespace's children (nested mounts, links)
        # and judged by visibility, so a visible child no backend can
        # see keeps the refusal instead of reporting a successful rmdir
        # while the mounted child remains.
        merged = merge_readdir(
            vis,
            entries,
            [m.prefix for m in self._namespace.registry.visible_mounts()],
            self._namespace,
            path.virtual,
        )
        visible = functools.partial(path_visible, vis)
        if not entries or visible_below(path.virtual, merged, visible):
            raise refusal
        channel = _MountChannel(
            mount,
            self._boundary(mount, caller),
            functools.partial(
                self.invalidate_after_write, mount, removed=True
            ),
            rule_gate,
        )
        try:
            await remove_remnants(channel, visible, path)
        except Exception as exc:
            raise refusal from exc
        # The namespace's own nodes under the subtree go with it: a
        # hidden link is invisible to every backend, so the walk above
        # cannot take it, and left in the table it would resurface the
        # removed tree the moment the hide lifts (a link synthesizes
        # its ancestors). Classification proved every link below is
        # hidden -- a visible one contributes its child segment to the
        # merged listing above -- so this is the walk's own
        # revalidate-then-destroy applied to the name plane: a link
        # that became visible mid-cascade keeps the refusal like any
        # visible remnant, and the purge also drops the attr overlays
        # of paths the cascade just destroyed, as ``rm`` does.
        base = path.virtual.rstrip("/") + "/"
        links = self._namespace.symlink_targets()
        links_below = [p for p in links if p.startswith(base)]
        if any(
            path_visible(vis, p) and not leads_hidden(vis, p, links)
            for p in links_below
        ):
            raise refusal
        await self._namespace.purge_under(path.virtual)

    async def _walk_stat(
        self, caller: Caller, path: PathSpec, fresh: bool = False
    ) -> FileStat:
        """The dispatcher's own stat in the shape a chain walk reads.

        Raises when nothing is there, so a dot walk judges a name
        through every plane the dispatcher does: the node table, a mount root,
        another mount, a link it follows.

        Args:
            caller (Caller): who walks.
            path (PathSpec): the path to stat.
            fresh (bool): ask the backend past the mount's index.
        """
        row, _ = await self.dispatch("stat", path, caller=caller, fresh=fresh)
        if row is None:
            raise enoent(path)
        return row

    def _walked(
        self, path: PathSpec, create: bool, vis: Visibility | None
    ) -> PathSpec:
        """``path`` with the links above its final name followed.

        The walked path answers to the session's hides as the typed one
        did, the rule the follow of the final name applies too: a visible
        link must not lead into hidden space.

        Args:
            path (PathSpec): the path as the caller named it.
            create (bool): whether the op creates at the path, which picks
                the voice a hidden landing answers in.
            vis (Visibility | None): the session's view.

        Raises:
            DotWalkLoop: when a link above the name loops (ELOOP), as the
                OSError every caller's per-operand catch words.
        """
        spelled = walk_spelling(path, self._namespace.follow)
        walked = _follow_or_loop(self._namespace, path, False, spelled)
        if spelled != path.virtual:
            walked = posixpath.normpath(walked)
        if walked == path.virtual:
            return path
        if not path_visible(vis, walked):
            raise hidden_refusal(vis, walked, create)
        return PathSpec.from_str_path(walked)

    def _table_answers(
        self, name: str, virtual: str, kwargs: dict[str, Any]
    ) -> bool:
        """Whether the node table answers this op instead of a backend.

        ``symlink`` and ``readlink`` always, because a link exists
        nowhere else. The rest only when the path itself is a link, and
        then for the same reason the create and the read are the dispatcher's:
        forwarding reaches a backend that has never heard of the name.
        A no-follow stat is the read half of that fact (lstat asks for
        the link's own row, which only the table holds); a following
        stat never arrives here, since the follow above rewrote it to
        the target.

        Args:
            name (str): the dispatched op name.
            virtual (str): the op's virtual path.
            kwargs (dict[str, Any]): the op's arguments, read for the
                caller's ``nofollow``.
        """
        if name in NAMESPACE_TABLE_OPS:
            return True
        if name not in LINK_ENTRY_OPS:
            return False
        if name == "stat" and not kwargs.get("nofollow"):
            return False
        return self._namespace.is_link(virtual)

    async def _table_call(
        self,
        name: str,
        path: PathSpec,
        kwargs: dict[str, Any],
        report: OpReport | None,
        caller: Caller,
    ) -> Any:
        """Answer a node-table op in the dispatcher, gated like a backend.

        A symlink is namespace state with no backend behind it, so the
        dispatcher owns every verb that names one. Admission still fires
        exactly as for a backend write: the link's turf is the longest
        mount prefix above it (the same ownership rule ``_link_allowed``
        reads for), session grants and both gates run, and the write
        leaves an OpRecord — a scoped kernel mount refuses exactly like
        a scoped shell. The turf's mode gates the write too
        (``MountModePolicy`` at the ``Boundary``), so a read-only
        mount or grant answers EROFS for a link exactly as for a file;
        a link above every mount is bare namespace structure, gated
        with an empty prefix and governed by ``/``. A rename's
        destination is judged on its own turf, since the endpoints need
        not share one.

        Args:
            name (str): ``symlink`` or ``readlink``, or the ``unlink``,
                ``rename`` or no-follow ``stat`` of a path the node
                table holds a link for.
            path (PathSpec): the link's own path, never followed.
            kwargs (dict[str, Any]): op arguments (``target`` for
                symlink, ``dst`` for rename).
            report (OpReport | None): the caller's report, stamped when
                the answer is in hand.
            caller (Caller): who makes the op.
        """
        timer = start_op()
        mount = self._namespace.try_mount_for(path.virtual)
        boundary = self._boundary(mount, caller)
        write = name in POLICY_WRITE_OPS
        mark = CALLS[name]
        await boundary.admit(mark, path, write, final=name != "rename")
        result: str | FileStat | None = None
        if name == "unlink":
            target = self._namespace.readlink(path.virtual) or ""
            await self._namespace.unlink(path.virtual)
        elif name == "rename":
            target = self._namespace.readlink(path.virtual) or ""
            dst = kwargs["dst"]
            # The destination is a create there, gated like the source
            # and on its own turf, the way the backend path gates both
            # ends of a rename. It is then replaced as rename(2)
            # replaces it: any node the table holds at that name (a
            # link, an attr overlay) goes.
            dst_mount = self._namespace.try_mount_for(dst.virtual)
            await self._boundary(dst_mount, caller).admit(
                mark._replace(creates=True), dst, True
            )
            # The name the link moves to must have a directory above it,
            # as for a new link: the table alone would file it under an
            # absent parent and synthesize the directories above it.
            refusal = await self._parent_refusal(dst, caller)
            if refusal is not None:
                raise refusal
            if not self._namespace.is_link(dst.virtual):
                kind = await self._entry_type(dst.virtual, caller)
                if kind == FileType.DIRECTORY:
                    raise eisdir(dst.virtual)
                if kind is not None:
                    await self.dispatch("unlink", dst, caller=caller)
            await self._namespace.unlink(dst.virtual)
            await self._namespace.rename(path.virtual, dst.virtual)
        elif name == "symlink":
            target = str(kwargs["target"])
            # symlink(2) refuses an occupied name and a name its parent
            # cannot hold, and the dispatcher is the only place that can tell:
            # the node table sees a link, and a probe sees what a backend
            # holds. Left unchecked, the new node shadowed live data (the
            # bytes stayed, the name read as a link), could bury a mount
            # root, which is the one name a deployment configured, and
            # under an absent parent was an orphan that invented the
            # directories above it.
            refusal = await self._symlink_refusal(path, caller)
            if refusal is not None:
                raise refusal
            await self._namespace.symlink(path.virtual, target, time.time())
        elif name == "stat":
            row = self._namespace.link_stat_at(path.virtual)
            if row is None:
                raise enoent(path.virtual)
            target = self._namespace.readlink(path.virtual) or ""
            result = row
        else:
            found = self._namespace.readlink(path.virtual)
            if found is None:
                raise await self._readlink_miss(path, caller)
            target = found
            result = found
        record(
            name,
            path.virtual,
            VFSName.RAM.value,
            len(encode_text(target)),
            timer,
        )
        _memory_answered(report)
        return await boundary.complete(mark, path, write, result)

    async def _readlink_miss(self, path: PathSpec, caller: Caller) -> OSError:
        """The error a readlink of something that is not a link answers.

        readlink(2) splits the two misses and callers read them
        differently: a path that is there but is not a link is EINVAL,
        and one that is not there at all is ENOENT, which is the code a
        guest's ``except FileNotFoundError`` catches. The node table
        only knows the first half, so absence is probed here and only
        here, on the failure path, where one extra round trip buys the
        right errno.

        Args:
            path (PathSpec): the path the readlink named.
            caller (Caller): who asked.
        """
        present, _ = await self._occupancy(path, caller)
        if present:
            return einval(path.virtual)
        return enoent(path.virtual)

    async def _occupancy(
        self, path: PathSpec, caller: Caller
    ) -> tuple[bool, list[str] | None]:
        """Whether anything at all is at `path`, and the parent's listing.

        Four channels, asked in the order of what they prove. The
        namespace goes first: a link, and a directory that exists only
        because a mount or a link sits below it, are structure no
        backend can see, and a mount root is the deployment's own
        configuration. Then the backend's row, which settles a file. A
        directory row settles nothing, because an API tree synthesizes
        its directories: a postgres schema lists ``tables/`` and
        ``views/`` before anything has asked whether that schema is
        there, and a grouping mount stats every path under a live
        collection as a directory. So a directory is proven the way the
        hierarchy kit itself proves one, by appearing in its parent's
        listing, which is also the only way a prefix store can answer
        for a directory that is nothing but a set of keys. Cannot reuse
        ``resolve_path_stat``: that dispatches, and the dispatcher is what
        dispatch is inside of.

        The parent's listing comes back beside the answer, None when no
        probe reached it or it gave none, because a listing with entries
        in it also proves the parent a directory: a create in a directory
        that holds anything costs no round trip beyond this one.

        Args:
            path (PathSpec): the path to probe.
            caller (Caller): who asked.
        """
        if self._namespace.is_link(path.virtual):
            return True, None
        prefixes = [
            m.prefix for m in self._namespace.registry.visible_mounts()
        ]
        if (
            namespace_stat(
                caller.visibility, prefixes, self._namespace, path.virtual
            )
            is not None
        ):
            return True, None
        mount = self._namespace.try_mount_for(path.virtual)
        if mount is None:
            return False, None
        if norm_dir(mount.prefix) == norm_dir(path.virtual):
            return True, None
        try:
            row = await self._probe_read("stat", mount, path, caller)
            if row is not None and row.type is not FileType.DIRECTORY:
                return True, None
            listing = await self._parent_listing(path, caller)
        except (PolicyError, PolicyDenied):
            # A channel that refuses to answer is not evidence of
            # absence. Reporting "present" keeps the answer at the EINVAL
            # every miss gave before the split, which asserts nothing the
            # policy is withholding; reporting absence would assert a
            # fact the dispatcher was not allowed to check.
            return True, None
        return listing is not None and _lists(listing, path.virtual), listing

    async def _symlink_refusal(
        self, path: PathSpec, caller: Caller
    ) -> OSError | None:
        """What symlink(2) answers instead of making a link at `path`.

        None when the link can be made. The name must be free (EEXIST)
        and its parent a directory (``_parent_refusal``), both read off
        the probes ``_occupancy`` makes: a parent whose listing answered
        with entries is a directory, so only an empty or silent parent is
        walked, which is the failure path nearly always.

        Args:
            path (PathSpec): the link's own path, the links above it
                already walked.
            caller (Caller): who makes the link.
        """
        present, listing = await self._occupancy(path, caller)
        if present:
            return eexist(path.virtual)
        if listing:
            return None
        return await self._parent_refusal(path, caller)

    async def _parent_refusal(
        self, path: PathSpec, caller: Caller
    ) -> OSError | None:
        """The errno the parent chain of a name being created answers.

        symlink(2) and rename(2) resolve the directory a name goes in
        before they look at the name: ENOENT when it is absent and
        ENOTDIR when a non-directory stands anywhere in the chain. The
        chain is walked upward until something is there, as ``dest_kind``
        walks a copy's destination, because a store answers a path under
        a plain file with the same miss as an absent one: the parent
        itself being a directory is the one clean answer, a directory
        higher up means the components below it are absent, and anything
        else is ENOTDIR. None when the parent is a directory, and when a
        policy closes a channel, which proves nothing either way.

        Args:
            path (PathSpec): the name being created, the links above it
                already walked.
            caller (Caller): who creates it.
        """
        immediate = parent(norm(path.virtual))
        node = immediate
        try:
            kind = await self._entry_type(node, caller)
            while kind is None:
                node = parent(node)
                kind = await self._entry_type(node, caller)
        except NotADirectoryError:
            # A store that sees the file in the chain answers the probe
            # itself with ENOTDIR, which is the verdict.
            kind = FileType.FILE
        except (PolicyError, PolicyDenied):
            return None
        if kind is not FileType.DIRECTORY:
            return enotdir(path.virtual)
        if node != immediate:
            return enoent(path.virtual)
        return None

    async def _entry_type(
        self, virtual: str, caller: Caller
    ) -> FileType | None:
        """The type of what stands at `virtual`, None when nothing does.

        The channels ``_occupancy`` asks, for a path the walk above a new
        name reaches: namespace structure and a mount root are
        directories, then the backend's row, then the path's own entry in
        its parent's listing, which is how a prefix store holds a
        directory that is nothing but a set of keys.

        Args:
            virtual (str): a normalized absolute virtual path.
            caller (Caller): who asked.
        """
        if virtual == "/":
            return FileType.DIRECTORY
        prefixes = [
            m.prefix for m in self._namespace.registry.visible_mounts()
        ]
        if (
            namespace_stat(
                caller.visibility, prefixes, self._namespace, virtual
            )
            is not None
        ):
            return FileType.DIRECTORY
        mount = self._namespace.try_mount_for(virtual)
        if mount is None:
            return None
        if norm_dir(mount.prefix) == norm_dir(virtual):
            return FileType.DIRECTORY
        spec = PathSpec.from_str_path(virtual)
        row = await self._probe_read("stat", mount, spec, caller)
        if row is not None:
            return row.type
        listing = await self._parent_listing(spec, caller)
        if listing is not None and _lists(listing, virtual):
            return FileType.DIRECTORY
        return None

    async def _parent_listing(
        self, path: PathSpec, caller: Caller
    ) -> list[str] | None:
        """The backend listing of the directory `path` sits in.

        None when no mount serves that directory, its backend lists
        nothing there, or the path has no name to sit in one.

        Args:
            path (PathSpec): the path whose parent to list.
            caller (Caller): who asked.
        """
        above, _, name = path.virtual.rstrip("/").rpartition("/")
        mount = self._namespace.try_mount_for(above or "/")
        if not name or mount is None:
            return None
        return await self._probe_read(
            "readdir", mount, PathSpec.from_str_path(above or "/"), caller
        )

    async def _probe_read(
        self, name: str, mount: MountEntry, path: PathSpec, caller: Caller
    ) -> Any:
        """Run one read op for a probe, or None when it found nothing.

        The probe reads on the caller's behalf but not at its request, so
        it passes the same admission gate the op would at the dispatcher: a
        policy that denies ``stat`` must not be reachable through a
        readlink. That refusal is raised, not swallowed, because only the
        caller knows what to answer when a channel goes dark.

        Args:
            name (str): ``stat`` or ``readdir``.
            mount (MountEntry): the mount owning the path.
            path (PathSpec): the path to probe.
            caller (Caller): who asked.
        """
        if not mount.answers_at(name, path.virtual):
            return None
        boundary = self._boundary(mount, caller)
        await boundary.admit(CALLS[name], path, False)
        try:
            result = await mount.call(name, path.virtual)
            return await boundary.complete(CALLS[name], path, False, result)
        except NotADirectoryError:
            # Final on every channel: a plain file above the path means
            # nothing can be at it or under it, and symlink(2) and
            # readlink(2) answer with this errno.
            raise
        except MISS_ERRORS:
            # The "nothing here" set exactly: a miss on one channel is
            # not absence on its own, so the caller tries the other.
            return None

    async def _answer_xattr(
        self,
        name: str,
        path: PathSpec,
        kwargs: dict[str, Any],
        report: OpReport | None,
        caller: Caller,
    ) -> bytes | list[str] | None:
        """Answer an extended-attribute op from the node table.

        The attributes a caller sets live on the path's node, so they
        survive on a backend that has no such slot and move with a
        rename. The listing is sorted, so both hosts and every backend
        agree on its order.
        Gated like a setattr: both admission gates fire on the path's
        turf, and a write needs a writable turf.

        Args:
            name (str): ``getxattr``, ``listxattr``, ``setxattr`` or
                ``removexattr``.
            path (PathSpec): the path, already followed unless the
                caller asked for its link node itself.
            kwargs (dict[str, Any]): ``name`` for all but listxattr,
                ``value`` and the ``create``/``replace`` flags for
                setxattr.
            report (OpReport | None): the caller's report.
            caller (Caller): who makes the op.
        """
        timer = start_op()
        mount = self._namespace.try_mount_for(path.virtual)
        boundary = self._boundary(mount, caller)
        write = name in POLICY_WRITE_OPS
        await boundary.admit(CALLS[name], path, write)
        await self._xattr_target(mount, path, caller.visibility)
        stored = self._namespace.xattrs(path.virtual)
        attr = str(kwargs.get("name", ""))
        result: bytes | list[str] | None = None
        if name == "listxattr":
            result = sorted(stored)
        elif name == "getxattr":
            found = stored.get(attr)
            if found is None:
                raise no_xattr(path)
            result = found
        elif name == "setxattr":
            if kwargs.get("create") and attr in stored:
                raise eexist(path.virtual)
            if kwargs.get("replace") and attr not in stored:
                raise no_xattr(path)
            await self._namespace.set_xattr(
                path.virtual, attr, bytes(kwargs.get("value") or b"")
            )
        else:
            if attr not in stored:
                raise no_xattr(path)
            await self._namespace.remove_xattr(path.virtual, attr)
        record(
            name,
            path.virtual,
            VFSName.RAM.value,
            len(result) if isinstance(result, bytes) else 0,
            timer,
        )
        if report is not None:
            report.served(None, None)
        return await boundary.complete(CALLS[name], path, write, result)

    async def _statfs(
        self, path: PathSpec, caller: Caller
    ) -> tuple[str, CapacityResult]:
        """Answer statfs(2) for a path: the type name and the capacity of
        the mount that holds it, which is what df reports for that mount.

        The path must exist, as statfs's own walk requires. The namespace
        above every mount has no file system behind it, so its type is
        ``-`` and its capacity unknown.

        Args:
            path (PathSpec): the path, already followed.
            caller (Caller): who asked.
        """
        mount = self._namespace.try_mount_for(path.virtual)
        boundary = self._boundary(mount, caller)
        statfs = VfsCall("statfs", Effect.METADATA, Target.ANY, False)
        await boundary.admit(statfs, path, False)
        await self._xattr_target(mount, path, caller.visibility)
        answer: tuple[str, CapacityResult]
        if mount is None:
            answer = "-", CapacityResult(state=CapacityState.UNKNOWN)
        else:
            async with mount.use():
                answer = mount.vfs.name, await mount.vfs.capacity()
        # A policy may deny the reply as it may any op's; a capacity is
        # no bytes, so a bound has nothing to cap.
        await boundary.complete(statfs, path, False, answer)
        return answer

    async def _xattr_target(
        self, mount: MountEntry | None, path: PathSpec, vis: Visibility | None
    ) -> None:
        """Settle that an attribute op's path exists, which it answers first.

        A link node's own attributes and a directory that exists only in
        the namespace have no backend behind them; anything else the
        backend's stat must find, or the op is ENOENT.

        Args:
            mount (MountEntry | None): the mount owning the path.
            path (PathSpec): the path the op names.
            vis (Visibility | None): the session's view.
        """
        if self._namespace.is_link(path.virtual):
            return
        stat: FileStat | None = None
        missing: OSError | None = None
        if mount is not None:
            await mount.ensure_ready()
            try:
                stat = await mount.call("stat", path.virtual)
            except (FileNotFoundError, NotADirectoryError) as exc:
                missing = exc
                await self._reconciler.on_enoent(mount, "stat", path.virtual)
        if stat is not None or isinstance(
            self._namespace_result("stat", path.virtual, vis), FileStat
        ):
            return
        if mount is None:
            raise no_mount(path.virtual)
        if isinstance(missing, NotADirectoryError):
            raise missing
        raise enoent(path)

    async def _apply_setattr(
        self,
        mount: MountEntry,
        path: PathSpec,
        kwargs: dict[str, Any],
        vis: Visibility | None,
    ) -> dict[str, Any]:
        """Apply attributes natively where the backend can, overlay the rest.

        A mount with a native setattr op applies what it can and returns
        the residual; residual fields go to the overlay and natively
        applied ones are dropped from it, so a stale overlay never
        shadows a fresh backend value, and the cached stat and listing
        that still carry the old value go too. A backend that applied
        nothing may not have looked for the path, so it is settled
        before the overlay takes the fields. A mount without the op, and
        a link path (which has no backend inode), overlay everything. The
        overlay half is the dispatcher's own write, so it runs inside the
        same gates as the native half.

        Args:
            mount (MountEntry): the mount owning the path.
            path (PathSpec): target path.
            kwargs (dict[str, Any]): the requested attribute fields.
            vis (Visibility | None): the session's view.
        """
        requested = {key: kwargs.get(key) for key in SETATTR_KEYS}
        if self._namespace.is_link(path.virtual) or not mount.answers_at(
            "setattr", path.virtual
        ):
            # No backend inode answers for the path here, so nothing
            # would refuse a missing one: the overlay would stamp it.
            await self._xattr_target(mount, path, vis)
            return await self._overlay_setattr(path, kwargs)
        residual = await mount.call("setattr", path.virtual, **kwargs)
        applied = [
            key
            for key, value in requested.items()
            if value is not None and key not in residual
        ]
        if applied:
            await self._namespace.drop_attrs(path.virtual, applied)
            await self.invalidate_after_write(mount, path, times=False)
        else:
            await self._xattr_target(mount, path, vis)
        if residual:
            await self._write_overlay(path.virtual, residual)
        return dict(residual)

    async def _overlay_setattr(
        self, path: PathSpec, kwargs: dict[str, Any]
    ) -> dict[str, Any]:
        """Store every requested field in the namespace overlay.

        Args:
            path (PathSpec): target path.
            kwargs (dict[str, Any]): the requested attribute fields.
        """
        timer = start_op()
        overlay = {
            key: value
            for key in SETATTR_KEYS
            if (value := kwargs.get(key)) is not None
        }
        await self._write_overlay(path.virtual, overlay)
        record("setattr", path.virtual, VFSName.RAM.value, 0, timer)
        return overlay

    async def _write_overlay(
        self, virtual: str, fields: dict[str, Any]
    ) -> None:
        """Write one overlay entry, converting an ISO mtime to epoch.

        Args:
            virtual (str): absolute virtual path.
            fields (dict[str, Any]): attribute fields to store.
        """
        mtime = fields.get("mtime")
        if isinstance(mtime, str):
            mtime = datetime.fromisoformat(mtime).timestamp()
        await self._namespace.set_attrs(
            virtual,
            mode=fields.get("mode"),
            uid=fields.get("uid"),
            gid=fields.get("gid"),
            atime=fields.get("atime"),
            mtime=mtime,
        )

    async def keep_versions(
        self,
        records: list[OpRecord],
        cache_facts: Callable[[str], CacheFacts],
        nested: bool = False,
    ) -> None:
        """Keep the version each path last had on a line that ended.

        Args:
            records (list[OpRecord]): the line's records.
            cache_facts (Callable[[str], CacheFacts]): the facts of the
                mounts the line started with.
            nested (bool): a nested line's, which keeps only the
                versions of paths still lost.
        """
        await cache_io.keep_versions(
            self._cache, records, cache_facts, active_lost(), nested
        )

    def capture_cache_facts(self) -> Callable[[str], CacheFacts]:
        """Bind the end of a line to the mounts it started with.

        The mount table is pinned at the line's start, so a version kept
        when it ends is judged by the mount that produced it rather than
        whatever holds the prefix by then.
        """
        mounts = {
            m.prefix: m for m in self._namespace.registry.visible_mounts()
        }

        def facts(path: str) -> CacheFacts:
            prefix = owner_prefix(mounts, path)
            original = mounts.get(prefix) if prefix is not None else None
            mount = self._namespace.try_mount_for(path)
            return _facts_of(mount if original is mount else None)

        return facts

    def _manager_for(self, mount: MountEntry) -> CacheManager:
        """The cache manager that owns a mount's listings and bodies.

        Args:
            mount (MountEntry): the mount that was written.
        """
        manager = mount.cache_manager
        if manager is None:
            manager = CacheManager(
                self._cache,
                mount.index_store,
                mount.prefix,
                mount.vfs.caches_reads,
            )
        return manager

    async def invalidate_after_write(
        self,
        mount: MountEntry,
        path: PathSpec,
        observed: float | None = None,
        times: bool = True,
        removed: bool = False,
        created: FileStat | None = None,
    ) -> None:
        """Drop what a write to ``path`` made stale above the store.

        Args:
            mount (MountEntry): the mount the write ran on.
            path (PathSpec): the path it wrote.
            observed (float | None): epoch seconds of a content write to
                record, None for a removal.
            times (bool): drop the overlay times a content write moves;
                False for an open that wrote nothing.
            removed (bool): the write removed ``path`` (unlink, rmdir),
                so its own listing goes too, as a core's removal drops it.
            created (FileStat | None): the stat of what the write made at
                ``path``, kept in its parent's listing instead of
                dropping that listing; None to drop it.
        """
        for owner, name in self._aliases(mount, path):
            if times:
                await self._namespace.clear_times(
                    name.virtual, observed=observed
                )
            manager = self._manager_for(owner)
            if removed:
                await manager.invalidate_after_unlink(name)
            elif created is not None:
                await manager.keep_created(name, created)
            else:
                await manager.invalidate_after_write(name)
            await manager.invalidate_ancestors(name)

    async def _keep_created(
        self, mount: MountEntry, path: PathSpec, row: FileStat
    ) -> None:
        """Keep a moved entry's stat where its new parent's listing names
        it, under every mount of its store.

        Args:
            mount (MountEntry): the mount the move ran on.
            path (PathSpec): where the entry landed.
            row (FileStat): its stat there.
        """
        for owner, name in self._aliases(mount, path):
            await self._manager_for(owner).keep_created(name, row)

    async def _invalidate_tree(
        self, mount: MountEntry, path: PathSpec
    ) -> None:
        """Drop everything cached at and below ``path``, and its parents'
        listings, under every mount of its store.

        Args:
            mount (MountEntry): the mount the tree was changed through.
            path (PathSpec): the tree's root.
        """
        for owner, name in self._aliases(mount, path):
            manager = self._manager_for(owner)
            await manager.invalidate_subtree(name)
            await manager.invalidate_ancestors(name)

    async def invalidate_after_rename(
        self, mount: MountEntry, source: PathSpec, dst: PathSpec
    ) -> None:
        """Drop everything cached below both ends of a rename.

        A rename re-anchors the whole subtree under its source, so the
        listings and bodies cached one level down under either name
        are stale, not just the two paths and their parents. Evicting
        only those left a moved directory's old name answering ``stat``
        and ``ls`` from its cached children, so the next rename onto
        that name saw a directory that was no longer there.

        Args:
            mount (MountEntry): the mount the rename ran on.
            source (PathSpec): the name the subtree left.
            dst (PathSpec): the name it now lives under.
        """
        for owner, src in self._aliases(mount, source):
            await self._manager_for(owner).invalidate_subtree(src)
        for owner, to in self._aliases(mount, dst):
            manager = self._manager_for(owner)
            await manager.invalidate_subtree(to)
            await manager.invalidate_ancestors(to)

    def _aliases(
        self, mount: MountEntry, path: PathSpec
    ) -> list[tuple[MountEntry, PathSpec]]:
        """``path`` under each mount of its store, its own mount first.

        One store mounted at two prefixes holds one file under two names,
        so what a write makes stale under one name is stale under each. A
        name another mount holds is that mount's file and is left out.

        Args:
            mount (MountEntry): the mount the path was reached through.
            path (PathSpec): the path written.
        """
        key = mount_key(path.virtual, mount.prefix.rstrip("/"))
        found = [(mount, path)]
        for other in self._namespace.registry.visible_mounts():
            if other is mount or other.vfs is not mount.vfs:
                continue
            base = other.prefix.rstrip("/")
            name = PathSpec.from_str_path(
                f"{base}/{key}" if key else base or "/"
            )
            if self._namespace.try_mount_for(name.virtual) is other:
                found.append((other, name))
        return found
