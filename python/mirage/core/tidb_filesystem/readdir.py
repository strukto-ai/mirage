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

from mirage.accessor.tidb_filesystem import TiDBFilesystemAccessor
from mirage.core.tidb_filesystem.client import list_entries
from mirage.core.tidb_filesystem.dest import (
    folder_of,
    kinds_of,
    lookup_error,
)
from mirage.core.tidb_filesystem.path import backend_path
from mirage.core.tidb_filesystem.stat import file_stat
from mirage.errors.fs import enotdir
from mirage.types import FileStat, PathSpec
from mirage.utils.path import ancestors, norm


async def readdir(
    accessor: TiDBFilesystemAccessor, path: PathSpec
) -> list[FileStat]:
    """A folder's rows from one listing, sorted by name.

    drive9 lists a missing folder as an empty one, so only an empty
    listing asks what the path is. A name that is both a file and a
    directory lists once, as the directory, as it does on an object store.

    Args:
        accessor (TiDBFilesystemAccessor): the file system's accessor.
        path (PathSpec): the folder, or a glob word in it.

    Raises:
        FileNotFoundError: nothing is at the path.
        NotADirectoryError: the path, or a folder above it, is a file.
    """
    list_path = path.dir if path.pattern else path
    key = norm(list_path.mount_path)
    entries = await list_entries(
        accessor, backend_path(accessor.config, list_path)
    )
    if not entries:
        kinds = await kinds_of(accessor, [*ancestors(key), key])
        found = folder_of(kinds, key)
        if found is None:
            raise lookup_error(kinds, list_path, key)
        if not found.is_dir:
            raise enotdir(list_path)
        return []
    rows = {
        entry.name: file_stat(entry)
        for entry in sorted(entries, key=lambda entry: entry.is_dir)
    }
    return [rows[name] for name in sorted(rows)]
