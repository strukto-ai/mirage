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

from collections.abc import (AsyncIterator, Awaitable, Callable, Iterable,
                             Iterator)

from mirage.cache.index import IndexCacheStore
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.types import FileStat, FileType, PathSpec, WalkEntry
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.watch.fingerprint import stat_fingerprint

ReaddirFn = Callable[[PathSpec, IndexCacheStore], Awaitable[list[str]]]
StatFn = Callable[[PathSpec, IndexCacheStore], Awaitable[FileStat]]


def _ancestors(stem: str, start: str, seen: set[str]) -> Iterator[WalkEntry]:
    """Emit ``start`` and each ancestor up to but excluding ``stem``.

    Args:
        stem (str): Watch root, the exclusive upper bound.
        start (str): Deepest directory to emit.
        seen (set[str]): Paths already emitted; mutated in place so a
            shared prefix is reported once across calls.
    """
    parent = start
    while parent and parent != stem and parent not in seen:
        seen.add(parent)
        yield WalkEntry(virtual=parent, is_dir=True, fingerprint=None)
        parent = parent.rsplit("/", 1)[0]


def synth_dirs(root: str, files: Iterable[str],
               dirs: Iterable[str]) -> Iterator[WalkEntry]:
    """Directory rows a prefix store implies but does not store.

    An object store has no directories: ``ls`` shows them because
    readdir synthesizes them from the common prefixes of the keys, and a
    walk feeding change detection has to synthesize the same ones, or a
    consumer would see a file appear inside a directory that never
    appeared.

    ``dirs`` carries prefixes the store does name explicitly (a
    zero-byte marker key, which mirage's own ``mkdir`` writes), so an
    empty directory is still reported. A prefix backed by both a marker
    and children is reported once.

    ``root`` itself is never emitted; ``find``'s start-point rule
    applies here too, the generic owns that row.

    Args:
        root (str): Watch root's virtual path.
        files (Iterable[str]): Virtual paths of every file under the
            root; each contributes its ancestor chain.
        dirs (Iterable[str]): Virtual paths of explicitly stored
            directories; each contributes itself and its ancestors.
    """
    stem = root.rstrip("/")
    seen: set[str] = set()
    for path in dirs:
        yield from _ancestors(stem, path.rstrip("/"), seen)
    for path in files:
        yield from _ancestors(stem, path.rsplit("/", 1)[0], seen)


def entry_of(virtual: str, stat: FileStat) -> WalkEntry:
    """One walk row built from a backend's own stat.

    Args:
        virtual (str): Entry's virtual path.
        stat (FileStat): What the backend reported for it.
    """
    if stat.type == FileType.DIRECTORY:
        return WalkEntry(virtual=virtual, is_dir=True, fingerprint=None)
    return WalkEntry(virtual=virtual,
                     is_dir=False,
                     fingerprint=stat_fingerprint(stat.fingerprint,
                                                  stat.modified, stat.size),
                     size=stat.size,
                     modified=stat.modified)


async def _stat_at(stat: StatFn, virtual: str, prefix: str,
                   index: IndexCacheStore) -> FileStat | None:
    """Stat one virtual path, or None when it has vanished.

    Args:
        stat (StatFn): Backend stat.
        virtual (str): Absolute virtual path.
        prefix (str): Mount prefix.
        index (IndexCacheStore): Index the walk is populating.
    """
    spec = PathSpec(virtual=virtual,
                    directory=virtual,
                    resolved=False,
                    vfs_path=mount_key(virtual, prefix))
    try:
        return await stat(spec, index)
    except FileNotFoundError:
        # Removed between the readdir and the stat; the next pull
        # reports the DELETE from the snapshot diff. Only absence is
        # swallowed, an API error still propagates.
        return None


async def _descend(readdir: ReaddirFn, stat: StatFn, spec: PathSpec,
                   index: IndexCacheStore,
                   prefix: str) -> AsyncIterator[WalkEntry]:
    """Yield every entry under one directory, depth first.

    Args:
        readdir (ReaddirFn): Backend readdir.
        stat (StatFn): Backend stat.
        spec (PathSpec): Directory to descend into.
        index (IndexCacheStore): Index the walk is populating.
        prefix (str): Mount prefix.
    """
    try:
        children = await readdir(spec, index)
    except FileNotFoundError:
        return
    for child in children:
        # Classification is stat's job, the same rule find's walk
        # follows: the one in-band proof is a trailing slash on a cold
        # listing, and the stat behind it is an index lookup against
        # the readdir that just populated it, not another request.
        trimmed = child.rstrip("/")
        if child.endswith("/"):
            yield WalkEntry(virtual=trimmed, is_dir=True, fingerprint=None)
            is_dir = True
        else:
            found = await _stat_at(stat, trimmed, prefix, index)
            if found is None:
                continue
            yield entry_of(trimmed, found)
            is_dir = found.type == FileType.DIRECTORY
        if is_dir:
            child_spec = PathSpec(virtual=trimmed,
                                  directory=trimmed,
                                  resolved=False,
                                  vfs_path=mount_key(trimmed, prefix))
            async for row in _descend(readdir, stat, child_spec, index,
                                      prefix):
                yield row


class ReaddirWalk:
    """Recursive readdir descent for a backend with no recursive listing.

    Box, Google Drive and Microsoft Graph key their trees by opaque id,
    so a child cannot be addressed without having listed its parent, and
    none of them offers a whole-subtree listing. This walks them the way
    ``find`` does, one readdir per directory.

    Each pull builds its **own** index and throws it away afterwards.
    That is what keeps the DeltaHook contract: the index is not mirage's
    read cache, so the walk cannot compare the cache to itself, and it
    starts empty every time, so nothing carries over between pulls. It
    still has to exist, because these backends resolve a path's id
    through the index their parent's readdir populated; handing them
    ``NULL_INDEX`` makes every path below the root read as absent.
    """

    def __init__(self, readdir: ReaddirFn, stat: StatFn) -> None:
        """Args:
            readdir (ReaddirFn): Backend readdir, already bound to its
                accessor.
            stat (StatFn): Backend stat, already bound to its accessor.
        """
        self._readdir = readdir
        self._stat = stat

    async def __call__(self, root: PathSpec) -> AsyncIterator[WalkEntry]:
        """Yield every entry under ``root``.

        Args:
            root (PathSpec): Watch root (mount-virtual path).
        """
        prefix = mount_prefix_of(root.virtual, root.vfs_path)
        index = RAMIndexCacheStore()
        async for entry in _descend(self._readdir, self._stat, root, index,
                                    prefix):
            yield entry
