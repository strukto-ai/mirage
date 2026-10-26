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

from mirage.accessor.tidb_filesystem import TiDBFilesystemAccessor
from mirage.core.tidb_filesystem.client import stat_entry
from mirage.core.tidb_filesystem.dest import kinds_of, lookup_error
from mirage.core.tidb_filesystem.errors import has_status
from mirage.core.tidb_filesystem.path import backend_path
from mirage.core.tidb_filesystem.types import Entry
from mirage.errors.fs import enotdir
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.dates import to_iso_z
from mirage.utils.filetype import content_type_for_path
from mirage.utils.key_prefix import raw_path_of
from mirage.utils.path import ancestors, norm


def file_stat(entry: Entry) -> FileStat:
    modified = (
        to_iso_z(datetime.fromtimestamp(entry.mtime, timezone.utc))
        if entry.mtime
        else None
    )
    if entry.is_dir:
        return FileStat(
            name=entry.name, modified=modified, type=FileType.DIRECTORY
        )
    return FileStat(
        name=entry.name,
        size=entry.size,
        modified=modified,
        type=FileType.FILE,
        content=content_type_for_path(entry.name),
    )


async def stat(accessor: TiDBFilesystemAccessor, path: PathSpec) -> FileStat:
    """A path's metadata from one HEAD; a trailing slash asks for the
    directory of that name, as it does on an object store.

    Args:
        accessor (TiDBFilesystemAccessor): the file system's accessor.
        path (PathSpec): the file or directory.

    Raises:
        FileNotFoundError: nothing is at the path.
        NotADirectoryError: a component above it, or the path asked as a
            directory, is a file.
    """
    key = norm(path.mount_path)
    if key == "/":
        return FileStat(name="/", type=FileType.DIRECTORY)
    directory = raw_path_of(path).endswith("/")
    try:
        entry = await stat_entry(
            accessor, backend_path(accessor.config, path), directory
        )
    except Exception as exc:
        if not has_status(exc, 404):
            raise
        kinds = await kinds_of(accessor, [*ancestors(key), key])
        found = kinds.get(key)
        if directory and found is not None and not found.is_dir:
            raise enotdir(path) from exc
        raise lookup_error(kinds, path, key) from exc
    return file_stat(entry)
