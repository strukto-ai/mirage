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
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.watch.base import DeltaHook
from mirage.watch.poller import ListingDeltaHook, WalkEntry


def _detector(meta: object) -> str | None:
    """Change detector for a WebDAV entry.

    Prefers the ETag; falls back to a ``mtime|size`` composite, which
    a WebDAV PROPFIND always carries and which still flips on a content
    write.

    Args:
        meta (object): opendal entry metadata.
    """
    etag = getattr(meta, "etag", None)
    if etag:
        return str(etag)
    last_modified = getattr(meta, "last_modified", None)
    size = getattr(meta, "content_length", None)
    stamp = last_modified.isoformat() if last_modified is not None else ""
    return f"{stamp}|{size}"


class NextcloudWalk:
    """Recursive WebDAV walk feeding the generic listing differ.

    Reads through the opendal operator directly (a single recursive
    PROPFIND), never through mirage's caches, as the DeltaHook contract
    requires.
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
            yield WalkEntry(
                virtual=virtual,
                is_dir=is_dir,
                detector=None if is_dir else _detector(entry.metadata))


def build_delta_hook(accessor: NextcloudAccessor) -> DeltaHook:
    """Build the Nextcloud delta hook.

    Args:
        accessor (NextcloudAccessor): Backend handle.
    """
    return ListingDeltaHook(NextcloudWalk(accessor))
