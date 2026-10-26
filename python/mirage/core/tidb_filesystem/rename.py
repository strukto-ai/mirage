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
from mirage.core.tidb_filesystem.client import move
from mirage.core.tidb_filesystem.dest import check_rename, kinds_of
from mirage.core.tidb_filesystem.errors import has_status
from mirage.core.tidb_filesystem.path import backend_path
from mirage.errors.fs import enoent, enotempty
from mirage.types import PathSpec
from mirage.utils.path import ancestors, norm


async def rename(
    accessor: TiDBFilesystemAccessor, src: PathSpec, dst: PathSpec
) -> None:
    """Move a file or a directory with drive9's own rename, once one
    fs:batch-stat has both ends resolved the way ``rename(2)`` needs.

    Args:
        accessor (TiDBFilesystemAccessor): the file system's accessor.
        src (PathSpec): the current name.
        dst (PathSpec): the new name.

    Raises:
        FileNotFoundError: the source, or a folder above the destination,
            is missing.
        NotADirectoryError: a directory onto a file, or a file above the
            destination.
        IsADirectoryError: a file onto a directory.
        OSError: ENOTEMPTY onto a directory that holds entries, EINVAL
            into the source's own subtree.
    """
    s, d = norm(src.mount_path), norm(dst.mount_path)
    kinds = await kinds_of(accessor, [*ancestors(d), d, *ancestors(s), s])
    check_rename(kinds, src, s, dst, d)
    if s == d:
        return
    try:
        await move(
            accessor,
            backend_path(accessor.config, src),
            backend_path(accessor.config, dst),
        )
    except Exception as exc:
        if has_status(exc, 409):
            raise enotempty(dst) from exc
        if has_status(exc, 404):
            raise enoent(src) from exc
        raise
