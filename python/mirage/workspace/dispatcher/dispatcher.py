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
import functools
import os
import posixpath
import time
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager, AsyncExitStack
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from mirage.cache.file import io as cache_io
from mirage.cache.lock import KeyLock
from mirage.cache.manager import CacheManager
from mirage.commands.builtin.utils.paths import dot_refusal, walk_spelling
from mirage.commands.resolve import get_extension
from mirage.context import (
    explaining,
    get_current_session,
    hidden_refusal,
    session_visibility,
)
from mirage.io import IOResult, OpReport
from mirage.observe.context import record, start_op
from mirage.observe.record import OpRecord
from mirage.ops.boundary import OpBoundary
from mirage.ops.config import NO_FOLLOW_OPS, STAMP_WRITE_OPS
from mirage.ops.namespace_view import (
    merge_readdir,
    namespace_listing,
    namespace_stat,
)
from mirage.policy.errors import PolicyDenied, PolicyError
from mirage.shell.bytes import encode_text
from mirage.types import (
    DEFAULT_READ_TTL,
    CacheFacts,
    CapacityResult,
    CapacityState,
    EntryGate,
    FileStat,
    FileType,
    MountMode,
    PathSpec,
    VFSName,
)
from mirage.utils.errors import (
    MISS_ERRORS,
    eisdir,
    eloop,
    enoent,
    exdev,
    no_mount,
    no_xattr,
    walk_refusal,
)
from mirage.utils.hidden import hidden_under, move_reveals, path_visible
from mirage.utils.key_prefix import mount_key
from mirage.utils.path import CycleError, norm, norm_dir, owner_prefix, parent
from mirage.utils.ranges import slice_window
from mirage.utils.remnants import remove_remnants, visible_below
from mirage.workspace.dispatcher.constants import (
    DISPATCH_READ_OPS,
    DISPATCH_WRITE_OPS,
    ENTRY_CREATE_OPS,
    FILE_CREATE_OPS,
    HIDDEN_CREATE_OPS,
    LINK_ENTRY_OPS,
    NAMESPACE_TABLE_OPS,
    POLICY_WRITE_OPS,
    SERIAL_WRITE_OPS,
    SETATTR_KEYS,
    XATTR_OPS,
)
from mirage.workspace.mount import MountEntry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.mount.namespace.overlay import merge_overlay_stat
from mirage.workspace.reconcile import Reconciler
from mirage.workspace.snapshot.drift import DriftQueue


def _memory_answered(
    report: OpReport | None, moved: int | None = None
) -> None:
    """Stamp the caller's report: memory answered, no backend ran.

    Fires at the moment a warm file-cache hit or a synthetic namespace
    answer is in hand, before the post gate and any output cap, so
    whatever those raise cannot erase the fact. The value is
    ``VFSName.RAM``, which is how a record says "this never
    crossed the network": ``OpRecord.is_cache`` is defined as that
    string, and every network/cache total derives from it.

    Args:
        report (OpReport | None): the caller's report, None when the
            caller does not observe ops.
        moved (int | None): bytes memory served, None when the result
            is the measure.
    """
    if report is not None:
        report.served(VFSName.RAM.value, moved)


def _served(report: OpReport | None, result: Any) -> None:
    """Stamp the caller's report: the owning mount answered.

    Args:
        report (OpReport | None): the caller's report, None when the
            caller does not observe ops.
        result (Any): the op's answer; bytes are the measure moved.
    """
    if report is not None:
        report.served(
            None,
            len(result) if isinstance(result, (bytes, bytearray)) else None,
        )


def _appends_nothing(op: str, kwargs: dict[str, Any]) -> bool:
    """Whether a completed write op was an append of no bytes.

    That is an open for appending (``true >> f``): it may create the
    file, but it leaves an existing one's times as they were.

    Args:
        op (str): the write op that ran.
        kwargs (dict[str, Any]): its kwargs; an append's ``data``.
    """
    return op == "append" and not kwargs.get("data")


def _visible_entries(entries: list[str], parent: str) -> list[str]:
    """Drop listing entries the bound session hides.

    Entry shapes vary by backend (bare names, trailing-slash names,
    full paths), so each is keyed by its final segment against the
    listed directory, the same normalization ``merge_readdir`` dedups
    by.

    Args:
        entries (list[str]): the merged listing.
        parent (str): the directory that was listed, as a virtual path.
    """
    base = parent.rstrip("/")
    vis = session_visibility()
    return [
        e
        for e in entries
        if path_visible(vis, f"{base}/{e.rstrip('/').rsplit('/', 1)[-1]}")
    ]


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


