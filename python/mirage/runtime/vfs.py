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
import logging
from collections.abc import Awaitable
from typing import Any

from mirage.context import (get_current_session, reset_current_session,
                            set_current_session)
from mirage.observe.context import (active_recorder, reset_active_recorder,
                                    set_active_recorder)
from mirage.runtime.errors import CrossMountError
from mirage.runtime.handles import plan_flush
from mirage.runtime.resolver import MountResolver
from mirage.runtime.types import DispatchFn, VFSEntry, VFSStat
from mirage.types import FileStat, PathSpec
from mirage.utils.errors import OperationNotSupportedError
from mirage.utils.path import norm
from mirage.utils.stat_view import (content_size, device_rdev, is_dir, is_link,
                                    mtime_ns, posix_mode)

logger = logging.getLogger(__name__)


class RuntimeVFS:
    """The mount-facing op vocabulary a sandboxed runtime encodes into.

    One instruction set (read/write/append/stat/readdir/create/truncate/
    unlink/mkdir/rmdir/rename/symlink/readlink/setattr), one routing
    table, one place that knows an append may have to become a
    whole-file write. The last three reach the name plane rather than a
    backend, which is what lets a guest create a link or chmod a file on
    a mount whose store has neither. Encoders hold one
    of these; they never inherit it, because a monty encoder must
    inherit the binding's own OSAccess and a wasm encoder is a table of
    preview1 host functions.

    The surface is sync on purpose: guest calls arrive on a worker
    thread (wasm) or the binding's own thread (monty), so every op hops
    to the workspace loop with `run_coroutine_threadsafe` and blocks
    that caller. The hop cannot carry the launching task's contextvars:
    what travels is the calling thread's context, and the threads guest
    calls arrive on (monty's tokio workers, wasmtime's run thread) never
    had the session bound. So the VFS captures the session and the op
    recorder on the launching task at construction — every runtime
    builds one per run, and monty builds one per eval — and re-binds
    both around each dispatched op, the same bracket FUSE's
    ``MountCore`` puts around its ops. Session mount modes are then
    enforced inside the op exactly as they are for a shell command, and
    a guest's file I/O lands on the typed line's ledger exactly as a
    shell command's does.

    Args:
        dispatch (DispatchFn): the workspace dispatch coroutine function.
        loop (asyncio.AbstractEventLoop): the loop dispatch belongs to.
        resolver (MountResolver | None): the workspace mount routing
            table; None means routing questions answer None.
    """

    def __init__(self,
                 dispatch: DispatchFn,
                 loop: asyncio.AbstractEventLoop,
                 resolver: MountResolver | None = None) -> None:
        self._dispatch = dispatch
        self._loop = loop
        self._resolver = resolver
        self._no_append: set[str] = set()
        self._session = get_current_session()
        self._recorder = active_recorder()

    def _raw(self, op: str, path: str, **kwargs: Any) -> Any:
        coro = self._dispatch(op, PathSpec.from_str_path(path), **kwargs)
        result, _ = asyncio.run_coroutine_threadsafe(self._bind_session(coro),
                                                     self._loop).result()
        return result

    async def _bind_session(self, coro: Awaitable[Any]) -> Any:
        """Run one dispatched op under the captured launch context.

        Set inside the coroutine so the tokens land on the event-loop
        task that executes the op, mirroring ``MountCore._bind_session``.
        Binds the session (mount modes) and the op recorder (the typed
        line's ledger) together: both were captured on the launching
        task and both are invisible to the thread the guest called from.

        Args:
            coro (Coroutine): the dispatch coroutine to run under the
                session and recorder.

        Returns:
            Any: whatever the wrapped coroutine returns.
        """
        token = set_current_session(self._session)
        rec_token = set_active_recorder(self._recorder)
        try:
            return await coro
        finally:
            reset_active_recorder(rec_token)
            reset_current_session(token)

    def call(self, op: str, path: str, **kwargs: Any) -> Any:
        """Run one workspace op and return its result.

        Args:
            op (str): dispatch op name (read, write, stat, ...).
            path (str): guest-absolute virtual path.
        """
        try:
            return self._raw(op, path, **kwargs)
        except OperationNotSupportedError as exc:
            # execute_op raises this for an op the mount's VFS does
            # not register; guests spell that ENOTSUP.
            raise NotImplementedError(str(exc)) from exc

    def prefixes(self) -> list[str]:
        """The workspace mount prefixes, longest first, slash-normalized.

        A mount at `/` is reported like any other. It is not the core's
        business that one prefix happens to claim every path: a runtime
        that cannot serve `/` says so itself (pyodide refuses it,
        because Emscripten already owns that mountpoint) and a runtime
        with a build tree of its own keeps `/` out of its own claim
        table (`WasmVFS._prefixes`). Deciding it here instead made
        `mount_of` answer None for a workspace whose only mount was the
        root one, so the routing table disagreed with the world.
        """
        if self._resolver is None:
            return []
        out = [norm(prefix) for prefix in self._resolver.prefixes()]
        return sorted(out, key=len, reverse=True)

    def mount_of(self, path: str) -> str | None:
        """The mount prefix serving `path`, longest match first, or None.

        The resolver answers in the mount table's own spelling; this
        surface re-spells to its no-trailing-slash convention, the form
        `prefixes` reports.

        Args:
            path (str): guest-absolute virtual path.
        """
        if self._resolver is None:
            return None
        owner = self._resolver.owner_of(path)
        return None if owner is None else norm(owner)

    def read(self, path: str) -> bytes:
        data = self.call("read", path)
        if isinstance(data, str):
            return data.encode()
        return bytes(data)

    def write(self, path: str, data: bytes) -> None:
        self.call("write", path, data=data)

    def stat(self, path: str, *, nofollow: bool = False) -> VFSStat:
        """One path's metadata, projected for a guest encoder.

        The projection lives here rather than in each surface so both
        languages build one struct in one tier: preview1 reads the type
        bits out of ``mode`` and drops the rest, monty fills a
        ``StatResult``, Emscripten fills an ``FSAttr``.

        Args:
            path (str): guest-absolute virtual path.
            nofollow (bool): report a trailing symlink itself rather
                than its target (a guest's lstat). The row is then the
                node table's own, so it carries the target string's
                length as the size, the link's mtime, and whatever a
                ``chown -h`` wrote; the dispatcher consumes the flag
                and gates that read exactly as it gates ``readlink``.
        """
        return self._row(self.call("stat", path, nofollow=nofollow))

    @staticmethod
    def _row(fs: FileStat) -> VFSStat:
        """Translate one mirage stat row into the guest-facing struct.

        Args:
            fs (FileStat): the row the door answered with.
        """
        ns = mtime_ns(fs)
        # A guest wire has no validity channel for a timestamp, so an
        # unknown mtime and epoch zero both encode as 0 from here on.
        return VFSStat(size=content_size(fs),
                       is_dir=is_dir(fs),
                       mode=posix_mode(fs),
                       mtime_ns=0 if ns is None else ns,
                       is_link=is_link(fs),
                       rdev=device_rdev(fs))

    def readdir(self, path: str, *, classify: bool = True) -> list[VFSEntry]:
        """List a directory as resolved entries (the TS door's shape).

        A backend that slash-marks directories skips the stat; every
        other entry is classified by its own stat, which is RAM when
        the readdir filled the index and a backend request when the
        mount keeps none. One entry at a time, since each op hops to
        the loop and blocks this thread.

        An entry whose stat fails, for any reason, rides unclassified:
        a size-0 non-directory with no mode and no mtime, the row that
        says "not known". One entry never fails the listing, the way a
        kernel readdir never stats at all. What went wrong is not lost:
        the guest's own stat or open of that entry asks the mount again
        and reports it. Only the listing itself failing fails the call.

        A row that did stat carries its mode and mtime too, since the
        struct is already in hand: a guest that seeds a whole tree from
        one listing (Emscripten does) then needs no second stat per
        file. The slash-marked and unclassified rows report None for
        both, which is the honest answer for a listing that never
        learned them.

        The link mark comes from the name plane, since stat follows and
        no backend listing reports a link. One table read per listing,
        and it only ever marks a name the listing itself returned, so a
        link the session hides stays hidden: the dispatcher filtered it
        out of the entries above and an unmatched mark marks nothing.

        Args:
            path (str): guest-absolute virtual path.
            classify (bool): stat each entry to learn its kind. A guest
                that only needs names (monty's listdir) passes False and
                every row comes back unclassified, one request for the
                listing and none per entry, as a POSIX readdir costs.
        """
        entries: list[VFSEntry] = []
        listing = self.call("readdir", path)
        # After the listing, not before: a directory that will not list
        # (ENOENT, or a link cycle the namespace refuses to resolve)
        # must fail as readdir, not as the mark read.
        links = self._link_names(path)
        for raw in listing:
            linked = raw.rstrip("/").rsplit("/", 1)[-1] in links
            if raw.endswith("/"):
                entries.append(
                    VFSEntry(path=raw, size=0, is_dir=True, is_link=linked))
                continue
            unclassified = VFSEntry(path=raw,
                                    size=0,
                                    is_dir=False,
                                    is_link=linked)
            if not classify:
                entries.append(unclassified)
                continue
            try:
                st = self.stat(raw)
            except Exception as exc:
                logger.debug("runtime vfs: readdir %s: stat %s: %s", path, raw,
                             exc)
                entries.append(unclassified)
                continue
            entries.append(
                VFSEntry(path=raw,
                         size=st.size,
                         is_dir=st.is_dir,
                         is_link=linked,
                         mode=st.mode,
                         mtime_ns=st.mtime_ns,
                         rdev=st.rdev))
        return entries

    def _link_names(self, directory: str) -> set[str]:
        """The link names the namespace owes `directory`, empty when none.

        Compared by final segment, because backends disagree on entry
        shape (bare names, trailing-slash names, full paths) and the
        name is the part they agree on. The same normalization
        ``merge_readdir`` dedupes on.

        Args:
            directory (str): guest-absolute virtual path being listed.
        """
        if self._resolver is None:
            return set()
        return self._resolver.link_children(directory)

    def create(self, path: str) -> None:
        self.call("create", path)

    def truncate(self, path: str, length: int = 0) -> None:
        self.call("truncate", path, length=length)

    def unlink(self, path: str) -> None:
        self.call("unlink", path)

    def mkdir(self, path: str) -> None:
        self.call("mkdir", path)

    def rmdir(self, path: str) -> None:
        self.call("rmdir", path)

    def rename(self, src: str, dst: str) -> None:
        """Rename within one mount.

        Args:
            src (str): guest-absolute source path.
            dst (str): guest-absolute destination path.

        Raises:
            CrossMountError: the two ends resolve to different mounts.
        """
        if self.mount_of(src) != self.mount_of(dst):
            raise CrossMountError(src, dst)
        self.call("rename", src, dst=PathSpec.from_str_path(dst))

    def symlink(self, path: str, target: str) -> None:
        """Create a namespace symlink at `path` pointing at `target`.

        A link is namespace state, so no backend stores one and the
        target is kept verbatim as the guest typed it. The dispatcher
        answers this op from the node table itself, which is why a
        runtime can serve `os.symlink` at all: the door a surface
        already holds reaches the name plane, not just a mount.

        Args:
            path (str): guest-absolute path of the link to create.
            target (str): link target, stored as typed.
        """
        self.call("symlink", path, target=target)

    def readlink(self, path: str) -> str:
        """The target of the symlink at `path`.

        Args:
            path (str): guest-absolute path of the link.

        Returns:
            str: the stored target.

        Raises:
            OSError: EINVAL when `path` is not a link, which is what the
                node table answers and what POSIX readlink says.
        """
        return str(self.call("readlink", path))

    def setattr(self,
                path: str,
                *,
                mode: int | None = None,
                uid: int | str | None = None,
                gid: int | str | None = None,
                atime: str | None = None,
                mtime: str | None = None,
                nofollow: bool = False) -> None:
        """Write metadata fields, natively where the backend can hold them.

        Every field is passed, unset ones as None, because the door
        reads the whole set and stores in the namespace overlay whatever
        the backend cannot keep. A mount with no setattr op therefore
        still answers: chmod on an s3 or dropbox mount lands in the name
        plane and stat reports it back. Stored, not enforced; mount mode
        is the access control.

        Args:
            path (str): guest-absolute virtual path.
            mode (int | None): permission bits (e.g. 0o644).
            uid (int | str | None): owner id or name.
            gid (int | str | None): group id or name.
            atime (str | None): ISO access time.
            mtime (str | None): ISO modification time.
            nofollow (bool): write the link entry's own attrs rather
                than its target's (a guest's AT_SYMLINK_NOFOLLOW).
        """
        self.call("setattr",
                  path,
                  mode=mode,
                  uid=uid,
                  gid=gid,
                  atime=atime,
                  mtime=mtime,
                  nofollow=nofollow)

    def append(self, path: str, data: bytes, whole: bytes) -> None:
        """Extend `path` by `data`, falling back to writing `whole`.

        `append` is optional per backend (S3 registers `write` and
        `rename` without it), so a mount that declines is remembered:
        the fallback then costs one failed dispatch per mount rather
        than one per call.

        Args:
            path (str): guest-absolute virtual path.
            data (bytes): only the newly appended bytes.
            whole (bytes): the file's full content, for the fallback.
        """
        if self._append_delta(path, data):
            return
        self.write(path, whole)

    def _append_delta(self, path: str, data: bytes) -> bool:
        mount = self.mount_of(path) or path
        if mount in self._no_append:
            return False
        try:
            self._raw("append", path, data=data)
        except OperationNotSupportedError:
            self._no_append.add(mount)
            return False
        return True

    def flush(self, path: str, base_len: int, low_write: int,
              buf: bytes | bytearray) -> None:
        """Send a closing handle's buffer as a delta when it can be one.

        Args:
            path (str): guest-absolute virtual path.
            base_len (int): length the file had when the handle opened.
            low_write (int): lowest offset this handle wrote at.
            buf (bytes | bytearray): the handle's whole buffer.
        """
        kind, payload = plan_flush(base_len, low_write, buf)
        if kind == "write":
            self.write(path, payload)
            return
        self.append(path, payload, bytes(buf))
