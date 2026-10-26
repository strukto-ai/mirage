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
from mirage.core.tidb_filesystem.client import download
from mirage.core.tidb_filesystem.dest import kinds_of, lookup_error
from mirage.core.tidb_filesystem.errors import has_status
from mirage.core.tidb_filesystem.path import backend_path
from mirage.errors.fs import eisdir, fs_error
from mirage.errors.types import FsCondition
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.path import ancestors, norm
from mirage.utils.ranges import window_for


async def read_error(
    accessor: TiDBFilesystemAccessor, path: PathSpec, exc: Exception
) -> OSError | None:
    """The errno a failed download answers with, None for any other
    failure.

    drive9 answers 404 for a directory as for a missing path, and 422 for
    a file in the extent layout, whose blocks only its FUSE client reads.

    Args:
        accessor (TiDBFilesystemAccessor): the file system's accessor.
        path (PathSpec): the file that was read.
        exc (Exception): the download's failure.
    """
    if has_status(exc, 422):
        return fs_error(path, FsCondition.ENOTSUP)
    if not has_status(exc, 404):
        return None
    key = norm(path.mount_path)
    kinds = await kinds_of(accessor, [*ancestors(key), key])
    found = kinds.get(key)
    if found is not None and found.is_dir:
        return eisdir(path)
    return lookup_error(kinds, path, key)


async def read(
    accessor: TiDBFilesystemAccessor,
    path: PathSpec,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    virtual = path.virtual
    remote_path = backend_path(accessor.config, path)
    timer = start_op()
    if size == 0:
        record("read", virtual, "tidb_filesystem", 0, timer)
        return b""
    try:
        data = await download(
            accessor, remote_path, window=window_for(offset, size)
        )
    except Exception as exc:
        error = await read_error(accessor, path, exc)
        if error is None:
            raise
        raise error from exc
    record("read", virtual, "tidb_filesystem", len(data), timer)
    return data
