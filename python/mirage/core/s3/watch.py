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

from mirage.accessor.s3 import S3Accessor
from mirage.core.s3.client import (_client_kwargs, _key, _strip_prefix,
                                   async_session)
from mirage.core.timeutil import to_iso_z
from mirage.types import PathSpec, WalkEntry
from mirage.utils.key_prefix import mount_prefix_of
from mirage.watch.base import DeltaHook
from mirage.watch.delta import ListingDeltaHook
from mirage.watch.fingerprint import stat_fingerprint
from mirage.watch.walk import synth_dirs


class S3Walk:
    """Recursive ``list_objects_v2`` feeding the generic listing differ.

    One paginated LIST with no Delimiter covers the whole subtree, so a
    pull costs one request per 1000 keys rather than one per directory.
    Reads the bucket directly, never through mirage's caches, as the
    DeltaHook contract requires.

    Fingerprints on the object's ETag, which for a single-part upload is
    the MD5 of the content, so an overwrite with identical bytes is
    correctly reported as no change. Multipart ETags are a digest of the
    part digests, which still changes with the content.
    """

    def __init__(self, accessor: S3Accessor) -> None:
        """Args:
            accessor (S3Accessor): Backend handle.
        """
        self._accessor = accessor

    async def __call__(self, root: PathSpec) -> AsyncIterator[WalkEntry]:
        """Yield every entry under ``root``.

        Args:
            root (PathSpec): Watch root (mount-virtual path).
        """
        config = self._accessor.config
        prefix = mount_prefix_of(root.virtual, root.vfs_path)
        stem = _key(root.mount_path, config).rstrip("/")
        base = (stem + "/") if stem else ""
        files: list[str] = []
        markers: list[str] = []
        client = await self._accessor.cached_client(
            lambda: async_session(config).client(**_client_kwargs(config)))
        paginator = client.get_paginator("list_objects_v2")
        async for page in paginator.paginate(Bucket=config.bucket,
                                             Prefix=stem):
            for obj in page.get("Contents") or []:
                okey = obj["Key"]
                if not (okey == stem or okey.startswith(base)):
                    continue
                relative = _strip_prefix(okey, config)
                virtual = (prefix.rstrip("/") + "/" +
                           relative.lstrip("/") if prefix else "/" +
                           relative.lstrip("/"))
                if okey.endswith("/"):
                    # A directory marker: mirage's own mkdir writes
                    # one. It carries an ETag and a size, but it is
                    # not a file, so synth_dirs reports it instead.
                    markers.append(virtual.rstrip("/"))
                    continue
                files.append(virtual)
                last_mod = obj.get("LastModified")
                modified = to_iso_z(last_mod) if last_mod else None
                size = obj.get("Size")
                etag = (obj.get("ETag") or "").strip('"') or None
                yield WalkEntry(virtual=virtual,
                                is_dir=False,
                                fingerprint=stat_fingerprint(
                                    etag, modified, size),
                                size=size,
                                modified=modified)
        for entry in synth_dirs(root.virtual, files, markers):
            yield entry


def build_delta_hook(accessor: S3Accessor) -> DeltaHook:
    """Build the delta hook shared by S3 and every S3-compatible alias.

    Args:
        accessor (S3Accessor): Backend handle.
    """
    return ListingDeltaHook(S3Walk(accessor))
