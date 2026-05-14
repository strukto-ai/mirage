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

from datetime import timezone

from mirage.accessor.s3 import S3Accessor
from mirage.cache.index import IndexCacheStore
from mirage.core.s3._client import _client_kwargs, _key, async_session
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.filetype import guess_type


def _is_not_found(exc: Exception) -> bool:
    if hasattr(exc, "response"):
        code = exc.response.get("Error", {}).get("Code")
        return code in ("404", "NoSuchKey")
    return False


async def stat(accessor: S3Accessor,
               path: PathSpec,
               index: IndexCacheStore = None) -> FileStat:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    original_prefix = ""
    if isinstance(path, PathSpec):
        original_prefix = path.prefix
        path = path.original
    if original_prefix and path.startswith(original_prefix):
        path = path[len(original_prefix):] or "/"

    stripped = path.strip("/")

    if not stripped:
        return FileStat(name="/", type=FileType.DIRECTORY)

    # Fast path: check the index cache populated by readdir().
    # readdir() stores entries with resource_type="folder" or "file"
    # and file sizes, so stat can return instantly for known paths.
    if index is not None:
        virtual_key = (original_prefix + "/" +
                       stripped if original_prefix else "/" + stripped)
        lookup = await index.get(virtual_key)
        if lookup.entry is not None:
            entry = lookup.entry
            if entry.resource_type == "folder":
                return FileStat(name=entry.name, type=FileType.DIRECTORY)
            # TODO: propagate ETag into IndexCacheEntry so this fast
            # path can also carry fingerprint.
            return FileStat(
                name=entry.name,
                size=entry.size,
                type=guess_type(entry.name),
            )
        # If the parent directory was already listed by readdir() but
        # this path is not among its children, it does not exist.
        # This avoids expensive network calls for paths that shells
        # probe speculatively (e.g. .git, HEAD, .hg during cd).
        parent = virtual_key.rsplit("/", 1)[0] or "/"
        parent_listing = await index.list_dir(parent)
        if parent_listing.entries is not None:
            raise FileNotFoundError(path)

    # Slow path: no index cache available, or parent directory not yet
    # listed. Hit the network.
    config = accessor.config
    key = _key(path)
    session = async_session(config)
    async with session.client(**_client_kwargs(config)) as client:
        # Try head_object first — works for files.
        try:
            resp = await client.head_object(Bucket=config.bucket, Key=key)
            modified = resp["LastModified"].astimezone(
                timezone.utc).isoformat()
            etag_raw = resp.get("ETag", "").strip('"')
            vid_raw = resp.get("VersionId")
            if vid_raw == "null":
                vid_raw = None
            return FileStat(
                name=path.rstrip("/").rsplit("/", 1)[-1],
                size=resp["ContentLength"],
                modified=modified,
                type=guess_type(path),
                fingerprint=etag_raw or None,
                revision=vid_raw or None,
                extra={"etag": etag_raw},
            )
        except Exception as exc:
            if not _is_not_found(exc):
                raise

        # head_object returned 404 — check if the path is a valid
        # prefix (directory). S3/GCS don't have real directory objects,
        # so we probe with list_objects_v2 using MaxKeys=1.
        pfx = key.rstrip("/") + "/" if key else ""
        resp = await client.list_objects_v2(
            Bucket=config.bucket,
            Prefix=pfx,
            Delimiter="/",
            MaxKeys=1,
        )
        if resp.get("CommonPrefixes") or resp.get("Contents"):
            return FileStat(
                name=path.rstrip("/").rsplit("/", 1)[-1] or "/",
                type=FileType.DIRECTORY,
            )

        raise FileNotFoundError(path)
