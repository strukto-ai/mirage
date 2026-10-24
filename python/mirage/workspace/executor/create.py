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
import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import aclosing

from mirage.context import DEFAULT_UMASK
from mirage.errors.constants import FS_ERRORS
from mirage.io.cooperative import chunks
from mirage.io.spool import MEMORY_LIMIT
from mirage.io.stream import rechunk, slice_stream
from mirage.io.types import ByteSource, OpReport
from mirage.runtime.types import DispatchFn
from mirage.shell.descriptors import FileDescription
from mirage.types import FileStat, FileType, PathSpec
from mirage.workspace.session import SessionState

logger = logging.getLogger(__name__)

_streaming: dict[tuple[int, str], object] = {}


async def create_file(
    dispatch: DispatchFn,
    session: SessionState,
    scope: PathSpec,
    data: ByteSource,
    *,
    append: bool = False,
) -> PathSpec | None:
    """Write or append, giving a newly created file the umask's mode.

    Every shell path that opens a file for writing goes through here, so
    `echo x > f` and `exec > f` agree about the mode a fresh file gets:
    0666 masked by the session's umask, which is what `open(2)` with
    `O_CREAT` does. Living in one place is the point; the two callers
    had drifted while it was private to one of them.

    The existence probe runs only under a non-default umask, because
    that is the one case the answer changes anything: a fresh file
    already renders as 644, which is 0666 under bash's default mask. A
    mode that cannot be written is logged and not fatal, since the bytes
    are already there and the write is what the caller asked for.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (SessionState): the session holding the umask.
        scope (PathSpec): the target.
        data (bytes): the bytes to write.
        append (bool): append through the dispatcher instead of replacing.

    Returns:
        PathSpec | None: the live pipe the open reached, directly or
        through a link, which a descriptor goes on writing to whatever
        becomes of the name it was opened by; None for anything else.
    """
    created = False
    if session.umask != DEFAULT_UMASK:
        try:
            await dispatch("stat", scope)
        except FS_ERRORS as exc:
            logger.debug("write target %s is new: %s", scope.raw_path, exc)
            created = True
    report = OpReport()
    await dispatch(
        "append" if append else "write", scope, data=data, report=report
    )
    pipe = await _reached_pipe(dispatch, report.path)
    if not created or pipe is not None:
        return pipe
    try:
        await dispatch(
            "setattr",
            scope,
            mode=0o666 & ~session.umask,
            uid=None,
            gid=None,
            atime=None,
            mtime=None,
        )
    except FS_ERRORS as exc:
        logger.debug("umask mode write failed for %s: %s", scope.raw_path, exc)
    return None


async def _reached_pipe(
    dispatch: DispatchFn, path: str | None
) -> PathSpec | None:
    """The live pipe a write ran on, None when it ran on anything else.

    Args:
        dispatch (DispatchFn): op dispatcher.
        path (str | None): where the write ran once links were followed.
    """
    if path is None or not path.startswith("/dev/fd/"):
        return None
    scope = PathSpec.from_str_path(path)
    try:
        stat, _ = await dispatch("stat", scope)
    except FS_ERRORS as exc:
        logger.debug("written descriptor %s is gone: %s", path, exc)
        return None
    return (
        scope
        if isinstance(stat, FileStat) and stat.type == FileType.FIFO
        else None
    )


