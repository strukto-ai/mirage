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
import logging
from collections.abc import AsyncIterator
from contextlib import aclosing

from mirage.context import DEFAULT_UMASK
from mirage.errors.constants import FS_ERRORS
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.cooperative import chunks
from mirage.io.stream import slice_stream
from mirage.io.types import ByteSource, OpReport
from mirage.runtime.types import DispatchFn
from mirage.shell.descriptors import FileDescription
from mirage.types import FileStat, FileType, PathSpec
from mirage.workspace.session import SessionState

logger = logging.getLogger(__name__)


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
) -> None:
    """Write through a shared open file description, preserving its offset.

    A write-only description lands at its offset with one ``pwrite``, so
    it needs no read of the file, as a write to a write-only descriptor
    needs none (``exec 3>f; echo a >&3``). A read-write one (``<>``)
    still reads it: that description was opened to read, and its own
    reader resumes over what the write left. Writes through one
    description take turns, the first one (which opens the file)
    included, as the kernel orders writes to an open file: a background
    job writing alongside the shell neither reopens the file nor lands on
    an offset another write has not advanced yet. A writer killed while it
    waits for its turn writes nothing: its cancelled task leaves the
    queue.

    Args:
        dispatch (DispatchFn): operation dispatcher.
        session (SessionState): file creation mode.
        file (FileDescription): shared open description.
        data (bytes): bytes emitted by the command.
    """
    if file.emit is not None:
        async with aclosing(chunks(data)) as source:
            async for part in source:
                await file.emit(part)
        return
    async with file.writing:
        if (
            not isinstance(data, bytes)
            and file.source is None
            and (not file.opened or file.append)
        ):
            size = 0

            async def counted() -> AsyncIterator[bytes]:
                nonlocal size
                async with aclosing(chunks(data)) as source:
                    async for part in source:
                        size += len(part)
                        yield part

            await create_file(
                dispatch, session, file.scope, counted(), append=file.append
            )
            file.opened = True
            file.offset += size
            return
        async with aclosing(chunks(data)) as source:
            async for part in source:
                await _write_through(dispatch, session, file, part)


async def _write_through(
    dispatch: DispatchFn,
    session: SessionState,
    file: FileDescription,
    data: bytes,
) -> None:
    """One write through a description, once it is this write's turn.

    Args:
        dispatch (DispatchFn): operation dispatcher.
        session (SessionState): file creation mode.
        file (FileDescription): shared open description.
        data (bytes): bytes emitted by the command.
    """
    if not file.opened:
        await create_file(
            dispatch,
            session,
            file.scope,
            b"" if file.source else data,
            append=file.append,
        )
        file.opened = True
        if file.source is None:
            file.offset += len(data)
            return
    if not data:
        return
    if file.source is None:
        if file.append:
            await create_file(dispatch, session, file.scope, data, append=True)
        else:
            await dispatch("pwrite", file.scope, data=data, offset=file.offset)
            file.offset += len(data)
        return
    offset = file.offset + file.source.lines.position
    await dispatch("pwrite", file.scope, data=data, offset=offset)
    await file.source.lines.discard()
    file.offset = offset + len(data)
    content, _ = await dispatch("read", file.scope, stream=True)
    file.source.lines = AsyncLineIterator(slice_stream(content, file.offset))
