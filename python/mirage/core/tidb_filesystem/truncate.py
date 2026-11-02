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

from mirage.accessor.tidb_filesystem import TiDBFilesystemAccessor
from mirage.core.generic.rewrite import expect_offset
from mirage.core.tidb_filesystem.client import append_to, shrink_to
from mirage.core.tidb_filesystem.path import backend_path
from mirage.core.tidb_filesystem.read import read
from mirage.core.tidb_filesystem.stat import stat
from mirage.core.tidb_filesystem.write import write
from mirage.errors.fs import eisdir, enotsup
from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.spool import ByteSpool
from mirage.observe.context import record, start_op
from mirage.types import FileStat, FileType, PathSpec


async def _resized(head: bytes, added: ByteSpool) -> AsyncIterator[bytes]:
    yield head
    async for chunk in added.stream():
        yield chunk


async def _file_at(
    accessor: TiDBFilesystemAccessor, path: PathSpec
) -> FileStat | None:
    try:
        found = await stat(accessor, path)
    except FileNotFoundError:
        return None
    if found.type == FileType.DIRECTORY:
        raise eisdir(path)
    return found


async def truncate(
    accessor: TiDBFilesystemAccessor,
    path: PathSpec,
    length: int,
    no_create: bool = False,
) -> None:
    """Resize a file, cutting its end or padding it with zeros.

    A file drive9 keeps in object storage is cut by a patch upload, which
    moves only the part the cut falls in, and grown by a native append of
    the zeros. A file drive9 keeps inline sits in one TiDB row that any
    change rewrites whole, so it is read and written back, as is a
    missing file, which is made. drive9 has no create-only write, so
    ``no_create`` is refused before anything is sent.

    Args:
        accessor (TiDBFilesystemAccessor): the file system's accessor.
        path (PathSpec): the file.
        length (int): its new size.
        no_create (bool): refuse a missing file instead of making it.

    Raises:
        IsADirectoryError: the path is a directory.
    """
    if no_create:
        raise enotsup("tidb_filesystem", "truncate --no-create", path)
    length = expect_offset(length, path)
    timer = start_op()
    found = await _file_at(accessor, path)
    size = (found.size or 0) if found is not None else 0
    if found is not None and length == size:
        return
    remote = backend_path(accessor.config, path)
    async with ByteSpool() as added:
        for at in range(size, length, CHUNK_SIZE):
            await added.append(bytes(min(CHUNK_SIZE, length - at)))
        if found is not None and length:
            if length < size:
                done = await shrink_to(accessor, remote, length)
            else:
                done = await append_to(accessor, remote, added)
            if done:
                record("truncate", path.virtual, "tidb_filesystem", 0, timer)
                return
        kept = min(size, length)
        head = await read(accessor, path, 0, kept) if kept else b""
        await write(accessor, path, _resized(head, added))
    record("truncate", path.virtual, "tidb_filesystem", 0, timer)
