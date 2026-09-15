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
import os

from mirage.nfs.errors import StaleHandleError

ROOT_PATH = "/"


def _descendant_prefix(path: str) -> str:
    return path.rstrip("/") + "/"


COOKIE_TOMBSTONES = 4096


class IdTable:
    """The fileid ↔ path map an NFS server addresses files through.

    NFSv3 names a file by handle, never by path, and the server crate
    builds the opaque handle from a fileid plus its own generation. The
    adapter therefore owns exactly one thing: which id stands for which
    path, and what happens to that mapping when a path moves.

    Ids are allocated monotonically and never reused. A reused id would
    let a client holding a handle to a deleted file silently address a
    different one, because the crate's generation counter distinguishes
    server lifetimes rather than individual files.

    Entries are never evicted. NFSv3 clients cache handles for as long
    as they like, so dropping a live one manufactures a stale-handle
    error the client cannot recover from; an entry costs about a hundred
    bytes, which makes a hundred thousand files a few megabytes.

    No lock guards the maps, and none is needed: every method here is
    synchronous and contains no ``await``, so the event loop runs each
    one to completion before another callback proceeds. The server's
    runtime may call from several of its own threads, but every call is
    scheduled onto the workspace loop rather than executed in place.
    ``tests/nfs/test_state_is_await_free.py`` pins that invariant, since
    a single ``await`` added inside one of these methods would break it
    and a lock would not save it.
    """

    def __init__(self) -> None:
        self._next_id = 1
        self._by_id: dict[int, str] = {}
        self._by_path: dict[str, int] = {}
        # Ids whose entry is gone, kept for cookie ordering only. A
        # READDIR resuming after an entry that has since been removed
        # still has to know where in the sorted listing it sat; without
        # that the resume matches nothing and the rest of the directory
        # reads to the client as end-of-listing. Bounded, because a
        # long-lived mount removes files forever.
        self._removed: dict[int, str] = {}

    def alloc(self, path: str) -> int:
        """The id for a path, minting one when the path is new.

        Args:
            path (str): mount-relative path.

        Returns:
            int: the path's fileid, stable until the path is renamed or
            invalidated.
        """
        existing = self._by_path.get(path)
        if existing is not None:
            return existing
        fileid = self._next_id
        self._next_id += 1
        self._by_id[fileid] = path
        self._by_path[path] = fileid
        return fileid

    def resolve(self, fileid: int) -> str:
        """The path an id names.

        Args:
            fileid (int): the id from a client's file handle.

        Returns:
            str: the mount-relative path.

        Raises:
            StaleHandleError: the id is unknown or has been invalidated.
        """
        path = self._by_id.get(fileid)
        if path is None:
            raise StaleHandleError(f"unknown file id: {fileid}")
        return path

    def id_for(self, path: str) -> int | None:
        """The id already held for a path, without minting one.

        Args:
            path (str): mount-relative path.

        Returns:
            int | None: the id, or None when the path is untracked.
        """
        return self._by_path.get(path)

    def invalidate(self, fileid: int) -> None:
        """Forget an id after the path behind it is gone. Idempotent.

        Args:
            fileid (int): the id to drop.
        """
        path = self._by_id.pop(fileid, None)
        if path is None:
            return
        self._by_path.pop(path, None)
        self._removed[fileid] = path
        excess = len(self._removed) - COOKIE_TOMBSTONES
        if excess > 0:
            # Ids are minted in order, so the smallest are the oldest.
            for stale in sorted(self._removed)[:excess]:
                del self._removed[stale]

    def cookie_path(self, fileid: int) -> str | None:
        """The path an id named, including one already removed.

        Cookie ordering only -- :meth:`resolve` is still the authority
        on whether a handle is live, and still refuses a removed one.

        Args:
            fileid (int): the id a client sent back as a cookie.

        Returns:
            str | None: the path, or None when the id was never minted.
        """
        path = self._by_id.get(fileid)
        return self._removed.get(fileid) if path is None else path

    def guard_rename(self, old: str, new: str) -> None:
        """Refuse a rename whose destination lies inside its source.

        Callers run this before the backend rename: raising it from
        :meth:`rename` alone would fire after the backend already
        moved the tree, leaving the table and the store disagreeing.

        Args:
            old (str): path being moved.
            new (str): where it would land.

        Raises:
            OSError: EINVAL for a destination inside the source.
        """
        if new == old or new.startswith(_descendant_prefix(old)):
            raise OSError(
                errno.EINVAL, os.strerror(errno.EINVAL),
                f"cannot rename {old!r} into its own subtree {new!r}")

    def rename(self, old: str, new: str) -> None:
        """Move ``old`` to ``new``, carrying every descendant with it.

        A rename moves a whole subtree, so every id below the source has
        to be rewritten: an id left pointing at the old path resolves to
        somewhere that no longer exists, and the client sees its handle
        rot for a file it never touched. The source itself may be
        untracked while its children are not, so the subtree pass runs
        either way.

        Any id already held for the destination is invalidated, matching
        what the rename did to the file that used to live there.

        Args:
            old (str): path being moved.
            new (str): where it lands.

        Raises:
            OSError: EINVAL when ``new`` lies inside ``old``. Rewriting
                the subtree in that case would map paths onto
                themselves, so the rename is refused outright; the
                errno is what the wire layer answers as NFS3ERR_INVAL.
        """
        self.guard_rename(old, new)
        old_prefix = _descendant_prefix(old)
        new_prefix = _descendant_prefix(new)
        moves = [(fileid, path) for fileid, path in self._by_id.items()
                 if path == old or path.startswith(old_prefix)]
        for fileid, path in moves:
            landed = new if path == old else new_prefix + path[len(old_prefix
                                                                   ):]
            displaced = self._by_path.get(landed)
            if displaced is not None and displaced != fileid:
                self._by_id.pop(displaced, None)
            if self._by_path.get(path) == fileid:
                self._by_path.pop(path, None)
            self._by_id[fileid] = landed
            self._by_path[landed] = fileid
