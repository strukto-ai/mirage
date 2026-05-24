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

from datetime import datetime, timezone

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.databricks_volume.errors import is_not_found
from mirage.core.databricks_volume.path import backend_path
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.filetype import guess_type


def _modified(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, (int, float)):
        timestamp = value / 1000 if value > 10_000_000_000 else value
        return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
    return str(value)


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


def _directory_stat_or_raise(
    accessor: DatabricksVolumeAccessor,
    remote_path: str,
    path: PathSpec,
) -> FileStat:
    try:
        accessor.files.get_directory_metadata(remote_path)
    except Exception as exc:
        if is_not_found(exc):
            raise FileNotFoundError(path.strip_prefix) from exc
        raise
    return FileStat(name=_name_from_backend_path(remote_path),
                    type=FileType.DIRECTORY)


async def stat(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> FileStat:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    stripped = path.strip_prefix.strip("/")
    if not stripped:
        return FileStat(name="/", type=FileType.DIRECTORY)
    remote_path = backend_path(accessor.config, path)
    try:
        metadata = accessor.files.get_metadata(remote_path)
    except Exception as exc:
        if is_not_found(exc):
            return _directory_stat_or_raise(accessor, remote_path, path)
        raise
    name = _name_from_backend_path(remote_path)
    if _is_directory(metadata):
        return FileStat(name=name, type=FileType.DIRECTORY)
    size = getattr(metadata, "file_size", None)
    modified = _modified(getattr(metadata, "modification_time", None))
    return FileStat(name=name,
                    size=size,
                    modified=modified,
                    type=guess_type(name))
