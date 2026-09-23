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
import os
from collections.abc import AsyncIterator
from pathlib import Path

from mirage.accessor.disk import DiskAccessor
from mirage.core.timeutil import epoch_to_iso
from mirage.types import PathSpec, WalkEntry
from mirage.utils.key_prefix import mount_prefix_of
from mirage.watch.base import DeltaHook
from mirage.watch.delta import ListingDeltaHook
from mirage.watch.fingerprint import stat_fingerprint


def resolve(root: Path, path: str) -> Path:
    """Host path for a mount-relative path, refusing an escape.

    Args:
        root (Path): Mount root on the local filesystem.
        path (str): Mount-relative path.
    """
    relative = path.lstrip("/")
    resolved = (root / relative).resolve()
    resolved.relative_to(root)
    return resolved


def reraise(error: OSError) -> None:
    """Fail the walk on a directory it could not read.

    ``os.walk`` swallows every listing error by default, which for a
    snapshot differ means an unreadable subtree is indistinguishable
    from an empty one: it diffs into a DELETE for every child, then a
    CREATE for each when access comes back. Absence is the one error
    that is genuinely a DELETE, and the caller drops it.

    Args:
        error (OSError): The failure ``os.walk`` was about to discard.
    """
    raise error


def walk_sync(root: Path,
              path: str) -> list[tuple[str, bool, str | None, int | None]]:
    """Collect (mount-relative path, is_dir, mtime, size) under a path.

    Runs in a worker thread; ``os.walk`` and ``stat`` are blocking.
    Symlinks are not followed, matching every other disk walk in the
    repo and keeping a link loop from hanging the poll.

    Args:
        root (Path): Mount root on the local filesystem.
        path (str): Mount-relative directory to walk.
    """
    start = resolve(root, path)
    out: list[tuple[str, bool, str | None, int | None]] = []
    for dirpath, dirnames, filenames in os.walk(start, onerror=reraise):
        current = Path(dirpath)
        for name in dirnames:
            relative = (current / name).relative_to(root).as_posix()
            out.append(("/" + relative, True, None, None))
        for name in filenames:
            full = current / name
            relative = full.relative_to(root).as_posix()
            try:
                info = full.lstat()
            except FileNotFoundError:
                # Same rule one entry down: a file that vanished between
                # the listing and the stat is a DELETE the next pull
                # reports, an unreadable one is not.
                continue
            out.append(("/" + relative, False, epoch_to_iso(info.st_mtime),
                        info.st_size))
    return out


class DiskWalk:
    """Recursive ``os.walk`` feeding the generic listing differ.

    Reads the filesystem directly, never through mirage's caches, as
    the DeltaHook contract requires. Fingerprints on mtime, the same
    value ``disk`` stat reports, so an editor that rewrites identical
    bytes still registers as an UPDATE. That is the local filesystem's
    own resolution, not a mirage choice: nothing cheaper than hashing
    every file can tell those two apart.
    """

    def __init__(self, accessor: DiskAccessor) -> None:
        """Args:
            accessor (DiskAccessor): Backend handle.
        """
        self._accessor = accessor

    async def __call__(self, root: PathSpec) -> AsyncIterator[WalkEntry]:
        """Yield every entry under ``root``.

        Args:
            root (PathSpec): Watch root (mount-virtual path).
        """
        prefix = mount_prefix_of(root.virtual, root.vfs_path)
        try:
            found = await asyncio.to_thread(walk_sync, self._accessor.root,
                                            root.mount_path)
        except FileNotFoundError:
            return
        for relative, is_dir, modified, size in found:
            virtual = (prefix.rstrip("/") + relative if prefix else relative)
            if is_dir:
                yield WalkEntry(virtual=virtual, is_dir=True, fingerprint=None)
                continue
            yield WalkEntry(virtual=virtual,
                            is_dir=False,
                            fingerprint=stat_fingerprint(None, modified, size),
                            size=size,
                            modified=modified)


def build_delta_hook(accessor: DiskAccessor) -> DeltaHook:
    """Build the disk delta hook.

    Args:
        accessor (DiskAccessor): Backend handle.
    """
    return ListingDeltaHook(DiskWalk(accessor))
