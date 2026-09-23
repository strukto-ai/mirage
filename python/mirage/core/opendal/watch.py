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

import opendal
from opendal.exceptions import NotFound
from opendal.types import Metadata

from mirage.core.opendal.types import OperatorAccessor
from mirage.types import PathSpec, WalkEntry
from mirage.utils.key_prefix import mount_prefix_of
from mirage.watch.base import DeltaHook
from mirage.watch.delta import ListingDeltaHook
from mirage.watch.fingerprint import stat_fingerprint


class OpendalWalk:
    """Recursive opendal list feeding the generic listing differ.

    Reads through the operator directly (one recursive LIST), never
    through mirage's caches, as the DeltaHook contract requires.
    Fingerprints use mirage's default: the native ETag when the listing
    carries one, ``mtime|size`` otherwise.

    Some opendal services answer LIST without per-entry metadata (the hf
    lister does; WebDAV's PROPFIND does not), which would leave every
    file unfingerprinted and reduce detection to create/delete. When a
    listed file carries no metadata at all, one ``stat`` per affected
    file fills the gap, mirroring what the hf readdir already does for
    sizes. A backend whose lister is complete never pays for it.
    """

    def __init__(self, accessor: OperatorAccessor) -> None:
        """Args:
            accessor (OperatorAccessor): Backend handle exposing an
                opendal operator.
        """
        self._accessor = accessor

    async def __call__(self, root: PathSpec) -> AsyncIterator[WalkEntry]:
        """Yield every entry under ``root``.

        Args:
            root (PathSpec): Watch root (mount-virtual path).
        """
        prefix = mount_prefix_of(root.virtual, root.vfs_path)
        base = root.vfs_path.strip("/")
        list_path = base + "/" if base else "/"
        op = self._accessor.operator()
        try:
            entries = await op.list(list_path, recursive=True)
        except NotFound:
            return
        async for entry in entries:
            relative = entry.path
            if not relative or relative == list_path:
                continue
            is_dir = relative.endswith("/")
            vfs_rel = relative.rstrip("/")
            virtual = (prefix.rstrip("/") + "/" + vfs_rel if prefix else "/" +
                       vfs_rel)
            if is_dir:
                yield WalkEntry(virtual=virtual, is_dir=True, fingerprint=None)
                continue
            meta = entry.metadata
            if meta is None or (meta.etag is None
                                and meta.last_modified is None
                                and meta.content_length is None):
                meta = await self._stat(op, vfs_rel)
            modified = meta.last_modified.isoformat() \
                if meta and meta.last_modified else None
            size = meta.content_length if meta else None
            fingerprint = stat_fingerprint(meta.etag if meta else None,
                                           modified, size)
            yield WalkEntry(virtual=virtual,
                            is_dir=False,
                            fingerprint=fingerprint,
                            size=size,
                            modified=modified)

    async def _stat(self, op: opendal.AsyncOperator,
                    key: str) -> Metadata | None:
        """Fetch one entry's metadata when the listing omitted it.

        Args:
            op (opendal.AsyncOperator): Open operator.
            key (str): Operator-relative key of the entry.
        """
        try:
            return await op.stat(key)
        except NotFound:
            # Deleted between the listing and the stat; the next pull
            # reports the DELETE from the snapshot diff.
            return None


def build_delta_hook(accessor: OperatorAccessor) -> DeltaHook:
    """Build a delta hook for any opendal-backed accessor.

    Args:
        accessor (OperatorAccessor): Backend handle exposing an opendal
            operator.
    """
    return ListingDeltaHook(OpendalWalk(accessor))
