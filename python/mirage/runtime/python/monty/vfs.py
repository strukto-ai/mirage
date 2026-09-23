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
from typing import Callable, TypeVar

from mirage.runtime.types import VFSEntry, VFSStat
from mirage.runtime.vfs import RuntimeVFS

T = TypeVar("T")

# What counts as "nothing here" depends on what was asked, so there is
# one tuple per question rather than one tuple for the class.
#
# A read asks for BYTES, and a directory is a legitimate way to have
# none of them.
ABSENT_CONTENT = (FileNotFoundError, IsADirectoryError, NotADirectoryError)
# A stat and a listing both ask whether the path IS THERE, and there a
# directory is the answer rather than its absence: reading
# IsADirectoryError as a miss would send the guest to monty's own tree
# for a path the mount holds. Nothing else belongs in either tuple. A
# backend that refused the op has not said the path is gone, and
# folding that refusal into "no" reports a permission or a transport
# failure as an absence the guest cannot tell from a real one.
ABSENT_PATH = (FileNotFoundError, NotADirectoryError)
# Neither list carries ValueError, which both of them used to. It was
# never in the TypeScript twin, and it is wide enough to swallow a bug:
# a pydantic ValidationError from a malformed row is a ValueError, and
# reporting it as "the path is not there" hides it behind an answer
# the guest cannot tell from a real miss.

# What a refused readlink is allowed to mean "no link here". EINVAL is
# the backend saying the path is not one, and the other three are
# CPython's own `_ignore_error` list, which is what `Path.is_symlink`
# swallows around its lstat (EBADF is left out: no backend here answers
# on a descriptor). Everything else propagates, the same rule the two
# tuples above draw and for the same reason: CPython re-raises
# PermissionError out of `is_symlink`, and reporting a refusal as "not
# a link" is an answer the guest cannot tell from one. A bare
# `except OSError` swallowed all of them.
NOT_A_LINK = (errno.EINVAL, errno.ENOENT, errno.ENOTDIR, errno.ELOOP)


