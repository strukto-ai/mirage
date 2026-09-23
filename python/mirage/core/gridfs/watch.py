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

from collections.abc import AsyncIterator

from mirage.accessor.gridfs import GridFSAccessor
from mirage.core.gridfs.client import (_prefix, _strip_prefix, iter_latest,
                                       prefix_query)
from mirage.core.timeutil import to_iso_z
from mirage.types import PathSpec, WalkEntry
from mirage.utils.key_prefix import mount_prefix_of
from mirage.watch.base import DeltaHook
from mirage.watch.delta import ListingDeltaHook
from mirage.watch.walk import synth_dirs


class GridFSWalk:
    """One flat ``fs.files`` aggregation feeding the generic differ.

    GridFS stores a flat filename space, so the whole subtree comes back
    from a single prefix query rather than one round trip per directory,
    and the aggregation already reduces each filename to its newest
    revision. Reads the collection directly, never through mirage's
    caches, as the DeltaHook contract requires.

    Fingerprints on the revision's ObjectId, which is exactly what
    ``gridfs`` stat reports. That is an exact version: every upload
    mints a new document, so a rewrite always moves it and an untouched
    file never does.
    """

    def __init__(self, accessor: GridFSAccessor) -> None:
        """Args:
            accessor (GridFSAccessor): Backend handle.
        """
        self._accessor = accessor

    async def __call__(self, root: PathSpec) -> AsyncIterator[WalkEntry]:
        """Yield every entry under ``root``.

        Args:
            root (PathSpec): Watch root (mount-virtual path).
        """
        config = self._accessor.config
        prefix = mount_prefix_of(root.virtual, root.vfs_path)
        pfx = _prefix(root.mount_path, config)
        files: list[str] = []
        markers: list[str] = []
        async for doc in iter_latest(self._accessor, prefix_query(pfx)):
            filename = doc["filename"]
            relative = _strip_prefix(filename, config)
            virtual = (prefix.rstrip("/") + "/" +
                       relative.lstrip("/") if prefix else "/" +
                       relative.lstrip("/"))
            if filename.endswith("/"):
                # A directory marker, the same convention readdir reads
                # as an immediate child directory.
                markers.append(virtual.rstrip("/"))
                continue
            files.append(virtual)
            upload = doc.get("uploadDate")
            modified = to_iso_z(upload) if upload else None
            yield WalkEntry(virtual=virtual,
                            is_dir=False,
                            fingerprint=str(doc["_id"]),
                            size=doc["length"],
                            modified=modified)
        for entry in synth_dirs(root.virtual, files, markers):
            yield entry


def build_delta_hook(accessor: GridFSAccessor) -> DeltaHook:
    """Build the GridFS delta hook.

    Args:
        accessor (GridFSAccessor): Backend handle.
    """
    return ListingDeltaHook(GridFSWalk(accessor))
