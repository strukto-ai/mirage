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

from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.cache.context import (
    read_versioned,
    write_condition,
)
from mirage.cache.types import OwnRead, ReplaceRequest, RewriteWriteFn
from mirage.errors.fs import eexist, einval, eisdir, enotsup
from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.spool import ByteSpool
from mirage.io.types import ByteSource
from mirage.types import FileStat, FileType, PathSpec, StatFn

ReadFn = Callable[[PathSpec], Awaitable[bytes]]
WriteFn = RewriteWriteFn


async def append_by_rewrite(
    read: ReadFn, write: WriteFn, stat: StatFn, path: PathSpec, data: bytes
) -> FileStat | None:
    """Append by reading the file and writing it back whole.

    Existing-file rewrites follow the mount's write policy. Missing-file
    creation requires atomic absence protection. A zero-byte append is an open
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
            return await write(
                ReplaceRequest(
                    path,
                    data,
                    await write_condition(path, "put", own=OwnRead.ABSENT),
                )
            )
        if found.type == FileType.DIRECTORY:
            raise eisdir(path.virtual)
        return None
    own: str | OwnRead | None
    try:
        existing, own = await read_versioned(path, lambda: read(path))
        own = own if own is not None else OwnRead.UNKNOWN
    except FileNotFoundError:
        return await write(
            ReplaceRequest(
                path,
                data,
                await write_condition(path, "put", own=OwnRead.ABSENT),
            )
        )
    return await write(
        ReplaceRequest(
            path, existing + data, await write_condition(path, "put", own=own)
        )
    )


async def append_by_streamed_rewrite(
    read: Callable[
        [PathSpec, Callable[[str | None], None]], AsyncIterator[bytes]
    ],
    write: RewriteWriteFn,
    stat: StatFn,
    path: PathSpec,
    data: ByteSource,
) -> FileStat | None:
    """Stage a read-modify-write with bounded RAM and the read's version.

    The new bytes are spooled before the file is read: a streamed write
    lets its path go while its source is pulled, so a write landing
    meanwhile is in the file the replacement is made from.

    Args:
        read (Callable): streaming reader.
        write (Callable): streaming replacement.
        stat (StatFn): point lookup for an empty append.
        path (PathSpec): the destination.
        data (ByteSource): additional bytes, consumed once.
    """
    async with ByteSpool() as incoming:
        await incoming.fill(data)
        if not incoming.size:
            try:
                found = await stat(path)
            except FileNotFoundError:
                return await write(
                    ReplaceRequest(
                        path,
                        b"",
                        await write_condition(path, "put", own=OwnRead.ABSENT),
                    )
                )
            if found.type == FileType.DIRECTORY:
                raise eisdir(path)
            return None
        async with ByteSpool() as spool:
            own: str | OwnRead = OwnRead.UNKNOWN

            def remember(version: str | None) -> None:
                nonlocal own
                own = version if version is not None else OwnRead.UNKNOWN

            try:
                await spool.fill(read(path, remember))
            except FileNotFoundError:
                if spool.size:
                    raise
                own = OwnRead.ABSENT
            return await write(
                ReplaceRequest(
                    path,
                    _spliced(spool, spool.size, incoming),
                    await write_condition(path, "put", own=own),
                )
            )


async def pwrite_by_streamed_rewrite(
    read: Callable[[PathSpec, ByteSpool], Awaitable[str | None]],
    write: RewriteWriteFn,
    stat: StatFn,
    path: PathSpec,
    data: ByteSource,
    offset: int,
) -> None:
    """Write at an offset by spooling the file and writing it back whole,
    its head, the new bytes and its tail streamed, so memory holds a
    chunk at a time whatever the sizes. The new bytes are spooled before
    the file is read: a streamed write lets its path go while its source
    is pulled, so a write landing meanwhile is in the file the
    replacement is made from.

    A zero-length pwrite(2) on an existing file changes nothing and must
    not read the file back: a concurrent writer's update between the
    stat and a write would be clobbered by the stale contents. On a
    missing file it creates an empty one. A key store answers a read of
    a directory's name as a missing key, so a read that misses is checked
    against stat before writing: writing there would put an object beside
    the directory.

    Args:
        read (Callable): fills a spool with the whole file and answers
            the version the read carried.
        write (Callable): streaming replacement.
        stat (StatFn): point lookup.
        path (PathSpec): the file.
        data (ByteSource): the bytes to write, consumed once.
        offset (int): where they start, already checked non-negative.
    """
    async with ByteSpool() as incoming:
        await incoming.fill(data)
        if not incoming.size:
            try:
                found = await stat(path)
            except FileNotFoundError:
                await write(
                    ReplaceRequest(
                        path,
                        b"",
                        await write_condition(path, "put", own=OwnRead.ABSENT),
                    )
                )
                return
            if found.type == FileType.DIRECTORY:
                raise eisdir(path.virtual)
            return
        async with ByteSpool() as spool:
            own: str | OwnRead | None
            try:
                version = await read(path, spool)
                own = version if version is not None else OwnRead.UNKNOWN
            except FileNotFoundError:
                if spool.size:
                    raise
                try:
                    missing: FileStat | None = await stat(path)
                except FileNotFoundError:
                    missing = None
                if missing is not None and missing.type == FileType.DIRECTORY:
                    raise eisdir(path.virtual)
                own = OwnRead.ABSENT
            await write(
                ReplaceRequest(
                    path,
                    _spliced(spool, offset, incoming),
                    await write_condition(path, "put", own=own),
                )
            )


async def _spliced(
    spool: ByteSpool, offset: int, incoming: ByteSpool
) -> AsyncIterator[bytes]:
    """The spooled file with new bytes laid over it from ``offset``: its
    head, zeros where it ends before ``offset``, the new bytes, then what
    it holds past them.

    Args:
        spool (ByteSpool): the stored file.
        offset (int): where the new bytes start.
        incoming (ByteSpool): the new bytes.
    """
    async for chunk in spool.stream(0, offset):
        yield chunk
    for at in range(spool.size, offset, CHUNK_SIZE):
        yield bytes(min(CHUNK_SIZE, offset - at))
    async for chunk in incoming.stream():
        yield chunk
    async for chunk in spool.stream(offset + incoming.size):
        yield chunk


async def truncate_by_rewrite(
    read: ReadFn,
    write: WriteFn,
    path: PathSpec,
    length: int,
    no_create: bool,
) -> None:
    """Resize by reading the file and writing it back padded or cut.

    For a store with no partial write. It cannot hold ``no_create``
    atomically, so it refuses that before writing anything, as it does a
    negative length (EINVAL). Emptying reads
    nothing, so its write carries the version the agent read.

    Args:
        read (ReadFn): whole-file reader.
        write (WriteFn): whole-file replacement.
        path (PathSpec): the file.
        length (int): its new size.
        no_create (bool): ``truncate --no-create``.
    """
    if no_create:
        raise enotsup("emulated", "truncate --no-create", path)
    length = expect_offset(length, path)
    if length == 0:
        await write(
            ReplaceRequest(path, b"", await write_condition(path, "put"))
        )
        return
    own: str | OwnRead | None
    try:
        data, own = await read_versioned(path, lambda: read(path))
        own = own if own is not None else OwnRead.UNKNOWN
    except FileNotFoundError:
        data, own = b"", OwnRead.ABSENT
    await write(
        ReplaceRequest(
            path,
            data[:length].ljust(length, b"\0"),
            await write_condition(path, "put", own=own),
        )
    )


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
