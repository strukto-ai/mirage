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

from mirage.context import DEFAULT_UMASK
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.stream import materialize
from mirage.runtime.types import DispatchFn
from mirage.shell.descriptors import FileDescription
from mirage.types import PathSpec
from mirage.utils.errors import FS_ERRORS
from mirage.utils.ranges import splice_window
from mirage.workspace.session import SessionState

logger = logging.getLogger(__name__)


async def create_file(
    dispatch: DispatchFn,
    session: SessionState,
    scope: PathSpec,
    data: bytes,
    *,
    append: bool = False,
) -> None:
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
        append (bool): append through the op door instead of replacing.
    """
    created = False
    if session.umask != DEFAULT_UMASK:
        try:
            await dispatch("stat", scope)
        except FS_ERRORS as exc:
            logger.debug("write target %s is new: %s", scope.raw_path, exc)
            created = True
    await dispatch("append" if append else "write", scope, data=data)
    if not created:
        return
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


async def write_description(
    dispatch: DispatchFn,
    session: SessionState,
    file: FileDescription,
    data: bytes,
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
        if data:
            await file.emit(data)
        return
    async with file.writing:
        await _write_through(dispatch, session, file, data)


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
    content, _ = await dispatch("read", file.scope)
    offset = file.offset + file.source.lines.position
    content = splice_window(await materialize(content) or b"", offset, data)
    await create_file(dispatch, session, file.scope, content)
    file.offset = offset + len(data)
    file.source.lines = AsyncLineIterator(content[file.offset :])