def _session_id() -> str:
    """The id of the session this door serves, empty for the unbound
    host view; the same binding the hides and modes above read.
    """
    sess = get_current_session()
    return sess.session_id if sess is not None else ""


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
    ``Mount.execute_op``, the same door a first-class op takes, so the
    mode axis refuses a protected path exactly as normal dispatch
    would. Only the dispatcher's own visibility filter sits above that
    door, which is what lets the cascade see hidden entries.

    Each deletion answers the same pre-ops admission a dispatched op
    answers, with its own child path: the gate that admitted the rmdir
    judged the directory, not what the cascade found under it, and a
    policy that protects one of those paths must refuse its deletion
    exactly as it would refuse a first-class op. Each deletion also
    discharges the dispatcher's own write invalidation, the way normal
    dispatch does for its one op and the TS ``fencedCall`` does per
    call: ``execute_op`` runs outside the cache-manager context command
    execution establishes, so the cores' invalidation cannot land, and
    the dispatch-level invalidation of the rmdir target covers the root
    and its ancestors, never the cascade's descendants. Invalidation
    runs even when the op fails: a missing-path failure means the tree
    changed under the walk, and the walk's own earlier listing is
    exactly the entry that must not survive.

    Args:
        mount (MountEntry): the mount owning the subtree.
        boundary (OpBoundary): the dispatcher's op boundary for that
            mount; its admit raises to refuse a deletion. A deletion is
            not completed through post_ops, which could only refuse
            after the entry is gone and strand the cascade.
        invalidate (Callable): the dispatcher's write invalidation,
            bound to that mount.
    """

    mount: MountEntry
    boundary: OpBoundary
    invalidate: Callable[[PathSpec], Awaitable[None]]

    async def readdir(self, spec: PathSpec) -> list[str]:
        return await self.mount.execute_op("readdir", spec.virtual)

    async def stat(self, spec: PathSpec) -> FileStat:
        return await self.mount.execute_op("stat", spec.virtual)

    async def unlink(self, spec: PathSpec) -> None:
        await self.boundary.admit("unlink", spec, True, check_hidden=False)
        try:
            await self.mount.execute_op("unlink", spec.virtual)
        finally:
            await self.invalidate(spec)

    async def rmdir(self, spec: PathSpec) -> None:
        await self.boundary.admit("rmdir", spec, True, check_hidden=False)
        try:
            await self.mount.execute_op("rmdir", spec.virtual)
        finally:
            await self.invalidate(spec)


def _judge(gate: EntryGate, *paths: PathSpec | None) -> None:
    """Ask a command's gate once about each distinct path an op reaches.

    Args:
        gate (EntryGate): the gate the command was admitted under.
        *paths (PathSpec | None): the spellings in the order the door
            met them; None (no rename destination) is skipped.
    """
    for virtual in dict.fromkeys(
        p.virtual for p in paths if isinstance(p, PathSpec)
    ):
        gate.check(virtual)


class Dispatcher:
    """Route a single VFS op to its mount and keep the file cache + index
    consistent.

    Owns the cache/IO coordination that used to live on Workspace: cache
    lookups for read-caching backends, post-write file-cache eviction,
    and parent index invalidation. Constructed with the namespace (for
    addressing), cache store, and consistency policy; holds no other
    workspace state. The snapshot drift queue rides along because this
    is the one door: a strict restore's pending fingerprint checks must
    run before ANY op can touch a mount, and FUSE and the ops facade
    reach here without passing Workspace.dispatch. So does the
    workspace's write admission, which holds a write while a capture
    reads.
    """

    def __init__(
        self,
        namespace: Namespace,
        cache,
        drift: DriftQueue | None = None,
        admit_write: Callable[[], AbstractAsyncContextManager[None]]
        | None = None,
    ) -> None:
        self._namespace = namespace
        self._cache = cache
        self._reconciler = Reconciler(cache, namespace)
        self._drift = drift
        self._admit_write = admit_write
        self._writers = KeyLock()

    def _boundary(self, mount: MountEntry | None) -> OpBoundary:
        """The policy boundary for an op on a path ``mount`` owns.

        The mount's prefix and mode, or for a path above every mount an
        empty prefix and full write, governed by ``/``
        (``MountModePolicy``).

        Args:
            mount (MountEntry | None): the mount owning the path, None
                when no mount does.
        """
        return OpBoundary(
            self._namespace.registry.policies,
            mount.prefix if mount is not None else "",
            mount.mode if mount is not None else MountMode.WRITE,
            _session_id(),
            self._namespace.registry.decisions,
        )

    @property
    def reconciler(self) -> Reconciler:
        return self._reconciler

    def _namespace_result(
        self, op: str, virtual: str
    ) -> list[str] | FileStat | None:
        """The namespace's own answer for a path no backend serves.

        Child mounts and symlinks are structure the door owns, so a
        directory that exists only because a mount or link sits below it
        still lists and stats. None for any other op, or when the
        namespace knows nothing at ``virtual``.

        Args:
            op (str): the dispatched op name.
            virtual (str): the virtual path being answered.
        """
        prefixes = [
            m.prefix for m in self._namespace.registry.visible_mounts()
        ]
        vis = session_visibility()
        if op == "readdir":
            return namespace_listing(vis, prefixes, self._namespace, virtual)
        if op == "stat":
            return namespace_stat(vis, prefixes, self._namespace, virtual)
        return None

    async def _gated_namespace(
        self,
        op: str,
        path: PathSpec,
        fallback: "list[str] | FileStat",
        report: OpReport | None,
    ) -> Any:
        """Gate a namespace-served answer exactly like a backend one.

        The answer has no owning prefix (the gates see ""), but
        admission still fires: a policy that bounds readdir or stat by
        path must cover the synthetic answer too.

        Args:
            op (str): the dispatched op name.
            path (PathSpec): the op's path scope.
            fallback (list[str] | FileStat): the namespace's answer.
            report (OpReport | None): the caller's report, stamped when
                the answer is in hand.
        """
        boundary = self._boundary(None)
        write = op in POLICY_WRITE_OPS
        # A pre gate refuses before the answer exists, so it is not a
        # completed op and stays before the stamp.
        await boundary.admit(op, path, write)
        _memory_answered(report)
        if op == "readdir" and isinstance(fallback, list):
            fallback = _visible_entries(fallback, path.virtual)
        return await boundary.complete(op, path, write, fallback)

    async def dispatch(
        self,
        op: str,
        path: PathSpec,
        *,
        report: OpReport | None = None,
        **kwargs: Any,
    ) -> tuple[Any, IOResult]:
        if self._admit_write is None or op not in POLICY_WRITE_OPS:
            return await self._dispatch(op, path, report=report, **kwargs)
        async with self._admit_write():
            return await self._dispatch(op, path, report=report, **kwargs)

    async def _dispatch(
        self,
        op: str,
        path: PathSpec,
        *,
        report: OpReport | None = None,
        **kwargs: Any,
    ) -> tuple[Any, IOResult]:
        # with_dispatch_rule_guard's mark, never forwarded to an op.
        rule_gate: EntryGate | None = kwargs.pop("rule_gate", None)
        await self._namespace.ensure_loaded()
        # Pending fingerprint checks from a strict snapshot restore run
        # before the op can touch a mount, whichever surface called:
        # FUSE and the ops facade come straight here, so a drain that
        # lived any higher would let a first write clobber drifted
        # state. drain() clears pending before it stats, so its own
        # probes cannot recurse into it. A dry run leaves them pending,
        # its policies' reads included: the check is no policy's answer,
        # and the op that does run still owes it.
        if (
            self._drift is not None
            and self._drift.pending
            and explaining() is None
        ):
            await self._drift.drain(self._namespace.registry.try_mount_for)
        # Hidden paths answer before anything else can: the typed path
        # is checked so a link inside hidden space cannot be followed
        # out of it, the followed path is re-checked so a visible link
        # cannot lead in, and a rename destination is a create.
        vis = session_visibility()
        if not path_visible(vis, path.virtual):
            raise hidden_refusal(vis, path.virtual, op in HIDDEN_CREATE_OPS)
        dst = kwargs.get("dst")
        if (
            op == "rename"
            and isinstance(dst, PathSpec)
            and not path_visible(vis, dst.virtual)
        ):
            raise hidden_refusal(vis, dst.virtual, True)
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
        # create of one is EISDIR before anything is looked up.
        if op in FILE_CREATE_OPS and (path.dotted or "").endswith("/"):
            raise eisdir(path)
        follow = self._namespace.follow
        refusal = await dot_refusal(
            self._walk_stat, path, follow, op in ENTRY_CREATE_OPS
        )
        if refusal is None and op == "rename" and isinstance(dst, PathSpec):
            refusal = await dot_refusal(self._walk_stat, dst, follow)
        if refusal is not None:
            raise refusal
        # The kernel walks a path before the call sees it: every link
        # above the final name is followed, whatever the op then does
        # with the name. Command dispatch walks the operands it
        # classifies; this is the same walk for every other caller (a
        # relative word ln resolves itself, the ops facade, a runtime's
        # os.symlink), so a link made, read or removed under a linked
        # directory lands in the directory the link names, not under a
        # name nothing else would look up.
        typed, typed_dst = path, dst
        path = self._walked(path, op in HIDDEN_CREATE_OPS)
        if op == "rename" and isinstance(dst, PathSpec):
            dst = kwargs["dst"] = self._walked(dst, True)
        # The command's gate judges each spelling, as handed in and as
        # walked, once both walks have answered for hidden space: here
        # for an op on the name itself, below the follow for the rest.
        no_follow = op in NO_FOLLOW_OPS or bool(kwargs.get("nofollow"))
        if rule_gate is not None and no_follow:
            _judge(rule_gate, typed, path, typed_dst, dst)
        if op == "rename" and isinstance(dst, PathSpec):
            # A rename re-anchors everything below its source while the
            # hides stay where they are written, so hidden content would
            # land at paths the session can see. Destroying hidden
            # content is silent (rm_r, the remnant rmdir below);
            # relocating it into view is refused. Only a directory has
            # anything below it to re-anchor, so a file source passes.
            if move_reveals(
                vis, path.virtual, dst.virtual
            ) and await self._moved_source_is_dir(path):
                raise PermissionError(
                    errno.EACCES, os.strerror(errno.EACCES), path.virtual
                )
        if (
            op == "rename"
            and isinstance(dst, PathSpec)
            and self._namespace.link_stats_below(dst.virtual)
        ):
            # rename(2) replaces a destination directory only when it
            # is empty, and the node table is half of what empty means
            # here: a link is invisible to every backend, so a
            # destination the backend reads as empty can still hold
            # one. Left to the backend the rename succeeded and the
            # purge below then deleted the link with it, losing
            # namespace state silently where POSIX promises ENOTEMPTY.
            raise OSError(
                errno.ENOTEMPTY, os.strerror(errno.ENOTEMPTY), dst.virtual
            )
        if self._table_answers(op, path.virtual, kwargs):
            return (
                await self._namespace_table_op(op, path, kwargs, report),
                IOResult(),
            )
        # `nofollow` is the caller's AT_SYMLINK_NOFOLLOW: an op that acts
        # on a link entry itself (chown -h writing the link's own attrs)
        # keeps the typed path. Consumed here, never forwarded.
        walked = path
        if op not in NO_FOLLOW_OPS and not kwargs.pop("nofollow", False):
            try:
                followed = self._namespace.follow(path.virtual)
            except CycleError:
                raise eloop(path) from None
            if followed != path.virtual:
                path = PathSpec.from_str_path(followed)
                if not path_visible(vis, path.virtual):
                    raise hidden_refusal(
                        vis, path.virtual, op in HIDDEN_CREATE_OPS
                    )
        if rule_gate is not None and not no_follow:
            _judge(rule_gate, typed, walked, path)
        if op in XATTR_OPS:
            return await self._xattr_op(op, path, kwargs, report), IOResult()
        if op == "statfs":
            return await self._statfs(path), IOResult()
        mount = self._namespace.try_mount_for(path.virtual)
        if mount is None:
            # No mount serves the path, but the namespace may still know
            # a directory there (a deeper mount, a link). No mount means
            # no cache to keep straight. The merged names are
            # session-filtered individually. A setattr lands in the
            # overlay (a link above every mount still takes chown -h),
            # gated exactly like the mounted overlay write.
            if op == "setattr":
                boundary = self._boundary(None)
                await boundary.admit(op, path, True)
                applied = await self._overlay_setattr(path, kwargs)
                _memory_answered(report)
                await boundary.complete(op, path, True, applied)
                return applied, IOResult()
            fallback = self._namespace_result(op, path.virtual)
            if fallback is None:
                raise no_mount(path.virtual)
            return (
                await self._gated_namespace(op, path, fallback, report),
                IOResult(),
            )
        # A mount is a filesystem boundary: rename(2) moves a name within
        # one and answers EXDEV across two, before any permission is
        # weighed, so `mv` falls back to copy and unlink instead of the
        # source's backend taking the destination for one of its keys. It
        # resolves both parent directories first, so a missing one is
        # ENOENT (ENOTDIR through a file) ahead of EXDEV.
        if (
            op == "rename"
            and isinstance(dst, PathSpec)
            and self._namespace.try_mount_for(dst.virtual) is not mount
        ):
            refusal = await self._parent_refusal(path)
            refusal = refusal or await self._parent_refusal(dst)
            raise refusal or exdev(path)
        # Admission policies fire at the door, before the warm-cache
        # early return below: a cached read must be refused exactly
        # like a cold one, or the cache becomes a policy bypass.
        write = op in POLICY_WRITE_OPS
        boundary = self._boundary(mount)
        await boundary.admit(
            op,
            path,
            write,
            create=op in HIDDEN_CREATE_OPS,
            subtree=op == "rename",
            final=op != "rename",
        )
        # A rename's destination is a create there: it passes the same
        # gate as the source, so a path rule holds against moving into
        # a protected scope (or onto the directory that holds one) the
        # way it holds against writing there, under the mode of the
        # mount that owns it.
        if op == "rename" and isinstance(dst, PathSpec):
            await self._boundary(
                self._namespace.try_mount_for(dst.virtual)
            ).admit(op, dst, True, create=True, subtree=True)
        if op == "rmdir" and any(
            path_visible(vis, link)
            for link, _ in self._namespace.link_stats_below(path.virtual)
        ):
            raise OSError(
                errno.ENOTEMPTY, os.strerror(errno.ENOTEMPTY), path.virtual
            )
        await mount.ensure_ready()
        caches_reads = mount.vfs.caches_reads
        # The file cache holds what commands read, keyed on the path
        # alone. A raw read, or a read through a filetype renderer
        # (whoever registered it), asks for a different value under the
        # same key, so it is neither served from that cache nor kept in
        # it. The renderer read still gets the freshness check, so a path
        # the backend reports gone fails.
        raw = "filetype" in kwargs and kwargs["filetype"] is None
        filetype = (
            kwargs["filetype"]
            if "filetype" in kwargs
            else get_extension(path.virtual)
        )

        def renders_read() -> bool:
            return filetype is not None and mount.has_filetype_op(
                "read", filetype
            )

        offset, size = _window(kwargs)
        whole = (offset, size) == (0, None)

        if caches_reads and not raw and op in DISPATCH_READ_OPS:
            cached = await self._cache.get(path.virtual)
            if (
                cached is not None
                and await self._reconciler.may_serve_cached(
                    mount, path.virtual
                )
                and not renders_read()
                and not mount.retiring
                and self._namespace.try_mount_for(path.virtual) is mount
            ):
                # The cache holds the whole object, so a ranged read is
                # answered by slicing it, never by handing back the
                # whole file: the window is what the caller asked for
                # instead of the file, and git reads pack indexes this
                # way. slice_window is the same helper the ranged read
                # op falls back to, so warm and cold agree.
                served = slice_window(cached, offset, size)
                # Nothing crossed the network, and neither a gate nor a
                # hard cap leaves the caller able to tell: without the
                # stamp a refused warm read is recorded against the
                # backend and counted as traffic that never happened.
                _memory_answered(report, len(served))
                served = await boundary.complete(op, path, write, served)
                return served, IOResult(reads={path.virtual: served})

        # A cold read keeps the whole file it fetched for the next reader,
        # through the mount's own manager, the one a command's read
        # fills: a write racing the fetch retires its generation, so the
        # bytes it read are not kept. A ranged read comes from the store
        # only where the store can serve one; elsewhere the read op would
        # fetch the whole file and slice it for every range, so the whole
        # file is read once, kept, and each range sliced from it. The op
        # is resolved only once the mount is ready, so a renderer can land
        # after this check; the fill asks again before it keeps anything.
        filler = (
            mount.cache_manager
            if caches_reads
            and not raw
            and op in DISPATCH_READ_OPS
            and size != 0
            and (whole or not mount.reads_ranges(path.virtual))
            and not renders_read()
            else None
        )

        if op == "rename" and isinstance(kwargs.get("dst"), PathSpec):
            # Ops.rename addresses both endpoints against the source's
            # mount; mirror that here so the backend sees a
            # mount-relative destination.
            dst = kwargs["dst"]
            kwargs["dst"] = PathSpec(
                virtual=dst.virtual,
                directory=dst.virtual.rsplit("/", 1)[0] or "/",
                vfs_path=mount_key(dst.virtual, mount.prefix.rstrip("/")),
            )
        # execute_op answers Any (each op has its own shape), and the
        # setattr fork narrows the first assignment to its dict, so the
        # local keeps the op contract's type explicitly.
        result: Any
        try:
            if op == "setattr":
                result = await self._apply_setattr(mount, path, kwargs)
            elif filler is not None:
                kept = await filler.fill(
                    path,
                    functools.partial(
                        mount.execute_op,
                        op,
                        path.virtual,
                        **_whole_read(kwargs),
                    ),
                    keep=lambda: not renders_read(),
                )
                result = kept if whole else slice_window(kept, offset, size)
            elif op in SERIAL_WRITE_OPS:
                # Held by the store's own object, so one store mounted
                # twice is one file, and a rename holds both of its
                # names, taken in one order so two renames between the
                # same pair cannot deadlock. What the write changes beside
                # the store (caches, the node table's links and attributes)
                # changes under the same hold: a chain of renames finishing
                # out of order would move one name's attributes onto
                # another.
                names = {path.virtual}
                if isinstance(kwargs.get("dst"), PathSpec):
                    names.add(kwargs["dst"].virtual)
                prefix = mount.prefix.rstrip("/")
                keys = {
                    f"{id(mount.vfs)}:{mount_key(name, prefix)}"
                    for name in names
                }
                async with AsyncExitStack() as held:
                    for key in sorted(keys):
                        await held.enter_async_context(
                            self._writers.with_lock(key)
                        )
                    result = await mount.execute_op(op, path.virtual, **kwargs)
                    _served(report, result)
                    await self._settle_write(mount, op, path, kwargs)
            else:
                result = await mount.execute_op(op, path.virtual, **kwargs)
        except (FileNotFoundError, NotADirectoryError):
            result = self._namespace_result(op, path.virtual)
            if result is None:
                await self._reconciler.on_op_missing(mount, op, path.virtual)
                raise
            _memory_answered(report)
        except OSError as exc:
            if op != "rmdir" or exc.errno not in (
                errno.ENOTEMPTY,
                errno.EEXIST,
            ):
                raise
            await self._rmdir_remnants(mount, path, exc)
            result = None
            if report is not None:
                report.served(None, None)
        else:
            # The op ran, whatever invalidation, the post gate, or an
            # output cap do next: stamped here so a failure in any of
            # them cannot erase a transfer the backend already made.
            _served(report, result)
        if op == "readdir":
            result = _visible_entries(
                merge_readdir(
                    vis,
                    result,
                    [
                        m.prefix
                        for m in self._namespace.registry.visible_mounts()
                    ],
                    self._namespace,
                    path.virtual,
                ),
                path.virtual,
            )
        if op == "stat" and isinstance(result, FileStat):
            result = merge_overlay_stat(
                self._namespace.meta_for(path.virtual), result
            )
        if op in DISPATCH_WRITE_OPS and op not in SERIAL_WRITE_OPS:
            await self._settle_write(mount, op, path, kwargs)
        result = await boundary.complete(op, path, write, result)
        return result, IOResult()

    async def _settle_write(
        self,
        mount: MountEntry,
        op: str,
        path: PathSpec,
        kwargs: dict[str, Any],
    ) -> None:
        """What a write changes beside the store: the caches above the
        path, and the node table's links and attributes at its names.

        Args:
            mount (MountEntry): the mount the write ran on.
            op (str): the write op that ran.
            path (PathSpec): the path it wrote, after any follow.
            kwargs (dict[str, Any]): the op's kwargs; a rename's ``dst``
                is the moved name.
        """
        opened = _appends_nothing(op, kwargs)
        observed = (
            time.time() if op in STAMP_WRITE_OPS and not opened else None
        )
        await self.invalidate_after_write(
            mount, path, observed=observed, times=not opened
        )
        if op in ("unlink", "rmdir"):
            # The name no longer holds that file, so what was set on
            # it (overlay mode and owner, extended attributes) goes
            # with it, as the shell's rm already drops it: a file
            # created there next starts bare on every surface.
            await self._namespace.drop_overlay(path.virtual)
            if op == "rmdir":
                # The link check ran before the backend was asked, so
                # a visible link below now was created since: it is
                # younger than this rmdir, lands after it in the
                # serial order (a link synthesizes its parents), and
                # the purge taking the directory's hidden nodes must
                # not take it too.
                vis = session_visibility()
                arrived = frozenset(
                    link
                    for link, _ in self._namespace.link_stats_below(
                        path.virtual
                    )
                    if path_visible(vis, link)
                )
                await self._namespace.purge_under(path.virtual, keep=arrived)
        if op == "rename" and isinstance(kwargs.get("dst"), PathSpec):
            await self.invalidate_after_rename(mount, path, kwargs["dst"])
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
            row = await mount.execute_op("stat", path.virtual)
        except (FileNotFoundError, NotADirectoryError):
            return False
        except OSError:
            return True
        return not isinstance(row, FileStat) or row.type is FileType.DIRECTORY

    async def _rmdir_remnants(
        self, mount: MountEntry, path: PathSpec, refusal: OSError
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
        """
        vis = session_visibility()
        if not hidden_under(vis, path.virtual):
            raise refusal
        try:
            entries = await mount.execute_op("readdir", path.virtual)
        except Exception as exc:
            # A backend that cannot list (or later, remove) the
            # remnants keeps the original refusal: the door has no way
            # to take them.
            raise refusal from exc
        # Emptiness is the door's own readdir pipeline: backend entries
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
            self._boundary(mount),
            functools.partial(self.invalidate_after_write, mount),
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
        links_below = [
            p for p in self._namespace.symlink_targets() if p.startswith(base)
        ]
        if any(path_visible(vis, p) for p in links_below):
            raise refusal
        await self._namespace.purge_under(path.virtual)

    async def _walk_stat(self, path: PathSpec) -> FileStat:
        """The door's own stat in the shape a chain walk reads.

        Raises when nothing is there, so a dot walk judges a name
        through every plane the door does: the node table, a mount root,
        another mount, a link it follows.

        Args:
            path (PathSpec): the path to stat.
        """
        row, _ = await self.dispatch("stat", path)
        if row is None:
            raise enoent(path)
        return row

    def _walked(self, path: PathSpec, create: bool) -> PathSpec:
        """``path`` with the links above its final name followed.

        The walked path answers to the session's hides as the typed one
        did, the rule the follow of the final name applies too: a visible
        link must not lead into hidden space.

        Args:
            path (PathSpec): the path as the caller named it.
            create (bool): whether the op creates at the path, which picks
                the voice a hidden landing answers in.

        Raises:
            DotWalkLoop: when a link above the name loops (ELOOP), as the
                OSError every caller's per-operand catch words.
        """
        spelled = walk_spelling(path, self._namespace.follow)
        try:
            walked = self._namespace.follow_parent(spelled)
        except CycleError:
            raise eloop(path) from None
        if spelled != path.virtual:
            walked = posixpath.normpath(walked)
        if walked == path.virtual:
            return path
        vis = session_visibility()
        if not path_visible(vis, walked):
            raise hidden_refusal(vis, walked, create)
        return PathSpec.from_str_path(walked)

    def _table_answers(
        self, op: str, virtual: str, kwargs: dict[str, Any]
    ) -> bool:
        """Whether the node table answers this op instead of a backend.

        ``symlink`` and ``readlink`` always, because a link exists
        nowhere else. The rest only when the path itself is a link, and
        then for the same reason the create and the read are the door's:
        forwarding reaches a backend that has never heard of the name.
        A no-follow stat is the read half of that fact (lstat asks for
        the link's own row, which only the table holds); a following
        stat never arrives here, since the follow above rewrote it to
        the target.

        Args:
            op (str): the dispatched op name.
            virtual (str): the op's virtual path.
            kwargs (dict[str, Any]): the op's arguments, read for the
                caller's ``nofollow``.
        """
        if op in NAMESPACE_TABLE_OPS:
            return True
        if op not in LINK_ENTRY_OPS:
            return False
        if op == "stat" and not kwargs.get("nofollow"):
            return False
        return self._namespace.is_link(virtual)

    async def _namespace_table_op(
        self,
        op: str,
        path: PathSpec,
        kwargs: dict[str, Any],
        report: OpReport | None,
    ) -> Any:
        """Answer a node-table op at the door itself, gated like a backend.

        A symlink is namespace state with no backend behind it, so the
        door owns every verb that names one. Admission still fires
        exactly as for a backend write: the link's turf is the longest
        mount prefix above it (the same ownership rule ``_link_allowed``
        reads for), session grants and both gates run, and the write
        leaves an OpRecord — a scoped kernel mount refuses exactly like
        a scoped shell. The turf's mode gates the write too
        (``MountModePolicy`` at the ``OpBoundary``), so a read-only
        mount or grant answers EROFS for a link exactly as for a file;
        a link above every mount is bare namespace structure, gated
        with an empty prefix and governed by ``/``. A rename's
        destination is judged on its own turf, since the endpoints need
        not share one.

        Args:
            op (str): ``symlink`` or ``readlink``, or the ``unlink``,
                ``rename`` or no-follow ``stat`` of a path the node
                table holds a link for.
            path (PathSpec): the link's own path, never followed.
            kwargs (dict[str, Any]): op arguments (``target`` for
                symlink, ``dst`` for rename).
            report (OpReport | None): the caller's report, stamped when
                the answer is in hand.
        """
        timer = start_op()
        mount = self._namespace.try_mount_for(path.virtual)
        boundary = self._boundary(mount)
        write = op in POLICY_WRITE_OPS
        await boundary.admit(
            op,
            path,
            write,
            create=op in HIDDEN_CREATE_OPS,
            final=op != "rename",
        )
        result: str | FileStat | None = None
        if op == "unlink":
            target = self._namespace.readlink(path.virtual) or ""
            await self._namespace.unlink(path.virtual)
        elif op == "rename":
            target = self._namespace.readlink(path.virtual) or ""
            dst = kwargs["dst"]
            # The destination is a create there, gated like the source
            # and on its own turf, the way the backend path gates both
            # ends of a rename. It is then replaced as rename(2)
            # replaces it: any node the table holds at that name (a
            # link, an attr overlay) goes.
            dst_mount = self._namespace.try_mount_for(dst.virtual)
            await self._boundary(dst_mount).admit(op, dst, True, create=True)
            # The name the link moves to must have a directory above it,
            # as for a new link: the table alone would file it under an
            # absent parent and synthesize the directories above it.
            refusal = await self._parent_refusal(dst)
            if refusal is not None:
                raise refusal
            if not self._namespace.is_link(dst.virtual):
                kind = await self._entry_type(dst.virtual)
                if kind == FileType.DIRECTORY:
                    raise IsADirectoryError(
                        errno.EISDIR, os.strerror(errno.EISDIR), dst.virtual
                    )
                if kind is not None:
                    await self.dispatch("unlink", dst)
            await self._namespace.unlink(dst.virtual)
            await self._namespace.rename(path.virtual, dst.virtual)
        elif op == "symlink":
            target = str(kwargs["target"])
            # symlink(2) refuses an occupied name and a name its parent
            # cannot hold, and the door is the only place that can tell:
            # the node table sees a link, and a probe sees what a backend
            # holds. Left unchecked, the new node shadowed live data (the
            # bytes stayed, the name read as a link), could bury a mount
            # root, which is the one name a deployment configured, and
            # under an absent parent was an orphan that invented the
            # directories above it.
            refusal = await self._symlink_refusal(path)
            if refusal is not None:
                raise refusal
            await self._namespace.symlink(path.virtual, target, time.time())
        elif op == "stat":
            row = self._namespace.link_stat_at(path.virtual)
            if row is None:
                raise FileNotFoundError(
                    errno.ENOENT, os.strerror(errno.ENOENT), path.virtual
                )
            target = self._namespace.readlink(path.virtual) or ""
            result = row
        else:
            found = self._namespace.readlink(path.virtual)
            if found is None:
                raise await self._readlink_miss(path)
            target = found
            result = found
        record(
            op,
            path.virtual,
            VFSName.RAM.value,
            len(encode_text(target)),
            timer,
        )
        _memory_answered(report)
        return await boundary.complete(op, path, write, result)

    async def _readlink_miss(self, path: PathSpec) -> OSError:
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
        """
        present, _ = await self._occupancy(path)
        if present:
            return OSError(
                errno.EINVAL, os.strerror(errno.EINVAL), path.virtual
            )
        return FileNotFoundError(
            errno.ENOENT, os.strerror(errno.ENOENT), path.virtual
        )

    async def _occupancy(
        self, path: PathSpec
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
        ``resolve_path_stat``: that dispatches, and the door is what
        dispatch is inside of.

        The parent's listing comes back beside the answer, None when no
        probe reached it or it gave none, because a listing with entries
        in it also proves the parent a directory: a create in a directory
        that holds anything costs no round trip beyond this one.

        Args:
            path (PathSpec): the path to probe.
        """
        if self._namespace.is_link(path.virtual):
            return True, None
        prefixes = [
            m.prefix for m in self._namespace.registry.visible_mounts()
        ]
        if (
            namespace_stat(
                session_visibility(), prefixes, self._namespace, path.virtual
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
            row = await self._probe_op("stat", mount, path)
            if row is not None and row.type is not FileType.DIRECTORY:
                return True, None
            listing = await self._parent_listing(path)
        except (PolicyError, PolicyDenied):
            # A channel that refuses to answer is not evidence of
            # absence. Reporting "present" keeps the answer at the EINVAL
            # every miss gave before the split, which asserts nothing the
            # policy is withholding; reporting absence would assert a
            # fact this door was not allowed to check.
            return True, None
        return listing is not None and _lists(listing, path.virtual), listing

    async def _symlink_refusal(self, path: PathSpec) -> OSError | None:
        """What symlink(2) answers instead of making a link at `path`.

        None when the link can be made. The name must be free (EEXIST)
        and its parent a directory (``_parent_refusal``), both read off
        the probes ``_occupancy`` makes: a parent whose listing answered
        with entries is a directory, so only an empty or silent parent is
        walked, which is the failure path nearly always.

        Args:
            path (PathSpec): the link's own path, the links above it
                already walked.
        """
        present, listing = await self._occupancy(path)
        if present:
            return FileExistsError(
                errno.EEXIST, os.strerror(errno.EEXIST), path.virtual
            )
        if listing:
            return None
        return await self._parent_refusal(path)

    async def _parent_refusal(self, path: PathSpec) -> OSError | None:
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
        """
        immediate = parent(norm(path.virtual))
        node = immediate
        try:
            kind = await self._entry_type(node)
            while kind is None:
                node = parent(node)
                kind = await self._entry_type(node)
        except NotADirectoryError:
            # A store that sees the file in the chain answers the probe
            # itself with ENOTDIR, which is the verdict.
            kind = FileType.FILE
        except (PolicyError, PolicyDenied):
            return None
        if kind is not FileType.DIRECTORY:
            return NotADirectoryError(
                errno.ENOTDIR, os.strerror(errno.ENOTDIR), path.virtual
            )
        if node != immediate:
            return FileNotFoundError(
                errno.ENOENT, os.strerror(errno.ENOENT), path.virtual
            )
        return None

    async def _entry_type(self, virtual: str) -> FileType | None:
        """The type of what stands at `virtual`, None when nothing does.

        The channels ``_occupancy`` asks, for a path the walk above a new
        name reaches: namespace structure and a mount root are
        directories, then the backend's row, then the path's own entry in
        its parent's listing, which is how a prefix store holds a
        directory that is nothing but a set of keys.

        Args:
            virtual (str): a normalized absolute virtual path.
        """
        if virtual == "/":
            return FileType.DIRECTORY
        prefixes = [
            m.prefix for m in self._namespace.registry.visible_mounts()
        ]
        if (
            namespace_stat(
                session_visibility(), prefixes, self._namespace, virtual
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
        row = await self._probe_op("stat", mount, spec)
        if row is not None:
            return row.type
        listing = await self._parent_listing(spec)
        if listing is not None and _lists(listing, virtual):
            return FileType.DIRECTORY
        return None

    async def _parent_listing(self, path: PathSpec) -> list[str] | None:
        """The backend listing of the directory `path` sits in.

        None when no mount serves that directory, its backend lists
        nothing there, or the path has no name to sit in one.

        Args:
            path (PathSpec): the path whose parent to list.
        """
        above, _, name = path.virtual.rstrip("/").rpartition("/")
        mount = self._namespace.try_mount_for(above or "/")
        if not name or mount is None:
            return None
        return await self._probe_op(
            "readdir", mount, PathSpec.from_str_path(above or "/")
        )

    async def _probe_op(
        self, op: str, mount: MountEntry, path: PathSpec
    ) -> Any:
        """Run one read op for a probe, or None when it found nothing.

        The probe reads on the caller's behalf but not at its request, so
        it passes the same admission gate the op would at the door: a
        policy that denies ``stat`` must not be reachable through a
        readlink. That refusal is raised, not swallowed, because only the
        caller knows what to answer when a channel goes dark.

        Args:
            op (str): ``stat`` or ``readdir``.
            mount (MountEntry): the mount owning the path.
            path (PathSpec): the path to probe.
        """
        if not mount.supports_op(op, path.virtual):
            return None
        boundary = self._boundary(mount)
        await boundary.admit(op, path, False)
        try:
            result = await mount.execute_op(op, path.virtual)
            return await boundary.complete(op, path, False, result)
        except NotADirectoryError:
            # Final on every channel: a plain file above the path means
            # nothing can be at it or under it, and symlink(2) and
            # readlink(2) answer with this errno.
            raise
        except MISS_ERRORS:
            # The "nothing here" set exactly: a miss on one channel is
            # not absence on its own, so the caller tries the other.
            return None

    async def _xattr_op(
        self,
        op: str,
        path: PathSpec,
        kwargs: dict[str, Any],
        report: OpReport | None,
    ) -> bytes | list[str] | None:
        """Answer an extended-attribute op from the node table.

        The attributes a caller sets live on the path's node, so they
        survive on a backend that has no such slot and move with a
        rename. The listing is sorted, so both hosts and every backend
        agree on its order.
        Gated like a setattr: both admission gates fire on the path's
        turf, and a write needs a writable turf.

        Args:
            op (str): ``getxattr``, ``listxattr``, ``setxattr`` or
                ``removexattr``.
            path (PathSpec): the path, already followed unless the
                caller asked for its link node itself.
            kwargs (dict[str, Any]): ``name`` for all but listxattr,
                ``value`` and the ``create``/``replace`` flags for
                setxattr.
            report (OpReport | None): the caller's report.
        """
        timer = start_op()
        mount = self._namespace.try_mount_for(path.virtual)
        boundary = self._boundary(mount)
        write = op in POLICY_WRITE_OPS
        await boundary.admit(op, path, write)
        await self._xattr_target(mount, path)
        stored = self._namespace.xattrs(path.virtual)
        name = str(kwargs.get("name", ""))
        result: bytes | list[str] | None = None
        if op == "listxattr":
            result = sorted(stored)
        elif op == "getxattr":
            found = stored.get(name)
            if found is None:
                raise no_xattr(path)
            result = found
        elif op == "setxattr":
            if kwargs.get("create") and name in stored:
                raise FileExistsError(
                    errno.EEXIST, os.strerror(errno.EEXIST), path.virtual
                )
            if kwargs.get("replace") and name not in stored:
                raise no_xattr(path)
            await self._namespace.set_xattr(
                path.virtual, name, bytes(kwargs.get("value") or b"")
            )
        else:
            if name not in stored:
                raise no_xattr(path)
            await self._namespace.remove_xattr(path.virtual, name)
        record(
            op,
            path.virtual,
            VFSName.RAM.value,
            len(result) if isinstance(result, bytes) else 0,
            timer,
        )
        if report is not None:
            report.served(None, None)
        return await boundary.complete(op, path, write, result)

    async def _statfs(self, path: PathSpec) -> tuple[str, CapacityResult]:
        """Answer statfs(2) for a path: the type name and the capacity of
        the mount that holds it, which is what df reports for that mount.

        The path must exist, as statfs's own walk requires. The namespace
        above every mount has no file system behind it, so its type is
        ``-`` and its capacity unknown.

        Args:
            path (PathSpec): the path, already followed.
        """
        mount = self._namespace.try_mount_for(path.virtual)
        boundary = self._boundary(mount)
        await boundary.admit("statfs", path, False)
        await self._xattr_target(mount, path)
        answer: tuple[str, CapacityResult]
        if mount is None:
            answer = "-", CapacityResult(state=CapacityState.UNKNOWN)
        else:
            async with mount.use():
                answer = mount.vfs.name, await mount.vfs.capacity()
        # A policy may deny the reply as it may any op's; a capacity is
        # no bytes, so a bound has nothing to cap.
        await boundary.complete("statfs", path, False, answer)
        return answer

    async def _xattr_target(
        self, mount: MountEntry | None, path: PathSpec
    ) -> None:
        """Settle that an attribute op's path exists, which it answers first.

        A link node's own attributes and a directory that exists only in
        the namespace have no backend behind them; anything else the
        backend's stat must find, or the op is ENOENT.

        Args:
            mount (MountEntry | None): the mount owning the path.
            path (PathSpec): the path the op names.
        """
        if self._namespace.is_link(path.virtual):
            return
        stat: FileStat | None = None
        missing: OSError | None = None
        if mount is not None:
            await mount.ensure_ready()
            try:
                stat = await mount.execute_op("stat", path.virtual)
            except (FileNotFoundError, NotADirectoryError) as exc:
                missing = exc
                await self._reconciler.on_op_missing(
                    mount, "stat", path.virtual
                )
        if stat is not None or isinstance(
            self._namespace_result("stat", path.virtual), FileStat
        ):
            return
        if mount is None:
            raise no_mount(path.virtual)
        if isinstance(missing, NotADirectoryError):
            raise missing
        raise enoent(path)

    async def _apply_setattr(
        self, mount: MountEntry, path: PathSpec, kwargs: dict[str, Any]
    ) -> dict[str, Any]:
        """Apply attributes natively where the backend can, overlay the rest.

        A mount with a native setattr op applies what it can and returns
        the residual; residual fields go to the overlay and natively
        applied ones are dropped from it, so a stale overlay never
        shadows a fresh backend value. A mount without the op, and a
        link path (which has no backend inode), overlay everything. The
        overlay half is the door's own write, so it runs inside the same
        gates as the native half.

        Args:
            mount (MountEntry): the mount owning the path.
            path (PathSpec): target path.
            kwargs (dict[str, Any]): the requested attribute fields.
        """
        requested = {key: kwargs.get(key) for key in SETATTR_KEYS}
        if self._namespace.is_link(path.virtual) or not mount.supports_op(
            "setattr", path.virtual
        ):
            # No backend inode answers for the path here, so nothing
            # would refuse a missing one: the overlay would stamp it.
            await self._xattr_target(mount, path)
            return await self._overlay_setattr(path, kwargs)
        residual = await mount.execute_op("setattr", path.virtual, **kwargs)
        applied = [
            key
            for key, value in requested.items()
            if value is not None and key not in residual
        ]
        if applied:
            await self._namespace.drop_attrs(path.virtual, applied)
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

    async def stat(self, path: str) -> FileStat:
        scope = PathSpec(
            virtual=path, directory=path, vfs_path="", resolved=True
        )
        result, _ = await self.dispatch("stat", scope)
        return result

    async def readdir(self, path: str) -> list[str]:
        scope = PathSpec(
            virtual=path, directory=path, vfs_path="", resolved=False
        )
        raw, _ = await self.dispatch("readdir", scope)
        return raw

    async def apply_io(
        self,
        io: IOResult,
        records: list[OpRecord] | None = None,
        cache_facts: Callable[[str], CacheFacts] | None = None,
    ) -> None:
        await cache_io.apply_io(
            self._cache,
            io,
            cache_facts or self.cache_facts_for,
            records=records,
        )

    def capture_cache_facts(self) -> Callable[[str], CacheFacts]:
        """Bind deferred command results to the mounts that produced them.

        The mount table is pinned at command start, so a fill that lands
        after the command is stamped with the bound of the mount that
        produced the bytes rather than whatever holds the prefix by then.
        """
        mounts = {
            m.prefix: m for m in self._namespace.registry.visible_mounts()
        }

        def facts(path: str) -> CacheFacts:
            prefix = owner_prefix(mounts, path)
            original = mounts.get(prefix) if prefix is not None else None
            mount = self._namespace.try_mount_for(path)
            if (
                mount is None
                or original is not mount
                or mount.retiring
                or not mount.vfs.caches_reads
            ):
                return CacheFacts(cacheable=False, ttl=DEFAULT_READ_TTL)
            return CacheFacts(cacheable=True, ttl=mount.read.ttl)

        return facts

    def cache_facts_for(self, path: str) -> CacheFacts:
        """The mount's cache facts for one path, resolved live.

        Args:
            path (str): absolute virtual path.
        """
        mount = self._namespace.try_mount_for(path)
        if mount is None or mount.retiring or not mount.vfs.caches_reads:
            return CacheFacts(cacheable=False, ttl=DEFAULT_READ_TTL)
        return CacheFacts(cacheable=True, ttl=mount.read.ttl)

    async def invalidate_all_after_remote(self) -> None:
        """Drop the file cache and every mount index wholesale.

        A whole-line runtime may have written anywhere in its view of
        the workspace, so per-path invalidation cannot apply: clear
        the read caches so the next local command refetches from the
        backends instead of serving pre-line state.

        Example: `cat /data/x` caches "old" locally; `python3 job.py`
        runs in the sandbox and writes "new" straight to S3 via its own
        FUSE mount, which the local dispatch never saw; without this
        reset the next `cat /data/x` would serve the stale "old".
        """
        await self._namespace.registry.invalidate_after_external()

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
    ) -> None:
        """Drop what a write to ``path`` made stale above the store.

        Args:
            mount (MountEntry): the mount the write ran on.
            path (PathSpec): the path it wrote.
            observed (float | None): epoch seconds of a content write to
                record, None for a removal.
            times (bool): drop the overlay times a content write moves;
                False for an open that wrote nothing.
        """
        if times:
            await self._namespace.clear_times(path.virtual, observed=observed)
        manager = self._manager_for(mount)
        await manager.invalidate_after_write(path)
        await manager.invalidate_ancestors(path)

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
        manager = self._manager_for(mount)
        await manager.invalidate_subtree(source)
        await manager.invalidate_subtree(dst)
        await manager.invalidate_ancestors(dst)
