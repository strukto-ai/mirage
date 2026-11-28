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

import hashlib
import logging
from dataclasses import replace
from io import BytesIO
from typing import IO, BinaryIO, cast

from dulwich.index import (
    ConflictedIndexEntry,
    IndexEntry,
    read_index_dict,
    write_index_dict,
)

from mirage.commands.cli.builtin.git.errors import ResolveIndexError
from mirage.commands.cli.builtin.git.io import (
    lstat,
    read_optional,
    write_file,
)
from mirage.commands.cli.builtin.git.types import IndexState
from mirage.types import FileStat, PathSpec
from mirage.view.types import MountView
from mirage.workspace.files import Files

logger = logging.getLogger(__name__)

MERGE_HEAD = "MERGE_HEAD"


def _kept(fingerprint: str) -> tuple[int, int]:
    """The ``dev`` and ``ino`` an entry keeps a fingerprint as: the first
    eight bytes of its SHA-1.

    Args:
        fingerprint (str): what the mount stats for the file.
    """
    digest = hashlib.sha1(fingerprint.encode()).digest()
    return int.from_bytes(digest[:4], "big"), int.from_bytes(
        digest[4:8], "big"
    )


def with_fingerprint(entry: IndexEntry, info: FileStat) -> IndexEntry:
    """``entry`` keeping what the mount says of the file it was read from
    or written to, so a later comparison can find it unchanged unread.

    git caches a file's stat (device, inode, times, size) in its entry to
    the same end. A mount has no inode or device a later stat could be
    held against, but it has a fingerprint that moves whenever the file's
    bytes change, so the entry keeps that in the two fields instead. A
    mount that answers none leaves them zero, which git reads as nothing
    cached, and the file is read next time.

    Args:
        entry (IndexEntry): the entry for the file's bytes.
        info (FileStat): the mount's stat of the file, taken before it
            was read or after it was written.
    """
    if not info.fingerprint:
        return replace(entry, dev=0, ino=0)
    dev, ino = _kept(info.fingerprint)
    return replace(entry, dev=dev, ino=ino)


async def still_stats(
    vfs: Files, path: PathSpec, info: FileStat, mounts: MountView | None
) -> FileStat | None:
    """The backend's own stat of a file just read, when it still gives the
    fingerprint ``info`` had before the read; None when it gives another,
    none, or refuses the stat, or when the read may not have asked it.

    A fingerprint kept with a blob has to describe the bytes hashed, and
    a stat from before the read may be older than they are: a kept
    listing's row, or a file another writer changed in between. One more
    stat after the read catches either; a file that changed and changed
    back within the read is the window that remains. A mount that keeps
    bodies may have answered the read from bytes older than either stat,
    so its fingerprints are not kept from a read at all.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path of the file.
        info (FileStat): the stat taken before the read.
        mounts (MountView | None): the session's mount boundaries.
    """
    if (
        mounts is not None
        and mounts.keeps_bodies is not None
        and mounts.keeps_bodies(path.virtual)
    ):
        return None
    try:
        after = await lstat(vfs, path, fresh=True)
    except PermissionError as exc:
        logger.debug("git: no fresh stat of %s: %s", path.virtual, exc)
        return None
    if after is None or not after.fingerprint:
        return None
    return after if after.fingerprint == info.fingerprint else None


def unchanged(entry: IndexEntry, info: FileStat) -> bool:
    """Whether the mount says the file is still the one ``entry`` kept,
    which settles it without reading the file.

    Args:
        entry (IndexEntry): what the index records for the path.
        info (FileStat): what the mount says about it now.
    """
    if not info.fingerprint or (entry.dev == 0 and entry.ino == 0):
        return False
    return _kept(info.fingerprint) == (entry.dev, entry.ino)


async def read_index(vfs: Files, gitdir: PathSpec) -> IndexState:
    """Read ``.git/index`` through the dispatcher.

    The index is the third thing ``status`` compares, and the only one
    that is a single file: HEAD's tree is assembled from objects and the
    working tree is walked, but staged content is one binary blob. That
    makes it the cheapest of the three and the reason it is read whole
    rather than windowed.

    An absent index is not an error. ``git init`` writes none until the
    first ``git add``, and every path is then untracked, which is what an
    empty table already says.

    The index lives in ``gitdir``, never ``commondir``: a linked
    worktree stages its own content, and pointing this at the shared
    directory would show one checkout's staged changes in another.

    Args:
        vfs (Files): the session's files.
        gitdir (PathSpec): absolute virtual path of this checkout's git
            directory.
    """
    data = await read_optional(vfs, gitdir.join("index"))
    merging = await read_optional(vfs, gitdir.join(MERGE_HEAD))
    if data is None:
        return IndexState(
            entries={}, conflicts={}, merging=merging is not None
        )
    # Cast because dulwich types the parameter as BinaryIO while reading
    # it through the buffer protocol, which BytesIO satisfies.
    parsed = read_index_dict(cast(BinaryIO, BytesIO(data)))
    entries: dict[bytes, IndexEntry] = {}
    conflicts: dict[bytes, ConflictedIndexEntry] = {}
    for path, entry in parsed.items():
        if isinstance(entry, ConflictedIndexEntry):
            conflicts[path] = entry
        else:
            entries[path] = entry
    return IndexState(
        entries=entries, conflicts=conflicts, merging=merging is not None
    )


async def write_index(vfs: Files, gitdir: PathSpec, state: IndexState) -> None:
    """Write ``.git/index`` back through the dispatcher.

    Written whole, because that is what the format is: a header, every
    entry in path order, then a checksum over all of it. git writes a
    temporary file and renames it so a reader never sees half an index;
    that cannot be reproduced here, since a mount offers no atomic
    rename across every backend, and a torn write would leave the
    repository unreadable. What bounds the risk instead is that the
    index is small and written in one call.

    Args:
        vfs (Files): the session's files.
        gitdir (PathSpec): absolute virtual path of this checkout's git
            directory.
        state (IndexState): what the index should now say.
    """
    merged: dict[bytes, IndexEntry | ConflictedIndexEntry] = {}
    merged.update(state.entries)
    merged.update(state.conflicts)
    buffer = BytesIO()
    write_index_dict(cast(IO[bytes], buffer), merged)
    await write_file(vfs, gitdir.join("index"), buffer.getvalue())


def refuse_unresolved(state: IndexState) -> None:
    """Refuse a branch move while the index still records conflict stages.

    Every collision check a checkout makes reads stage 0, so a path held
    only as stages 1-3 is invisible to all of them, and git refuses
    before it reads either tree. The refusal is not the moving side's
    alone: ``git switch <current>`` and ``git checkout <current>`` move
    nothing and still die on it, so a line that answers "Already on" out
    of a shortcut has to ask the index first. Pinned against git 2.50.1,
    where ``git switch -c <new>`` is the one line that survives an
    unresolved index, because it writes a ref and nothing else.

    Args:
        state (IndexState): the index as read, entries and stages.
    """
    if not state.conflicts:
        return
    raise ResolveIndexError(
        [path.decode("utf-8", errors="replace") for path in state.conflicts]
    )