class MontyVFS:
    """Monty's mount view: the shared core plus a negative cache.

    Monty asks whether a path exists on nearly every guest expression,
    so a path the mount already answered "not there" for must not cost
    a second dispatch. Reads and listings return None for a miss rather
    than raising, which is the shape the encoder above wants, and every
    mutation keeps the cache honest.

    Only a question about EXISTENCE may feed that cache. A failed read
    proves nothing about the path: a ram mount reports a read of a
    directory as FileNotFoundError, so a read that recorded its miss
    made every later ``stat``, ``is_dir`` and ``exists`` of that
    directory answer from monty's own tree defaults instead of the
    mount's row - the exact divergence ``path_stat`` exists to remove.

    Args:
        core (RuntimeVFS | None): the shared op vocabulary, or None
            when the runtime was built without a workspace.
    """

    def __init__(self, core: RuntimeVFS | None) -> None:
        self._core = core
        self._missing: set[str] = set()

    @property
    def wired(self) -> bool:
        """True when a workspace dispatch is reachable."""
        return self._core is not None

    def read(self, virtual: str) -> bytes | None:
        """The file's bytes, or None when the mount does not have it."""
        return self._or_none(virtual, ABSENT_CONTENT,
                             lambda core: core.read(virtual))

    def readdir(self, virtual: str) -> list[VFSEntry] | None:
        """The directory's entries, or None when it is not a directory.

        Unclassified: every caller reads a row's path or only whether
        the listing answered, and a guest that wants a kind stats the
        entry itself, so the door stats nothing per entry.

        Args:
            virtual (str): the directory to list.
        """
        # Deliberately past the negative cache in both directions: the
        # self-heal that materializes a directory into monty's own tree
        # runs a listing for a path a stat just missed.
        if self._core is None:
            return None
        try:
            return self._core.readdir(virtual, classify=False)
        except ABSENT_PATH:
            return None

    def stat(self, virtual: str) -> VFSStat | None:
        """The path's row, or None when the mount does not have it.

        None rather than a raise, because the caller's next move is
        monty's own tree: a path no mount holds may still be a guest
        temp file, and only the tree knows. The TypeScript twin answers
        the same way and builds the guest's `stat_result` by hand
        (`monty/stat.ts`), since the JS package exports no `StatResult`
        to construct; what it cannot carry is the sequence half, so a
        guest subscripts a stat on this host only.

        Args:
            virtual (str): the path to stat.
        """
        row = self._or_none(virtual, ABSENT_PATH,
                            lambda core: core.stat(virtual))
        if row is None:
            self._missing.add(virtual)
        return row

    def _or_none(self, virtual: str, absent: tuple[type[Exception], ...],
                 run: Callable[[RuntimeVFS], T]) -> T | None:
        """Run one op, answering None for an absence rather than raising.

        It records nothing itself: only the caller that asked the
        existence question may feed the negative cache.

        Args:
            virtual (str): the path the operation names.
            absent (tuple[type[Exception], ...]): what counts as
                "nothing here" for this question.
            run (Callable[[RuntimeVFS], T]): the op to attempt.
        """
        core = self._core
        if core is None or virtual in self._missing:
            return None
        try:
            return run(core)
        except absent:
            return None

    def is_link(self, virtual: str) -> bool:
        """Whether the mount's name plane holds a symlink at `virtual`.

        Answered through the readlink op, not through the parent's
        listing, even though a readdir row now carries the mark. Three
        reasons, and all of them are about this tier rather than about
        the mark. The predicate arrives for one path with no listing in
        hand, and every other predicate here materializes that path
        alone, so reading the parent would trade one dispatch for a
        readdir plus a stat per sibling. A listing read is reached
        through the negative cache, and a DANGLING link is remembered
        as absent the moment the guest's own `exists()` stats it, so
        the mark would answer False for a link that is plainly there.
        And readlink is the gated channel: the node table has no
        session, so a mark read outside an admitted listing would
        answer for a path the door hides. The TypeScript twin asks
        readlink for the same three reasons now; it used to read the
        mark, and the dangling case is what caught it.

        Args:
            virtual (str): the path to test.
        """
        if self._core is None:
            return False
        try:
            self._core.readlink(virtual)
        except OSError as caught:
            if caught.errno not in NOT_A_LINK:
                raise
            return False
        return True

    def _established(self, virtual: str) -> None:
        """Forget every absence a creation just invalidated.

        The path itself and the ancestors it may have brought into
        being with it. `mkdir(parents=True)` is the obvious one, but a
        write has the same shape on a prefix store, where the key
        materializes every directory above it. Forgetting the leaf
        alone left an ancestor the guest had already asked about
        cached as missing, so a later stat of it skipped the mount's
        row and answered from monty's own tree with a synthetic mode
        and stamp.

        Args:
            virtual (str): the path that now exists.
        """
        self._missing.discard(virtual)
        slash = virtual.rfind("/")
        while slash > 0:
            self._missing.discard(virtual[:slash])
            slash = virtual.rfind("/", 0, slash)

    def _established_tree(self, virtual: str) -> None:
        """Forget the absences a rename invalidated at its destination.

        Everything ``_established`` forgets, plus everything UNDER the
        destination. A rename is the one op here that can make a whole
        subtree exist at once, and a cached absence never self-heals,
        because the cache answers before the dispatch ever runs. So a
        child the guest had asked about before the move went on reading
        as missing after it, for the rest of the run.

        Args:
            virtual (str): the directory that now exists, with its
                contents.
        """
        self._established(virtual)
        prefix = virtual.rstrip("/") + "/"
        for cached in [p for p in self._missing if p.startswith(prefix)]:
            self._missing.discard(cached)

    def write(self, virtual: str, data: bytes) -> None:
        if self._core is None:
            return
        self._core.write(virtual, data)
        self._established(virtual)

    def append(self, virtual: str, data: bytes, whole: bytes) -> None:
        """Ship only `data`, falling back to writing `whole`.

        Args:
            virtual (str): the file being appended to.
            data (bytes): only the newly appended bytes.
            whole (bytes): full content, for a mount with no append op.
        """
        if self._core is None:
            return
        self._core.append(virtual, data, whole)
        self._established(virtual)

    def create(self, virtual: str) -> None:
        if self._core is None:
            return
        self._core.create(virtual)
        self._established(virtual)

    def truncate(self, virtual: str) -> None:
        if self._core is None:
            return
        self._core.truncate(virtual)
        self._established(virtual)

    def mkdir(self, virtual: str, parents: bool) -> None:
        if self._core is None:
            return
        self._core.call("mkdir", virtual, parents=parents)
        self._established(virtual)

    def rmdir(self, virtual: str) -> None:
        if self._core is None:
            return
        self._core.rmdir(virtual)
        self._missing.add(virtual)

    def unlink(self, virtual: str) -> None:
        if self._core is None:
            return
        self._core.unlink(virtual)
        self._missing.add(virtual)

    def rename(self, src: str, dst: str) -> None:
        """Rename within one mount.

        Args:
            src (str): the source path.
            dst (str): the destination path.

        Raises:
            CrossMountError: the two ends live on different mounts.
        """
        if self._core is None:
            return
        self._core.rename(src, dst)
        self._missing.add(src)
        self._established_tree(dst)
