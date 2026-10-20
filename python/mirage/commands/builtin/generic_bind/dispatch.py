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
from dataclasses import replace

from mirage.accessor.base import NOOPAccessor
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.utils.paths import (
    dispatch_stat,
    virtual_flags,
    virtual_key,
)
from mirage.commands.config import Context
from mirage.commands.spec.types import FlagValue
from mirage.context.session_context import (
    Caller,
    bind_caller,
    current_caller,
    reset_caller,
)
from mirage.errors.fs import eisdir
from mirage.io.stream import close_quietly, ensure_stream, materialize
from mirage.io.types import ByteSource, IOResult
from mirage.rs.diff_types import DiffComputer
from mirage.runtime.types import DispatchFn
from mirage.types import FileType, PathSpec
from mirage.view.types import FollowOperands
from mirage.workspace.files import Files


async def caller_stream(
    dispatch: DispatchFn,
    caller: Caller,
    path: PathSpec,
    ahead: Callable[[PathSpec], Awaitable[None]] | None = None,
) -> AsyncIterator[bytes]:
    """A streamed read that opens as the command that asked for it.

    It opens at the first pull, which can come after that command ended,
    so it opens under the command's caller: a ``fresh`` mount trusts only
    the listings that command made. A directory fails with EISDIR, as a
    POSIX read does, before a keyed store reads it as nothing.

    Args:
        dispatch (DispatchFn): policy-checked operation dispatcher.
        caller (Caller): the asking command's caller.
        path (PathSpec): the file.
        ahead (Callable[[PathSpec], Awaitable[None]] | None): what the
            read awaits first (``read_ahead``).
    """
    token = bind_caller(caller)
    try:
        if (await dispatch_stat(dispatch, path)).type == FileType.DIRECTORY:
            raise eisdir(path)
        if ahead is not None:
            await ahead(path)
        data, _ = await dispatch("read", path, stream=True)
    finally:
        reset_caller(token)
    source = ensure_stream(data)
    try:
        async for chunk in source:
            yield chunk
    finally:
        await close_quietly(source)


async def run_dispatch(
    builder: GenericCommand,
    paths: list[PathSpec],
    texts: list[str],
    flag_kwargs: dict[str, FlagValue],
    dispatch: DispatchFn,
    cwd: str,
    vfs: Files | None = None,
    stdin: ByteSource | None = None,
    argv: tuple[str, ...] = (),
    follow: FollowOperands | None = None,
    diff: DiffComputer | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run the same builder once across every operand's owning mount.

    The builder runs as a run across mounts: no mount's command scope is
    bound around it (``crosses_mounts``), so every call it makes through
    its files reaches whichever mount serves the path. The output is read
    before this returns, inside the running command: a ``fresh`` mount
    trusts only the listings that command made, so a lazy stream read
    after it ends would be served the previous command's. A builder that
    ``streams`` only reads, and each read opens as this command
    (``caller_stream``), so its output is handed on live.

    Args:
        builder (GenericCommand): the command's existing generic binding.
        paths (list[PathSpec]): operands in command-line order.
        texts (list[str]): text operands.
        flag_kwargs (dict[str, FlagValue]): the parsed flags.
        dispatch (DispatchFn): policy-checked operation dispatcher.
        cwd (str): the shell's working directory.
        vfs (Files | None): name-plane facts. The dispatcher lists
            the mounts below a directory itself, so no descendant is left
            to avoid; where each mount begins stays for
            ``--one-file-system``, and each mount's du budget for a walk.
        stdin (ByteSource | None): the command's input.
        argv (tuple[str, ...]): Original argument spellings for diagnostics.
        follow (FollowOperands | None): the line's operand resolution,
            which its globs' matches take too.
    """
    ctx = Context(
        flags=virtual_flags(flag_kwargs),
        stdin=stdin,
        cwd=PathSpec(virtual=cwd, directory=cwd, vfs_path=cwd.strip("/")),
        vfs=vfs or Files(dispatch, follow=follow, ledger=False),
        argv=argv,
        diff=diff,
    )
    # No mount is bound to the run, a line that spans mounts walking
    # through the dispatcher, even inside a command a mount runs (a
    # nested line): the builder's files and ``mounts_of`` read this to
    # know the walk crosses.
    token = bind_caller(replace(current_caller(), mount=None))
    try:
        result = await builder.fn(
            NOOPAccessor(),
            [virtual_key(p) for p in paths],
            texts,
            ctx,
        )
    finally:
        reset_caller(token)
    if result is None:
        return None, IOResult()
    stdout, io = result
    if builder.streams:
        return stdout, io
    return await materialize(stdout), io
