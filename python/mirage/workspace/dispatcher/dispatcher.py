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
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from mirage.cache.file import io as cache_io
from mirage.cache.manager import CacheManager
from mirage.commands.builtin.utils.limit import apply_op_limit
from mirage.context import (get_current_session, hidden_paths_intersect,
                            path_allowed)
from mirage.io import IOResult, OpReport
from mirage.observe.context import record, start_op
from mirage.observe.record import OpRecord
from mirage.ops.config import NO_FOLLOW_OPS, STAMP_WRITE_OPS
from mirage.ops.namespace_view import (merge_readdir, namespace_listing,
                                       namespace_stat)
from mirage.policy import post_ops_gate, pre_ops_gate
from mirage.policy.errors import PolicyDenied, PolicyError
from mirage.types import (ConsistencyPolicy, FileStat, FileType, PathSpec,
                          ResourceName)
from mirage.utils.errors import MISS_ERRORS, no_mount
from mirage.utils.hidden import move_reveals
from mirage.utils.key_prefix import mount_key
from mirage.utils.path import norm_dir, owner_prefix
from mirage.utils.ranges import slice_window
from mirage.utils.remnants import remove_remnants, visible_below
from mirage.workspace.dispatcher.lineage import require_turf_writable
from mirage.workspace.mount import MountEntry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.mount.namespace.overlay import merge_overlay_stat
from mirage.workspace.reconcile import Reconciler
from mirage.workspace.snapshot.drift import DriftQueue

from mirage.workspace.dispatcher.constants import (  # isort: skip
    DISPATCH_READ_OPS, DISPATCH_WRITE_OPS, HIDDEN_CREATE_OPS, LINK_ENTRY_OPS,
    NAMESPACE_TABLE_OPS, POLICY_WRITE_OPS, SETATTR_KEYS)


def _memory_answered(report: OpReport | None,
                     moved: int | None = None) -> None:
    """Stamp the caller's report: memory answered, no backend ran.

    Fires at the moment a warm file-cache hit or a synthetic namespace
    answer is in hand, before the post gate and any output cap, so
    whatever those raise cannot erase the fact. The value is
    ``ResourceName.RAM``, which is how a record says "this never
    crossed the network": ``OpRecord.is_cache`` is defined as that
    string, and every network/cache total derives from it.

    Args:
        report (OpReport | None): the caller's report, None when the
            caller does not observe ops.
        moved (int | None): bytes memory served, None when the result
            is the measure.
    """
    if report is not None:
        report.served(ResourceName.RAM.value, moved)


def _hidden_refusal(op: str, virtual: str) -> OSError:
    """The error a hidden path answers: ENOENT, or EACCES for a create.

    Args:
        op (str): the dispatched op name.
        virtual (str): the hidden virtual path.
    """
    if op in HIDDEN_CREATE_OPS:
        return PermissionError(errno.EACCES, os.strerror(errno.EACCES),
                               virtual)
    return FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), virtual)