async def write_description(
    dispatch: DispatchFn,
    session: SessionState,
    file: FileDescription,
    data: ByteSource,
    *,
    replace: bool = False,
) -> None:
    """Write through a shared open file description, preserving its offset.

    A write-only description lands at its offset with ``pwrite``, so it
    needs no read of the file, as a write to a write-only descriptor
    needs none (``exec 3>f; echo a >&3``). Its first write into a file
    still empty lands as one stream instead (``_first_write``). A
    read-write one (``<>``) still reads it: that
    description was opened to read, and its own reader resumes over what
    the write left. Writes through one description take turns, the first
    one (which opens the file) included, as the kernel orders writes to
    an open file: a background job writing alongside the shell neither
    reopens the file nor lands on an offset another write has not
    advanced yet. A writer killed while it waits for its turn writes
    nothing: its cancelled task leaves the queue.

    Args:
        dispatch (DispatchFn): operation dispatcher.
        session (SessionState): file creation mode.
        file (FileDescription): shared open description.
        data (ByteSource): bytes emitted by the command.
        replace (bool): the write is the file's whole content from its
            start, so it lands as one replacement.
    """
    if file.emit is not None:
        async with aclosing(chunks(data)) as source:
            async for part in source:
                await file.emit(part)
        return
    async with file.writing:
        if file.source is None and (
            not file.opened or file.append or (replace and not file.offset)
        ):
            file.offset += await create_counted(
                dispatch, session, file.scope, data, append=file.append
            )
            file.opened = True
            return
        if (
            file.source is None
            and not file.offset
            and await _first_write(dispatch, session, file, data)
        ):
            return
        if not file.opened:
            await create_file(
                dispatch, session, file.scope, b"", append=file.append
            )
            file.opened = True
        start = offset = file.offset + (
            file.source.lines.position if file.source is not None else 0
        )
        try:
            async with aclosing(rechunk(data, MEMORY_LIMIT)) as source:
                async for part in source:
                    await dispatch(
                        "pwrite", file.scope, data=part, offset=offset
                    )
                    offset += len(part)
        finally:
            if offset != start:
                file.offset = offset
                if file.source is not None:
                    content, _ = await dispatch(
                        "read", file.scope, stream=True
                    )
                    file.source.lines = await file.source.lines.reopen(
                        slice_stream(content, offset)
                    )


async def _first_write(
    dispatch: DispatchFn,
    session: SessionState,
    file: FileDescription,
    data: ByteSource,
) -> bool:
    """Land an opened description's first write into a file still empty
    as one stream, and answer whether it did.

    The same bytes from offset 0 in ``pwrite`` windows cost a copy of the
    file each on a store whose ``pwrite`` rewrites it, so ``cmd > f``
    would move the file's size squared. The path is claimed before the
    stat and kept until the stream ends, so another description of the
    file writing meanwhile takes the windows, which interleave as two
    descriptors do, instead of replacing what this one wrote. A stream
    that fails leaves the offset at what landed.

    Args:
        dispatch (DispatchFn): operation dispatcher.
        session (SessionState): file creation mode.
        file (FileDescription): the description, at offset 0.
        data (ByteSource): bytes emitted by the command, untouched when
            this answers False.
    """
    key = (id(asyncio.get_running_loop()), file.scope.virtual)
    claim = object()
    if _streaming.setdefault(key, claim) is not claim:
        return False
    try:
        if await _size(dispatch, file.scope) != 0:
            return False
        try:
            file.offset = await create_counted(
                dispatch, session, file.scope, data
            )
        except BaseException:
            file.offset = await _size(dispatch, file.scope) or 0
            raise
        return True
    finally:
        del _streaming[key]


async def _size(dispatch: DispatchFn, scope: PathSpec) -> int | None:
    """The size of the file a description opened, None when unknown.

    Args:
        dispatch (DispatchFn): operation dispatcher.
        scope (PathSpec): the file.
    """
    try:
        stat, _ = await dispatch("stat", scope)
    except FS_ERRORS as exc:
        logger.debug("write target %s has no stat: %s", scope.raw_path, exc)
        return None
    return stat.size if isinstance(stat, FileStat) else None


async def create_counted(
    dispatch: DispatchFn,
    session: SessionState,
    scope: PathSpec,
    data: ByteSource,
    *,
    append: bool = False,
) -> int:
    """``create_file`` that answers how many bytes it wrote.

    Args:
        dispatch (DispatchFn): operation dispatcher.
        session (SessionState): file creation mode.
        scope (PathSpec): the file.
        data (ByteSource): its new content, or what to add.
        append (bool): add rather than replace.
    """
    if isinstance(data, bytes):
        await create_file(dispatch, session, scope, data, append=append)
        return len(data)
    size = 0

    async def counted() -> AsyncIterator[bytes]:
        nonlocal size
        async with aclosing(chunks(data)) as source:
            async for part in source:
                size += len(part)
                yield part

    await create_file(dispatch, session, scope, counted(), append=append)
    return size
