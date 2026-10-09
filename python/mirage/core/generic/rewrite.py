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

from collections.abc import Awaitable, Callable

from mirage.cache.context import (
    own_write_version,
    read_versioned,
)
from mirage.cache.types import OwnRead
from mirage.errors.fs import eexist, einval, eisdir, enotsup
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.ranges import splice_window

ReadFn = Callable[[PathSpec], Awaitable[bytes]]
WriteFn = Callable[[PathSpec, bytes], Awaitable[None]]
StatFn = Callable[[PathSpec], Awaitable[FileStat]]


async def append_by_rewrite(
    read: ReadFn, write: WriteFn, stat: StatFn, path: PathSpec, data: bytes
) -> None:
    """Append by reading the file and writing it back whole.

    Not atomic against a concurrent writer. A zero-byte append is an open
    for appending with nothing written after it (``cmd >> f`` opens ``f``
    before ``cmd`` runs): it creates a missing file and leaves an existing
    one alone, so it costs a stat rather than moving the whole object
    twice to add nothing, and cannot put back bytes a concurrent writer
    had just replaced.

    Args:
        read (ReadFn): whole-file reader; only ENOENT means empty.
        write (WriteFn): whole-file replacement.
        stat (StatFn): point lookup, for a zero-byte append.
        path (PathSpec): the file.
        data (bytes): the bytes to add.
    """
    if not data:
        try:
            found = await stat(path)
        except FileNotFoundError:
            with own_write_version(path, OwnRead.ABSENT):
                await write(path, data)
            return
        if found.type == FileType.DIRECTORY:
            raise eisdir(path.virtual)
        return
    try:
        existing, own = await read_versioned(path, lambda: read(path))
    except FileNotFoundError:
        with own_write_version(path, OwnRead.ABSENT):
            await write(path, data)
        return
    with own_write_version(path, own):
        await write(path, existing + data)


async def pwrite_by_rewrite(
    read: ReadFn,
    write: WriteFn,
    stat: StatFn,
    path: PathSpec,
    data: bytes,
    offset: int,
) -> None:
    """Write at an offset by reading the file and writing it back whole.

    A zero-length pwrite(2) on an existing file changes nothing and must
    not read the file back: a concurrent writer's update between the
    stat and a write would be clobbered by the stale contents. On a
    missing file it creates an empty one. A key store answers a read of
    a directory's name as a missing key, so a read that misses is checked
    against stat before writing: writing there would put an object beside
    the directory.

    Args:
        read (ReadFn): whole-file reader.
        write (WriteFn): whole-file replacement.
        stat (StatFn): point lookup.
        path (PathSpec): the file.
        data (bytes): the bytes to write.
        offset (int): where they start, already checked non-negative.
    """
    if not data:
        try:
            found = await stat(path)
        except FileNotFoundError:
            with own_write_version(path, OwnRead.ABSENT):
                await write(path, data)
            return
        if found.type == FileType.DIRECTORY:
            raise eisdir(path.virtual)
        return
    own: str | OwnRead | None = None
    try:
        existing, own = await read_versioned(path, lambda: read(path))
    except FileNotFoundError:
        try:
            missing: FileStat | None = await stat(path)
        except FileNotFoundError:
            missing = None
        if missing is not None and missing.type == FileType.DIRECTORY:
            raise eisdir(path.virtual)
        existing, own = b"", OwnRead.ABSENT
    with own_write_version(path, own):
        await write(path, splice_window(existing, offset, data))


async def truncate_by_rewrite(
    read: ReadFn,
    write: WriteFn,
    path: PathSpec,
    length: int,
    no_create: bool,
) -> None:
    """Resize by reading the file and writing it back padded or cut.

    For a store with no partial write. It cannot hold ``no_create``
    atomically, so it refuses that before writing anything.

    Args:
        read (ReadFn): whole-file reader.
        write (WriteFn): whole-file replacement.
        path (PathSpec): the file.
        length (int): its new size.
        no_create (bool): ``truncate --no-create``.
    """
    if no_create:
        raise enotsup("emulated", "truncate --no-create", path)
    try:
        data = await read(path)
    except FileNotFoundError:
        data = b""
    await write(path, data[:length].ljust(length, b"\0"))


def expect_offset(offset: int, path: PathSpec) -> int:
    """A pwrite offset, refused with EINVAL when negative.

    Args:
        offset (int): the requested offset.
        path (PathSpec): the file, for the error.
    """
    if offset < 0:
        raise einval(path)
    return offset


async def refuse_taken(stat: StatFn, path: PathSpec, parents: bool) -> None:
    """Refuse a mkdir of a name that is taken, as mkdir(2) does.

    mkdir(2) refuses a name that exists, file or directory, and ``mkdir
    -p`` passes only a directory. Not every backend's create says so (a
    Graph 409 on a folder, Nextcloud's MKCOL 405, SFTP under ``-p``), so
    both callers look the name up before the create. A directory under
    ``-p`` still reaches the create, which keeps it durable (an object
    store writes the marker of a directory only a key implied), and a
    name that cannot be looked up is left to it too, to answer ENOENT or
    ENOTDIR. Mirrors TS ``refuseTaken``.

    Args:
        stat (StatFn): the backend's stat.
        path (PathSpec): the directory to make.
        parents (bool): ``-p``.

    Raises:
        FileExistsError: the name is taken and ``-p`` does not pass it.
    """
    try:
        row = await stat(path)
    except (FileNotFoundError, NotADirectoryError):
        return
    if parents and row.type == FileType.DIRECTORY:
        return
    raise eexist(path)
