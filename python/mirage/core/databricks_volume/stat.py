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
from email.utils import parsedate_to_datetime

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.core.databricks_volume.client import (
    get_directory_metadata,
    get_metadata,
)
from mirage.core.databricks_volume.errors import is_not_found
from mirage.core.databricks_volume.path import backend_path
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.dates import to_iso_z
from mirage.utils.filetype import content_type_for_path


def modified_to_iso(value: str | int | None) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, int):
        return to_iso_z(datetime.fromtimestamp(value / 1000, timezone.utc))
    try:
        parsed = parsedate_to_datetime(str(value))
    except (TypeError, ValueError):
        return str(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return to_iso_z(parsed)


def _name_from_backend_path(path: str) -> str:
    return path.rstrip("/").rsplit("/", 1)[-1]


async def _directory_stat_or_raise(
    accessor: DatabricksVolumeAccessor,
    remote_path: str,
    path: PathSpec,
) -> FileStat:
    try:
        await get_directory_metadata(accessor, remote_path)
    except Exception as exc:
        if is_not_found(exc):
            raise enoent(path) from exc
        raise
    return FileStat(
        name=_name_from_backend_path(remote_path), type=FileType.DIRECTORY
    )


async def stat(accessor: DatabricksVolumeAccessor, path: PathSpec) -> FileStat:
    stripped = path.mount_path.strip("/")
    if not stripped:
        return FileStat(name="/", type=FileType.DIRECTORY)
    remote_path = backend_path(accessor.config, path)
    try:
        metadata = await get_metadata(accessor, remote_path)
    except Exception as exc:
        if is_not_found(exc):
            return await _directory_stat_or_raise(accessor, remote_path, path)
        raise
    name = _name_from_backend_path(remote_path)
    size = metadata.content_length
    modified = modified_to_iso(metadata.last_modified)
    return FileStat(
        name=name,
        size=size,
        modified=modified,
        type=FileType.FILE,
        content=content_type_for_path(name),
    )
