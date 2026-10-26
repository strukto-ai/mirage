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
from mirage.core.tidb_filesystem.client import make_directory
from mirage.core.tidb_filesystem.dest import check_mkdir_target, kinds_of
from mirage.core.tidb_filesystem.errors import has_status
from mirage.core.tidb_filesystem.path import backend_path
from mirage.errors.fs import eexist
from mirage.types import PathSpec
from mirage.utils.path import ancestors, norm


async def mkdir(
    accessor: TiDBFilesystemAccessor,
    path: PathSpec,
    parents: bool = False,
) -> None:
    """Make a directory; drive9 makes any missing parent with it, which
    plain ``mkdir`` refuses before it asks.

    Args:
        accessor (TiDBFilesystemAccessor): the file system's accessor.
        path (PathSpec): the directory.
        parents (bool): make missing parents too, as ``mkdir -p``.

    Raises:
        FileExistsError: something is at the path.
        FileNotFoundError: a parent is missing and ``parents`` is False.
        NotADirectoryError: a component above the path is a file.
    """
    key = norm(path.mount_path)
    kinds = await kinds_of(accessor, [*ancestors(key), key])
    if check_mkdir_target(kinds, path, key, parents):
        return
    try:
        await make_directory(accessor, backend_path(accessor.config, path))
    except Exception as exc:
        if has_status(exc, 409):
            raise eexist(path) from exc
        raise
