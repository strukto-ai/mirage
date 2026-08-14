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

import posixpath
from io import BytesIO
from typing import IO, BinaryIO, cast

from dulwich.index import (ConflictedIndexEntry, IndexEntry, read_index_dict,
                           write_index_dict)

from mirage.commands.cli.builtin.git.io import read_optional, write_file
from mirage.commands.cli.builtin.git.types import IndexState
from mirage.runtime.types import DispatchFn

INDEX_FILE = "index"
MERGE_HEAD = "MERGE_HEAD"


async def read_index(dispatch: DispatchFn, gitdir: str) -> IndexState:
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
        dispatch (DispatchFn): workspace op dispatcher.
        gitdir (str): absolute virtual path of this checkout's git
            directory.
    """
    data = await read_optional(dispatch, posixpath.join(gitdir, INDEX_FILE))
    merging = await read_optional(dispatch, posixpath.join(gitdir, MERGE_HEAD))
    if data is None:
        return IndexState(entries={},
                          conflicts={},
                          merging=merging is not None)
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
    return IndexState(entries=entries,
                      conflicts=conflicts,
                      merging=merging is not None)


async def write_index(dispatch: DispatchFn, gitdir: str,
                      state: IndexState) -> None:
    """Write ``.git/index`` back through the dispatcher.

    Written whole, because that is what the format is: a header, every
    entry in path order, then a checksum over all of it. git writes a
    temporary file and renames it so a reader never sees half an index;
    that cannot be reproduced here, since a mount offers no atomic
    rename across every backend, and a torn write would leave the
    repository unreadable. What bounds the risk instead is that the
    index is small and written in one call.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        gitdir (str): absolute virtual path of this checkout's git
            directory.
        state (IndexState): what the index should now say.
    """
    merged: dict[bytes, IndexEntry | ConflictedIndexEntry] = {}
    merged.update(state.entries)
    merged.update(state.conflicts)
    buffer = BytesIO()
    write_index_dict(cast(IO[bytes], buffer), merged)
    await write_file(dispatch, posixpath.join(gitdir, INDEX_FILE),
                     buffer.getvalue())