def _visible_entries(entries: list[str], parent: str) -> list[str]:
    """Drop listing entries the current session's spec hides.

    Entry shapes vary by backend (bare names, trailing-slash names,
    full paths), so each is keyed by its final segment against the
    listed directory, the same normalization ``merge_readdir`` dedups
    by.

    Args:
        entries (list[str]): the merged listing.
        parent (str): the directory that was listed, as a virtual path.
    """
    base = parent.rstrip("/")
    return [
        e for e in entries
        if path_allowed(f"{base}/{e.rstrip('/').rsplit('/', 1)[-1]}")
    ]


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
    return (offset if isinstance(offset, int) else 0,
            size if isinstance(size, int) else None)


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
        admit (Callable): the dispatcher's pre-ops gate, bound to that
            mount; raises to refuse a deletion.
        invalidate (Callable): the dispatcher's write invalidation,
            bound to that mount.
    """

    mount: MountEntry
    admit: Callable[[str, PathSpec], Awaitable[None]]
    invalidate: Callable[[PathSpec], Awaitable[None]]

    async def readdir(self, spec: PathSpec) -> list[str]:
        return await self.mount.execute_op("readdir", spec.virtual)

    async def stat(self, spec: PathSpec) -> FileStat:
        return await self.mount.execute_op("stat", spec.virtual)

    async def unlink(self, spec: PathSpec) -> None:
        await self.admit("unlink", spec)
        try:
            await self.mount.execute_op("unlink", spec.virtual)
        finally:
            await self.invalidate(spec)

    async def rmdir(self, spec: PathSpec) -> None:
        await self.admit("rmdir", spec)
        try:
            await self.mount.execute_op("rmdir", spec.virtual)
        finally:
            await self.invalidate(spec)


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
    reach here without passing Workspace.dispatch.
    """

    def __init__(self,
                 namespace: Namespace,
                 cache,
                 consistency: ConsistencyPolicy,
                 drift: DriftQueue | None = None) -> None:
        self._namespace = namespace
        self._cache = cache
        self._reconciler = Reconciler(cache, namespace, consistency)
        self._drift = drift

    @property
    def reconciler(self) -> Reconciler:
        return self._reconciler

    def _namespace_result(self, op: str,
                          virtual: str) -> list[str] | FileStat | None:
        """The namespace's own answer for a path no backend serves.

        Child mounts and symlinks are structure the door owns, so a
        directory that exists only because a mount or link sits below it
        still lists and stats. None for any other op, or when the
        namespace knows nothing at ``virtual``.

        Args:
            op (str): the dispatched op name.
            virtual (str): the virtual path being answered.
        """
        prefixes = [m.prefix for m in self._namespace.registry.mounts()]
        if op == "readdir":
            return namespace_listing(prefixes, self._namespace, virtual)
        if op == "stat":
            return namespace_stat(prefixes, self._namespace, virtual)
        return None

    async def _gated_namespace(self, op: str, path: PathSpec,
                               fallback: "list[str] | FileStat",
                               report: OpReport | None) -> Any:
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
        policies = self._namespace.registry.policies
        write = op in POLICY_WRITE_OPS
        # A pre gate refuses before the answer exists, so it is not a
        # completed op and stays before the stamp.
        await pre_ops_gate(policies, op, path, write, "", _session_id())
        _memory_answered(report)
        if op == "readdir" and isinstance(fallback, list):
            fallback = _visible_entries(fallback, path.virtual)
        bound = await post_ops_gate(policies, op, path, write, "", fallback)
        if bound is not None:
            return await apply_op_limit(fallback, bound)
        return fallback

    async def dispatch(self,
                       op: str,
                       path: PathSpec,
                       *,
                       report: OpReport | None = None,
                       **kwargs: Any) -> tuple[Any, IOResult]:
        await self._namespace.ensure_loaded()
        # Pending fingerprint checks from a strict snapshot restore run
        # before the op can touch a mount, whichever surface called:
        # FUSE and the ops facade come straight here, so a drain that
        # lived any higher would let a first write clobber drifted
        # state. drain() clears pending before it stats, so its own
        # probes cannot recurse into it.
        if self._drift is not None and self._drift.pending:
            await self._drift.drain(self._namespace.registry.try_mount_for)
        # Hidden paths answer before anything else can: the typed path
        # is checked so a link inside hidden space cannot be followed
        # out of it, the followed path is re-checked so a visible link
        # cannot lead in, and a rename destination is a create.
        if not path_allowed(path.virtual):
            raise _hidden_refusal(op, path.virtual)
        dst = kwargs.get("dst")
        if (op == "rename" and isinstance(dst, PathSpec)
                and not path_allowed(dst.virtual)):
            raise PermissionError(errno.EACCES, os.strerror(errno.EACCES),
                                  dst.virtual)
        if op == "rename" and isinstance(dst, PathSpec):
            # A rename re-anchors everything below its source while the
            # hides stay where they are written, so hidden content would
            # land at paths the session can see. Destroying hidden
            # content is silent (rm_r, the remnant rmdir below);
            # relocating it into view is refused. Only a directory has
            # anything below it to re-anchor, so a file source passes.
            sess = get_current_session()
            if (sess is not None
                    and move_reveals(sess.hidden_paths, sess.shown_paths,
                                     path.virtual, dst.virtual)
                    and await self._moved_source_is_dir(path)):
                raise PermissionError(errno.EACCES, os.strerror(errno.EACCES),
                                      path.virtual)
        if self._table_answers(op, path.virtual, kwargs):
            return (await self._namespace_table_op(op, path, kwargs,
                                                   report), IOResult())
        # `nofollow` is the caller's AT_SYMLINK_NOFOLLOW: an op that acts
        # on a link entry itself (chown -h writing the link's own attrs)
        # keeps the typed path. Consumed here, never forwarded.
        if op not in NO_FOLLOW_OPS and not kwargs.pop("nofollow", False):
            followed = self._namespace.follow(path.virtual)
            if followed != path.virtual:
                path = PathSpec.from_str_path(followed)
                if not path_allowed(path.virtual):
                    raise _hidden_refusal(op, path.virtual)
        mount = self._namespace.try_mount_for(path.virtual)
        if mount is None:
            # No mount serves the path, but the namespace may still know
            # a directory there (a deeper mount, a link). No mount means
            # no cache to keep straight. The merged names are
            # session-filtered individually. A setattr lands in the
            # overlay (a link above every mount still takes chown -h),
            # gated exactly like the mounted overlay write.
            if op == "setattr":
                policies = self._namespace.registry.policies
                await pre_ops_gate(policies, op, path, True, "", _session_id())
                require_turf_writable(None, path)
                applied = await self._overlay_setattr(path, kwargs)
                _memory_answered(report)
                await post_ops_gate(policies, op, path, True, "", applied)
                return applied, IOResult()
            fallback = self._namespace_result(op, path.virtual)
            if fallback is None:
                raise no_mount(path.virtual)
            return (await self._gated_namespace(op, path, fallback,
                                                report), IOResult())
        # Admission policies fire at the door, before the warm-cache
        # early return below: a cached read must be refused exactly
        # like a cold one, or the cache becomes a policy bypass.
        policies = self._namespace.registry.policies
        write = op in POLICY_WRITE_OPS
        await pre_ops_gate(policies, op, path, write, mount.prefix,
                           _session_id())
        # A rename's destination is a create there: it passes the same
        # gate as the source, so a path rule holds against moving into
        # a protected scope (or onto the directory that holds one) the
        # way it holds against writing there.
        if op == "rename" and isinstance(dst, PathSpec):
            await pre_ops_gate(policies, op, dst, True, mount.prefix,
                               _session_id())
        await mount.ensure_ready()
        caches_reads = mount.resource.caches_reads
        # The file cache is keyed on the path alone, and what a command
        # put there is the rendered read. A raw read asks for a
        # different value under the same key, so it must not be served
        # from that cache; nothing populates it from here, so skipping
        # the probe is the whole fix.
        raw = "filetype" in kwargs and kwargs["filetype"] is None

        if caches_reads and not raw and op in DISPATCH_READ_OPS:
            cached = await self._cache.get(path.virtual)
            if (cached is not None and await self._reconciler.may_serve_cached(
                    mount, path.virtual) and not mount.retiring
                    and self._namespace.try_mount_for(path.virtual) is mount):
                # The cache holds the whole object, so a ranged read is
                # answered by slicing it, never by handing back the
                # whole file: the window is what the caller asked for
                # instead of the file, and git reads pack indexes this
                # way. slice_window is the same helper the ranged read
                # op falls back to, so warm and cold agree.
                offset, size = _window(kwargs)
                served = slice_window(cached, offset, size)
                # Nothing crossed the network, and neither a gate nor a
                # hard cap leaves the caller able to tell: without the
                # stamp a refused warm read is recorded against the
                # backend and counted as traffic that never happened.
                _memory_answered(report, len(served))
                bound = await post_ops_gate(policies, op, path, write,
                                            mount.prefix, served)
                if bound is not None:
                    served = await apply_op_limit(served, bound)
                return served, IOResult(reads={path.virtual: served})

        if op == "rename" and isinstance(kwargs.get("dst"), PathSpec):
            # Ops.rename addresses both endpoints against the source's
            # mount; mirror that here so the backend sees a
            # mount-relative destination.
            dst = kwargs["dst"]
            kwargs["dst"] = PathSpec(
                virtual=dst.virtual,
                directory=dst.virtual.rsplit("/", 1)[0] or "/",
                resource_path=mount_key(dst.virtual, mount.prefix.rstrip("/")),
            )
        # execute_op answers Any (each op has its own shape), and the
        # setattr fork narrows the first assignment to its dict, so the
        # local keeps the op contract's type explicitly.
        result: Any
        try:
            if op == "setattr":
                result = await self._apply_setattr(mount, path, kwargs)
            else:
                result = await mount.execute_op(op, path.virtual, **kwargs)
        except FileNotFoundError:
            result = self._namespace_result(op, path.virtual)
            if result is None:
                await self._reconciler.on_op_missing(op, path.virtual)
                raise
            _memory_answered(report)
        except OSError as exc:
            if op != "rmdir" or exc.errno not in (errno.ENOTEMPTY,
                                                  errno.EEXIST):
                raise
            await self._rmdir_remnants(mount, path, exc)
            result = None
            if report is not None:
                report.served(None, None)
        else:
            # The op ran, whatever invalidation, the post gate, or an
            # output cap do next: stamped here so a failure in any of
            # them cannot erase a transfer the backend already made.
            if report is not None:
                report.served(
                    None,
                    len(result) if isinstance(result,
                                              (bytes, bytearray)) else None)
        if op == "readdir":
            result = _visible_entries(
                merge_readdir(
                    result,
                    [m.prefix for m in self._namespace.registry.mounts()],
                    self._namespace, path.virtual), path.virtual)
        if op == "stat" and isinstance(result, FileStat):
            result = merge_overlay_stat(self._namespace.meta_for(path.virtual),
                                        result)
        if op in DISPATCH_WRITE_OPS:
            observed = time.time() if op in STAMP_WRITE_OPS else None
            await self.invalidate_after_write(mount, path, observed=observed)
            if op == "rename" and isinstance(kwargs.get("dst"), PathSpec):
                await self.invalidate_after_write(mount, kwargs["dst"])
                # rename(2) replaces the destination, so a node the
                # table holds at that name does not survive the move.
                # A link left there shadowed the file that had just
                # landed: the listing showed the new file, every read
                # followed the old link, and the moved content was
                # reachable under no name at all.
                await self._namespace.unlink(kwargs["dst"].virtual)
        bound = await post_ops_gate(policies, op, path, write, mount.prefix,
                                    result)
        if bound is not None:
            # The transfer already happened, so the limit changes what
            # the caller receives, not what the backend moved; the
            # report above already carries the moved count.
            result = await apply_op_limit(result, bound)
        return result, IOResult()

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
        except FileNotFoundError:
            return False
        except OSError:
            return True
        return not isinstance(row, FileStat) or row.type is FileType.DIRECTORY

    async def _rmdir_remnants(self, mount: MountEntry, path: PathSpec,
                              refusal: OSError) -> None:
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
        if not hidden_paths_intersect(path.virtual):
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
            entries, [m.prefix for m in self._namespace.registry.mounts()],
            self._namespace, path.virtual)
        if not entries or visible_below(path.virtual, merged, path_allowed):
            raise refusal
        channel = _MountChannel(
            mount, functools.partial(self._admit_cascade, mount),
            functools.partial(self.invalidate_after_write, mount))
        try:
            await remove_remnants(channel, path_allowed, path)
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
        if any(path_allowed(p) for p in links_below):
            raise refusal
        await self._namespace.purge_under(path.virtual)

    async def _admit_cascade(self, mount: MountEntry, op: str,
                             path: PathSpec) -> None:
        """Hold one cascade deletion to the pre-ops admission a
        dispatched op answers.

        The gate that admitted the rmdir judged the directory; each
        deletion below it names its own path here, so a policy that
        denies ``unlink`` of a protected file refuses it even when the
        rmdir above was allowed.

        Args:
            mount (MountEntry): the mount owning the subtree.
            op (str): the deletion op ("unlink" or "rmdir").
            path (PathSpec): the child being removed.
        """
        await pre_ops_gate(self._namespace.registry.policies, op, path, True,
                           mount.prefix, _session_id())

    def _table_answers(self, op: str, virtual: str, kwargs: dict[str,
                                                                 Any]) -> bool:
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

    async def _namespace_table_op(self, op: str, path: PathSpec,
                                  kwargs: dict[str, Any],
                                  report: OpReport | None) -> Any:
        """Answer a node-table op at the door itself, gated like a backend.

        A symlink is namespace state with no backend behind it, so the
        door owns every verb that names one. Admission still fires
        exactly as for a backend write: the link's turf is the longest
        mount prefix above it (the same ownership rule ``_link_allowed``
        reads for), session grants and both gates run, and the write
        leaves an OpRecord — a scoped kernel mount refuses exactly like
        a scoped shell. The turf's mode gates the write too
        (``require_turf_writable``), so a read-only mount or grant
        answers EROFS for a link exactly as for a file; a link above
        every mount is bare namespace structure, gated with an empty
        prefix and governed by ``/`` (see ``lineage``). A rename's
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
        owner = mount.prefix if mount is not None else None
        policies = self._namespace.registry.policies
        write = op in POLICY_WRITE_OPS
        await pre_ops_gate(policies, op, path, write, owner or "",
                           _session_id())
        if write:
            require_turf_writable(mount, path)
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
            dst_owner = dst_mount.prefix if dst_mount is not None else ""
            await pre_ops_gate(policies, op, dst, True, dst_owner,
                               _session_id())
            require_turf_writable(dst_mount, dst)
            await self._namespace.unlink(dst.virtual)
            await self._namespace.rename(path.virtual, dst.virtual)
        elif op == "symlink":
            target = str(kwargs["target"])
            # symlink(2) refuses an occupied name, and the door is the
            # only place that can tell: the node table sees a link, and
            # a probe sees the file or directory a backend holds. Left
            # unchecked, the new node shadowed live data (the bytes
            # stayed, the name read as a link) and could bury a mount
            # root, which is the one name a deployment configured.
            if await self._path_present(path):
                raise FileExistsError(errno.EEXIST, os.strerror(errno.EEXIST),
                                      path.virtual)
            await self._namespace.symlink(path.virtual, target, time.time())
        elif op == "stat":
            row = self._namespace.link_stat_at(path.virtual)
            if row is None:
                raise FileNotFoundError(errno.ENOENT,
                                        os.strerror(errno.ENOENT),
                                        path.virtual)
            target = self._namespace.readlink(path.virtual) or ""
            result = row
        else:
            found = self._namespace.readlink(path.virtual)
            if found is None:
                raise await self._readlink_miss(path)
            target = found
            result = found
        record(op, path.virtual, ResourceName.RAM.value,
               len(target.encode("utf-8")), timer)
        _memory_answered(report)
        bound = await post_ops_gate(policies, op, path, write, owner or "",
                                    result)
        if bound is not None:
            return await apply_op_limit(result, bound)
        return result

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
        if await self._path_present(path):
            return OSError(errno.EINVAL, os.strerror(errno.EINVAL),
                           path.virtual)
        return FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT),
                                 path.virtual)

    async def _path_present(self, path: PathSpec) -> bool:
        """Whether anything at all is at `path`.

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

        Args:
            path (PathSpec): the path to probe.
        """
        if self._namespace.is_link(path.virtual):
            return True
        prefixes = [m.prefix for m in self._namespace.registry.mounts()]
        if namespace_stat(prefixes, self._namespace, path.virtual) is not None:
            return True
        mount = self._namespace.try_mount_for(path.virtual)
        if mount is None:
            return False
        if norm_dir(mount.prefix) == norm_dir(path.virtual):
            return True
        try:
            row = await self._probe_op("stat", mount, path)
            if row is not None and row.type is not FileType.DIRECTORY:
                return True
            return await self._listed_by_parent(path)
        except (PolicyError, PolicyDenied):
            # A channel that refuses to answer is not evidence of
            # absence. Reporting "present" keeps the answer at the EINVAL
            # every miss gave before the split, which asserts nothing the
            # policy is withholding; reporting absence would assert a
            # fact this door was not allowed to check.
            return True

    async def _listed_by_parent(self, path: PathSpec) -> bool:
        """Whether the path's own name is in its parent's listing.

        Compared on the final segment, because backends disagree on
        entry shape: bare names, a trailing slash to mark a directory,
        or full paths. The same normalization ``merge_readdir`` dedupes
        on.

        Args:
            path (PathSpec): the path to look for.
        """
        parent, _, name = path.virtual.rstrip("/").rpartition("/")
        mount = self._namespace.try_mount_for(parent or "/")
        if not name or mount is None:
            return False
        listing = await self._probe_op("readdir", mount,
                                       PathSpec.from_str_path(parent or "/"))
        return any(
            str(entry).rstrip("/").rsplit("/", 1)[-1] == name
            for entry in listing or ())

    async def _probe_op(self, op: str, mount: MountEntry,
                        path: PathSpec) -> Any:
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
        await pre_ops_gate(self._namespace.registry.policies, op, path, False,
                           mount.prefix, _session_id())
        try:
            return await mount.execute_op(op, path.virtual)
        except MISS_ERRORS:
            # The "nothing here" set exactly: a miss on one channel is
            # not absence on its own, so the caller tries the other.
            return None

    async def _apply_setattr(self, mount: MountEntry, path: PathSpec,
                             kwargs: dict[str, Any]) -> dict[str, Any]:
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
        if (self._namespace.is_link(path.virtual)
                or not mount.supports_op("setattr", path.virtual)):
            return await self._overlay_setattr(path, kwargs)
        residual = await mount.execute_op("setattr", path.virtual, **kwargs)
        applied = [
            key for key, value in requested.items()
            if value is not None and key not in residual
        ]
        if applied:
            await self._namespace.drop_attrs(path.virtual, applied)
        if residual:
            await self._write_overlay(path.virtual, residual)
        return dict(residual)

    async def _overlay_setattr(self, path: PathSpec,
                               kwargs: dict[str, Any]) -> dict[str, Any]:
        """Store every requested field in the namespace overlay.

        Args:
            path (PathSpec): target path.
            kwargs (dict[str, Any]): the requested attribute fields.
        """
        timer = start_op()
        overlay = {
            key: value
            for key in SETATTR_KEYS if (value := kwargs.get(key)) is not None
        }
        await self._write_overlay(path.virtual, overlay)
        record("setattr", path.virtual, ResourceName.RAM.value, 0, timer)
        return overlay

    async def _write_overlay(self, virtual: str, fields: dict[str,
                                                              Any]) -> None:
        """Write one overlay entry, converting an ISO mtime to epoch.

        Args:
            virtual (str): absolute virtual path.
            fields (dict[str, Any]): attribute fields to store.
        """
        mtime = fields.get("mtime")
        if isinstance(mtime, str):
            mtime = datetime.fromisoformat(mtime).timestamp()
        await self._namespace.set_attrs(virtual,
                                        mode=fields.get("mode"),
                                        uid=fields.get("uid"),
                                        gid=fields.get("gid"),
                                        atime=fields.get("atime"),
                                        mtime=mtime)

    async def stat(self, path: str) -> FileStat:
        scope = PathSpec(virtual=path,
                         directory=path,
                         resource_path="",
                         resolved=True)
        result, _ = await self.dispatch("stat", scope)
        return result

    async def readdir(self, path: str) -> list[str]:
        scope = PathSpec(virtual=path,
                         directory=path,
                         resource_path="",
                         resolved=False)
        raw, _ = await self.dispatch("readdir", scope)
        return raw

    async def apply_io(
            self,
            io: IOResult,
            records: list[OpRecord] | None = None,
            is_cacheable: Callable[[str], bool] | None = None) -> None:
        await cache_io.apply_io(self._cache,
                                io,
                                is_cacheable or self.is_cacheable_path,
                                records=records)

    def capture_cacheable_paths(self) -> Callable[[str], bool]:
        """Bind deferred command results to the mounts that produced them."""
        mounts = {m.prefix: m for m in self._namespace.registry.mounts()}

        def cacheable(path: str) -> bool:
            prefix = owner_prefix(mounts, path)
            original = mounts.get(prefix) if prefix is not None else None
            mount = self._namespace.try_mount_for(path)
            return (mount is not None and original is mount
                    and not mount.retiring and mount.resource.caches_reads)

        return cacheable

    def is_cacheable_path(self, path: str) -> bool:
        mount = self._namespace.try_mount_for(path)
        if mount is None:
            return False
        return not mount.retiring and mount.resource.caches_reads

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
        if self._cache is not None:
            await self._cache.clear()
        for mount in self._namespace.registry.mounts():
            if mount.cache_manager is not None:
                await mount.cache_manager.clear_index(mount.resource.index)
            else:
                async with mount.use():
                    await mount.resource.index.clear()

    async def invalidate_after_write(self,
                                     mount: MountEntry,
                                     path: PathSpec,
                                     observed: float | None = None) -> None:
        await self._namespace.clear_times(path.virtual, observed=observed)
        manager = mount.cache_manager
        if manager is None:
            manager = CacheManager(self._cache, mount.resource.index,
                                   mount.prefix, mount.resource.caches_reads)
        await manager.invalidate_after_write(path)
        await manager.invalidate_ancestors(path)
