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
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.databricks_volume.errors import is_not_found
from mirage.core.databricks_volume.path import backend_path
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import guess_type
from mirage.utils.key_prefix import mount_prefix_of


def modified_to_iso(value) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, (int, float)):
        timestamp = value / 1000 if value > 10_000_000_000 else value
        return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
    try:
        parsed = parsedate_to_datetime(str(value))
    except (TypeError, ValueError):
        return str(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _is_directory(metadata) -> bool:
    value = getattr(metadata, "is_directory", None)
    if value is not None:
        return bool(value)
    object_type = getattr(metadata, "object_type", None)
    if object_type is None:
        return False
    return str(object_type).lower().endswith("directory")


def _name_from_backend_path(path: str) -> str:
    return path.rstrip("/").rsplit("/", 1)[-1]


async def _directory_stat_or_raise(
    accessor: DatabricksVolumeAccessor,
    remote_path: str,
    path: PathSpec,
) -> FileStat:
    try:
        await asyncio.to_thread(accessor.files.get_directory_metadata,
                                remote_path)
    except Exception as exc:
        if is_not_found(exc):
            raise enoent(path) from exc
        raise
    return FileStat(name=_name_from_backend_path(remote_path),
                    type=FileType.DIRECTORY)


async def stat(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    index: IndexCacheStore | None = None,
) -> FileStat:
    stripped = path.mount_path.strip("/")
    if not stripped:
        return FileStat(name="/", type=FileType.DIRECTORY)
    if index is not None:
        prefix = mount_prefix_of(path.virtual, path.resource_path)
        virtual_key = (prefix.rstrip("/") + "/" + stripped if prefix else "/" +
                       stripped)
        lookup = await index.get(virtual_key)
        if lookup.entry is not None:
            entry = lookup.entry
            if entry.resource_type == "folder":
                return FileStat(name=entry.name, type=FileType.DIRECTORY)
            return FileStat(name=entry.name,
                            size=entry.size,
                            modified=entry.remote_time or None,
                            type=guess_type(entry.name))
        parent = virtual_key.rsplit("/", 1)[0] or "/"
        parent_listing = await index.list_dir(parent)
        if parent_listing.entries is not None:
            raise enoent(path)
    remote_path = backend_path(accessor.config, path)
    try:
        metadata = await asyncio.to_thread(accessor.files.get_metadata,
                                           remote_path)
    except Exception as exc:
        if is_not_found(exc):
            return await _directory_stat_or_raise(accessor, remote_path, path)
        raise
    name = _name_from_backend_path(remote_path)
    if _is_directory(metadata):
        return FileStat(name=name, type=FileType.DIRECTORY)
    size = getattr(metadata, "content_length", None)
    modified = modified_to_iso(getattr(metadata, "last_modified", None))
    return FileStat(name=name,
                    size=size,
                    modified=modified,
                    type=guess_type(name))
