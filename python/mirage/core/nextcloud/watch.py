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

from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.types import PathSpec, WalkEntry
from mirage.utils.fingerprint import stat_fingerprint
from mirage.utils.key_prefix import mount_prefix_of
from mirage.watch.base import DeltaHook
from mirage.watch.delta import ListingDeltaHook


class NextcloudWalk:
    """Recursive WebDAV walk feeding the generic listing differ.

    Reads through the opendal operator directly (a single recursive
    PROPFIND), never through mirage's caches, as the DeltaHook contract
    requires. Fingerprints use mirage's default (native ETag when the
    listing carries one, mtime|size otherwise).
    """

    def __init__(self, accessor: NextcloudAccessor) -> None:
        """Args:
            accessor (NextcloudAccessor): Backend handle.
        """
        self._accessor = accessor

    async def __call__(self, root: PathSpec) -> AsyncIterator[WalkEntry]:
        """Yield every entry under ``root``.

        Args:
            root (PathSpec): Watch root (mount-virtual path).
        """
        prefix = mount_prefix_of(root.virtual, root.resource_path)
        base = root.resource_path.strip("/")
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
            resource_rel = relative.rstrip("/")
            virtual = (prefix.rstrip("/") + "/" +
                       resource_rel if prefix else "/" + resource_rel)
            meta = entry.metadata
            if is_dir:
                yield WalkEntry(virtual=virtual, is_dir=True, fingerprint=None)
                continue
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


def build_delta_hook(accessor: NextcloudAccessor) -> DeltaHook:
    """Build the Nextcloud delta hook.

    Args:
        accessor (NextcloudAccessor): Backend handle.
    """
    return ListingDeltaHook(NextcloudWalk(accessor))
