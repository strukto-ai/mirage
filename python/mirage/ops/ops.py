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
from typing import Any

from mirage.context import get_current_session, path_allowed
from mirage.io import OpReport
from mirage.observe import OpRecord
from mirage.observe.context import OpTimer, finish_record, start_op
from mirage.ops.config import NO_FOLLOW_OPS, NamespaceLinks, OpsMount
from mirage.ops.types import SessionBind
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.utils.errors import NoMountError
from mirage.utils.path import owner_prefix


class Ops:
    """The typed op facade FUSE and programmatic callers use.

    Every op delegates to the workspace dispatcher, so FUSE and
    ``ws.vfs`` walk the same pipeline as a shell command: link follow,
    session grants, admission policies, cache read-through, namespace
    structure, and write invalidation all fire once, at that one door.
    The facade keeps only what is its own: the typed surface, op
    recording (``records``/``network_bytes``), and the mount-table
    helpers.

    ``dispatch`` is required, so there is no workspace-less mode. A
    second pipeline here would be a second door, and it drifted from
    the real one exactly as expected: it served no cache, saw no
    namespace structure, and fired the gates only when a caller
    remembered to hand it policies. TypeScript's ``Ops`` takes
    the same stance.

    The facade runs as one session, ``session_id``, through ``bind``:
    every op is judged under that session's profile (hides, mount
    modes, grants) exactly as a shell line in it would be, so an agent
    whose file tool reads through ``ws.vfs`` is confined the way its
    shell is. None names the workspace's default session as it is when
    the op runs, since a snapshot load can rename it. A session already
    bound when the op arrives (a command's own runtime, a kernel mount
    serving one session) is kept, so the facade never widens the
    caller's view, and the record names the session that judged the
    op. ``Session`` derives a facade for another session over
    the same ledger.

    Every op also takes ``session_id`` for the one-call case, the way
    ``Workspace.shell`` does. One rule decides between them: a shell
    line *sets* the session, an op *inherits* it. So the argument is
    the session to run as when no line is already running, and the
    line's session wins when one is, which is what keeps a handler
    reaching this door from widening the view it was given.
    """

    def __init__(self,
                 mounts: list[OpsMount],
                 dispatch: DispatchFn,
                 observer: Any | None = None,
                 agent_id: str = "default",
                 session_id: str | None = None,
                 links: NamespaceLinks | None = None,
                 bind: SessionBind | None = None,
                 records: list[OpRecord] | None = None) -> None:
        self._mounts: list[OpsMount] = []
        self.set_mounts(mounts)
        self._observer = observer
        self._agent_id = agent_id
        self._session_id = session_id
        self._links = links
        self._dispatch = dispatch
        self._bind = bind
        self.records: list[OpRecord] = records if records is not None else []

    @property
    def session_id(self) -> str | None:
        """The session this facade runs as; None for the workspace's
        default session."""
        return self._session_id

    def _for_session(self, session_id: str) -> "Ops":
        """The same facade run as another session.

        The mechanism behind ``Session.vfs``, not a door of its
        own: a host binds a session with ``ws.session(id)`` (creating
        it when the id is new) or ``Session(ws, id)`` (adopting
        one that exists), so there is one way to say it rather than
        two. Shares the mount table and the op ledger with this one, so
        the workspace-wide account stays one list and a later mount is
        seen by both.

        Args:
            session_id (str): the session whose profile judges the ops.
        """
        derived = Ops([],
                      self._dispatch,
                      observer=self._observer,
                      agent_id=self._agent_id,
                      session_id=session_id,
                      links=self._links,
                      bind=self._bind,
                      records=self.records)
        derived._mounts = self._mounts
        return derived

    @property
    def links(self) -> NamespaceLinks | None:
        """The workspace symlink table, when this facade fronts one.

        FUSE reads it for symlink entries (getattr/readlink/readdir and
        link create/remove); None when the workspace has no link table.
        """
        return self._links

    def mount_prefixes(self) -> list[str]:
        """Return the mount prefixes in resolution order.

        Returns:
            list[str]: mount prefixes, longest first.
        """
        return [m.prefix for m in self._mounts]

    def set_mounts(self, mounts: list[OpsMount]) -> None:
        """Refresh mount metadata without replacing the facade or its ledger.

        Args:
            mounts (list[OpsMount]): the workspace's current mount table.
        """
        # In place, so a facade derived for a session sees the
        # refreshed table through the list it shares.
        self._mounts[:] = sorted(mounts,
                                 key=lambda m: len(m.prefix),
                                 reverse=True)

    def unsized_mounts(self, root_prefix: str = "") -> list[tuple[str, str]]:
        """Mounts whose files cannot be sized without reading them.

        Args:
            root_prefix (str): when non-empty, only consider the mount
                serving this prefix and anything nested under it, matching
                how a scoped mount narrows the tree.

        Returns:
            list[tuple[str, str]]: (prefix, resource_type) pairs, in mount
            resolution order.
        """
        root = root_prefix.rstrip("/")
        found = []
        for m in self._mounts:
            if root and not (m.prefix.rstrip("/") == root
                             or m.prefix.startswith(root + "/")):
                continue
            if not m.sizes_always_known:
                found.append((m.prefix, m.resource_type))
        return found

    def writable_mounts(self, root_prefix: str = "") -> list[tuple[str, str]]:
        """Mounts that accept writes, in mount resolution order.

        Args:
            root_prefix (str): when non-empty, only consider the mount
                serving this prefix and anything nested under it, matching
                how a scoped mount narrows the tree.

        Returns:
            list[tuple[str, str]]: (prefix, resource_type) pairs.
        """
        root = root_prefix.rstrip("/")
        found = []
        for m in self._mounts:
            if root and not (m.prefix.rstrip("/") == root
                             or m.prefix.startswith(root + "/")):
                continue
            if m.mode is not MountMode.READ:
                found.append((m.prefix, m.resource_type))
        return found

    def unmount(self, prefix: str) -> None:
        stripped = prefix.strip("/")
        norm = ("/" + stripped + "/" if stripped else "/")
        # In place, for the same reason ``set_mounts`` is: a facade
        # derived for a session shares this list, and a retained one
        # must stop reporting a mount the workspace dropped.
        self._mounts[:] = [m for m in self._mounts if m.prefix != norm]

    def _record(self, op: str, path: str, source: str, nbytes: int,
                timer: OpTimer, session: str) -> None:
        rec = finish_record(
            op,
            path,
            source.value if hasattr(source, 'value') else str(source),
            nbytes,
            timer,
        )
        self.records.append(rec)
        if self._observer is not None:
            asyncio.ensure_future(
                self._observer.log_op(rec, self._agent_id, session))

    def _owner(self, path: str) -> OpsMount | None:
        """The mount owning ``path`` by longest prefix, or None."""
        owner = owner_prefix((m.prefix for m in self._mounts), path)
        if owner is None:
            return None
        return next(m for m in self._mounts if m.prefix == owner)

    def _mount_prefix(self, path: str) -> str:
        m = self._owner(path)
        return "" if m is None else m.prefix.rstrip("/")

    @staticmethod
    def _payload_bytes(result: Any, kwargs: dict[str, Any]) -> int:
        """The op's byte count for recording: result first, else input.

        Args:
            result (Any): what the op returned.
            kwargs (dict): the op's keyword arguments (write payloads
                travel as ``data``).
        """
        if isinstance(result, (bytes, bytearray)):
            return len(result)
        return next(
            (len(v)
             for v in kwargs.values() if isinstance(v, (bytes, bytearray))), 0)

    async def _call(self,
                    op: str,
                    path: str,
                    session_id: str | None = None,
                    **kwargs) -> Any:
        """Run one op through the workspace dispatcher and record it.

        The door owns the whole pipeline (follow, grants, gates, cache,
        structure, invalidation); the facade's own share is the record.
        The path is link-followed here first so the record carries the
        resolved path; the door's second follow of an already-resolved
        path is a no-op. That follow runs inside the session binding
        and only from a path the session can see: a link the session
        cannot see stays the typed path, so the door refuses it as
        absent instead of serving the visible target it points at.
        ``nofollow`` is the caller's AT_SYMLINK_NOFOLLOW and suppresses
        both follows, so an op meant for a link entry itself
        (``chmod -h``, a guest's ``lchown``) still records the link's
        own path.

        Whether the op is a write is the door's call too: it reads that
        off the op name, so there is nothing for a caller here to
        declare.

        Args:
            op (str): the op name.
            path (str): the virtual path.
            session_id (str | None): the session to run as when no line
                is already running; None uses this facade's own.
            **kwargs: op arguments, by the op function's names.
        """
        timer = start_op()
        follow = (self._links is not None and op not in NO_FOLLOW_OPS
                  and not kwargs.get("nofollow"))
        report = OpReport()
        seen: list[str] = []
        resolved = [path]

        async def run() -> tuple[Any, Any]:
            sess = get_current_session()
            if sess is not None:
                seen.append(sess.session_id)
            if follow and self._links is not None and path_allowed(path):
                resolved[0] = self._links.follow(path)
            return await self._dispatch(op,
                                        PathSpec.from_str_path(resolved[0]),
                                        report=report,
                                        **kwargs)

        try:
            bound = (self._session_id if session_id is None else session_id)
            result, _ = await (run() if self._bind is None else self._bind(
                bound, run))
        except BaseException:
            # Anything raised after the op ran (a post_ops deny, a hard
            # output cap, a bookkeeping failure) suppresses the result,
            # not the effect, so observation must reflect the op before
            # the error propagates. The door stamps the report at the
            # moment of completion, so even a foreign error the door
            # never defined leaves the transfer on the books.
            owner = self._owner(resolved[0])
            if report.completed and owner is not None:
                self._record_op(op, resolved[0], owner, report.source,
                                report.bytes, None, kwargs, timer,
                                self._session_for(seen))
            raise
        owner = self._owner(resolved[0])
        if owner is not None:
            self._record_op(op, resolved[0], owner, report.source,
                            report.bytes, result, kwargs, timer,
                            self._session_for(seen))
        return result

    def _session_for(self, seen: list[str]) -> str:
        """The session id a record carries: the one the op ran as, else
        this facade's own, else the unbound door's empty id.

        Args:
            seen (list[str]): what ``_run_as_seen`` noted.
        """
        if seen:
            return seen[0]
        return self._session_id if self._session_id is not None else ""

    def _record_op(self, op: str, path: str, owner: OpsMount,
                   source: str | None, moved: int | None, result: Any,
                   kwargs: dict[str,
                                Any], timer: OpTimer, session: str) -> None:
        """Record one op from the door's report of who served it.

        The door names the server when it was not the owning mount (a
        warm cache hit, a synthetic namespace answer): neither moved
        bytes over the network, and "ram" is what ``OpRecord.is_cache``
        reads. It names the moved bytes when the delivered result no
        longer measures them, because a cap truncated it or a refusal
        withheld it entirely.

        Args:
            op (str): the op name.
            path (str): the resolved virtual path.
            owner (OpsMount): the mount owning the path.
            source (str | None): the door's server, None for the mount.
            moved (int | None): bytes the backend moved, None to
                measure the result.
            result (Any): what the op returned, None when withheld.
            kwargs (dict[str, Any]): the op's arguments.
            timer (OpTimer): the stopwatch opened when the op started.
            session (str): the session the op ran as.
        """
        nbytes = (moved if moved is not None else self._payload_bytes(
            result, kwargs))
        self._record(op, path, source or owner.resource_type, nbytes, timer,
                     session)

    async def read(self,
                   path: str,
                   offset: int = 0,
                   size: int | None = None,
                   raw: bool = False,
                   *,
                   session_id: str | None = None) -> bytes:
        """Read file content.

        ``raw`` asks for the stored bytes, skipping a filetype-scoped
        read op the mount registers for this extension and the file
        cache a command's rendered read may have filled. Read-modify-
        write is what needs it: the merged buffer goes back through
        ``write``, which stores, so reading the rendering would store
        the rendering over the file. TypeScript spells the same thing
        ``readFile(path, {raw: true})``.

        Args:
            path (str): Virtual path.
            offset (int): Byte offset for range reads.
            size (int | None): Number of bytes for range reads.
            raw (bool): Read stored bytes rather than a rendered form.
            session_id (str | None): Session to run as outside a line.

        Returns:
            bytes: File content.
        """
        kwargs: dict[str, Any] = {"filetype": None} if raw else {}
        if offset or size is not None:
            return await self._call("read",
                                    path,
                                    session_id,
                                    offset=offset,
                                    size=size,
                                    **kwargs)
        return await self._call("read", path, session_id, **kwargs)

    async def write(self,
                    path: str,
                    data: bytes,
                    *,
                    session_id: str | None = None) -> None:
        """Write file content.

        Args:
            path (str): Virtual path.
            data (bytes): Content to write.
            session_id (str | None): Session to run as outside a line.
        """
        await self._call("write", path, session_id, data=data)

    async def append(self,
                     path: str,
                     data: bytes,
                     *,
                     session_id: str | None = None) -> None:
        """Append data to a file.

        Args:
            path (str): Virtual path.
            data (bytes): Content to append.
            session_id (str | None): Session to run as outside a line.
        """
        await self._call("append", path, session_id, data=data)

    async def stat(self,
                   path: str,
                   *,
                   session_id: str | None = None) -> FileStat:
        return await self._call("stat", path, session_id)

    async def readdir(self,
                      path: str,
                      *,
                      session_id: str | None = None) -> list[str]:
        return await self._call("readdir", path, session_id)

    # The three probes below answer "is this path there?", so only a
    # genuine missing path may read back as False: the typed registry
    # miss (NoMountError) and the backend's own absence. An auth
    # failure, a timeout, or a backend bug is not an answer to that
    # question; swallowing it would let a caller act on a false
    # "missing" (overwrite, recreate, skip). Mirrors the TS facade.
    async def exists(self,
                     path: str,
                     *,
                     session_id: str | None = None) -> bool:
        """True when a stat answers for the path.

        Args:
            path (str): Virtual path.
            session_id (str | None): Session to run as outside a line.
        """
        try:
            await self.stat(path, session_id=session_id)
        except (FileNotFoundError, NoMountError):
            return False
        return True

    async def is_dir(self,
                     path: str,
                     *,
                     session_id: str | None = None) -> bool:
        """True when the path stats as a directory.

        Args:
            path (str): Virtual path.
            session_id (str | None): Session to run as outside a line.
        """
        try:
            st = await self.stat(path, session_id=session_id)
        except (FileNotFoundError, NoMountError):
            return False
        return st.type == FileType.DIRECTORY

    async def is_file(self,
                      path: str,
                      *,
                      session_id: str | None = None) -> bool:
        """True when the path stats as anything but a directory.

        Args:
            path (str): Virtual path.
            session_id (str | None): Session to run as outside a line.
        """
        try:
            st = await self.stat(path, session_id=session_id)
        except (FileNotFoundError, NoMountError):
            return False
        return st.type != FileType.DIRECTORY

    async def cat(self, path: str, *, session_id: str | None = None) -> str:
        """The file's content as text (the TS facade's ``cat``).

        Args:
            path (str): Virtual path.
            session_id (str | None): Session to run as outside a line.
        """
        data = await self.read(path, session_id=session_id)
        return data.decode("utf-8", errors="replace")

    async def list_files(self,
                         path: str,
                         *,
                         session_id: str | None = None) -> list[str]:
        """Basenames of the directory's files, directories dropped.

        Args:
            path (str): Virtual path.
            session_id (str | None): Session to run as outside a line.
        """
        files = []
        for entry in await self.readdir(path, session_id=session_id):
            if await self.is_file(entry, session_id=session_id):
                files.append(entry.rstrip("/").rsplit("/", 1)[-1])
        return files

    async def mkdir(self, path: str, *, session_id: str | None = None) -> None:
        await self._call("mkdir", path, session_id)

    async def unlink(self,
                     path: str,
                     *,
                     session_id: str | None = None) -> None:
        """Delete file.

        Args:
            path (str): Virtual path.
            session_id (str | None): Session to run as outside a line.
        """
        await self._call("unlink", path, session_id)

    async def rmdir(self, path: str, *, session_id: str | None = None) -> None:
        await self._call("rmdir", path, session_id)

    async def rename(self,
                     src: str,
                     dst: str,
                     *,
                     session_id: str | None = None) -> None:
        """Rename file or directory within one mount.

        Both ends must resolve to the same mount: a mount is a
        filesystem boundary, and the facade is where a kernel-facing
        whole-workspace FUSE mount needs the refusal, so `mv` between
        two backends falls back to its copy+unlink path instead of
        corrupting one backend's key space with the other's path.

        Args:
            src (str): Source virtual path.
            dst (str): Destination virtual path.
            session_id (str | None): Session to run as outside a line.

        Raises:
            OSError: EXDEV when the two ends resolve to different
                mounts.
        """
        if self._mount_prefix(src) != self._mount_prefix(dst):
            raise OSError(errno.EXDEV, "Invalid cross-device link", src, None,
                          dst)
        await self._call("rename",
                         src,
                         session_id,
                         dst=PathSpec.from_str_path(dst))

    async def create(self,
                     path: str,
                     *,
                     session_id: str | None = None) -> None:
        await self._call("create", path, session_id)

    async def symlink(self,
                      path: str,
                      target: str,
                      *,
                      session_id: str | None = None) -> None:
        """Create a namespace symlink at ``path``.

        Routed through the door like every write: session grants and
        admission policies fire on the link's turf, and the write lands
        on the ledger. The target is stored verbatim as typed.

        Args:
            path (str): Virtual path of the link.
            target (str): What the link points to, as typed.
            session_id (str | None): Session to run as outside a line.

        Raises:
            FileExistsError: something is already at ``path`` (a file, a
                directory, another link, a mount root). symlink(2) never
                overwrites, and the door is the layer that can see both
                planes to tell.
        """
        await self._call("symlink", path, session_id, target=target)

    async def readlink(self,
                       path: str,
                       *,
                       session_id: str | None = None) -> str:
        """The stored target of the link at ``path``.

        Args:
            path (str): Virtual path of the link.
            session_id (str | None): Session to run as outside a line.

        Raises:
            OSError: EINVAL when the path is not a link.
        """
        return await self._call("readlink", path, session_id)

    async def setattr(self,
                      path: str,
                      *,
                      mode: int | None = None,
                      uid: int | str | None = None,
                      gid: int | str | None = None,
                      atime: str | None = None,
                      mtime: str | None = None,
                      nofollow: bool = False,
                      session_id: str | None = None) -> dict[str, int | str]:
        """Write metadata fields, natively where the backend can hold them.

        Every field is passed, unset ones as None, because the door
        reads the whole set and stores in the namespace overlay whatever
        the backend cannot keep. A mount with no setattr op therefore
        still answers: a chmod on an s3 or dropbox mount lands in the
        name plane and stat reports it back. Stored, not enforced; the
        mount mode is the access control.

        Args:
            path (str): Virtual path.
            mode (int | None): permission bits (e.g. 0o644).
            uid (int | str | None): owner id or name.
            gid (int | str | None): group id or name.
            atime (str | None): ISO access time.
            mtime (str | None): ISO modification time.
            nofollow (bool): write the link entry's own attrs rather
                than its target's (the ``-h`` family).
            session_id (str | None): Session to run as outside a line.

        Returns:
            dict[str, int | str]: the fields the backend could not keep,
                which the door stored in the overlay instead.
        """
        return await self._call("setattr",
                                path,
                                session_id,
                                mode=mode,
                                uid=uid,
                                gid=gid,
                                atime=atime,
                                mtime=mtime,
                                nofollow=nofollow)

    async def getxattr(self,
                       path: str,
                       name: str,
                       *,
                       nofollow: bool = False,
                       session_id: str | None = None) -> bytes:
        """One extended attribute's value.

        The node table answers with what a caller set.

        Args:
            path (str): Virtual path.
            name (str): Attribute name.
            nofollow (bool): read a link entry's own attributes rather
                than its target's.
            session_id (str | None): Session to run as outside a line.

        Raises:
            OSError: the attribute-not-set errno (ENODATA on Linux,
                ENOATTR on macOS) when the path has no such attribute.
        """
        return await self._call("getxattr",
                                path,
                                session_id,
                                name=name,
                                nofollow=nofollow)

    async def listxattr(self,
                        path: str,
                        *,
                        nofollow: bool = False,
                        session_id: str | None = None) -> list[str]:
        """Every extended attribute name a path carries, sorted.

        Args:
            path (str): Virtual path.
            nofollow (bool): list a link entry's own attributes.
            session_id (str | None): Session to run as outside a line.
        """
        return await self._call("listxattr",
                                path,
                                session_id,
                                nofollow=nofollow)

    async def setxattr(self,
                       path: str,
                       name: str,
                       value: bytes,
                       *,
                       create: bool = False,
                       replace: bool = False,
                       nofollow: bool = False,
                       session_id: str | None = None) -> None:
        """Store an extended attribute on a path.

        Stored on the path's namespace node, so it works on every
        backend and moves with a rename.

        Args:
            path (str): Virtual path.
            name (str): Attribute name.
            value (bytes): Attribute value.
            create (bool): fail with EEXIST when the attribute is set
                (XATTR_CREATE).
            replace (bool): fail with the attribute-not-set errno when
                it is not (XATTR_REPLACE).
            nofollow (bool): write a link entry's own attributes.
            session_id (str | None): Session to run as outside a line.
        """
        await self._call("setxattr",
                         path,
                         session_id,
                         name=name,
                         value=value,
                         create=create,
                         replace=replace,
                         nofollow=nofollow)

    async def removexattr(self,
                          path: str,
                          name: str,
                          *,
                          nofollow: bool = False,
                          session_id: str | None = None) -> None:
        """Drop an extended attribute from a path.

        Args:
            path (str): Virtual path.
            name (str): Attribute name.
            nofollow (bool): drop from a link entry itself.
            session_id (str | None): Session to run as outside a line.

        Raises:
            OSError: the attribute-not-set errno when it is not set.
        """
        await self._call("removexattr",
                         path,
                         session_id,
                         name=name,
                         nofollow=nofollow)

    async def truncate(self,
                       path: str,
                       length: int,
                       *,
                       session_id: str | None = None) -> None:
        """Truncate file to given length.

        Args:
            path (str): Virtual path.
            length (int): Target length in bytes.
            session_id (str | None): Session to run as outside a line.
        """
        await self._call("truncate", path, session_id, length=length)

    @property
    def network_records(self) -> list[OpRecord]:
        """Records that hit a remote VFS (not cache)."""
        return [r for r in self.records if not r.is_cache]

    @property
    def network_bytes(self) -> int:
        """Total bytes transferred over the network."""
        return sum(r.bytes for r in self.records if not r.is_cache)

    @property
    def cache_records(self) -> list[OpRecord]:
        """Records served from in-memory cache."""
        return [r for r in self.records if r.is_cache]

    @property
    def cache_bytes(self) -> int:
        """Total bytes served from cache."""
        return sum(r.bytes for r in self.records if r.is_cache)

    def is_mounted(self, path: str) -> bool:
        """Check if a path is under an explicit mount.

        Used by the open()/os interception to decide whether a path is a
        workspace path (route through ops) or a real OS path (pass through).
        The catch-all virtual root at ``/`` is skipped on purpose: it matches
        every absolute path, so counting it would hijack real filesystem
        paths (a FUSE mountpoint, ``/tmp``) into ops. Routing to the root for
        ops themselves still happens at the door; this gate is only about
        what the interception should leave alone.

        Args:
            path (str): Virtual path.

        Returns:
            bool: True if path is under a mount other than the virtual root.
        """
        return owner_prefix(
            (m.prefix for m in self._mounts if m.prefix != "/"),
            path) is not None
