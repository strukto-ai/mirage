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

from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import replace
from typing import cast

from mirage.accessor.base import Accessor, NOOPAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    dispatched_slots,
    read_ahead,
)
from mirage.commands.builtin.utils.links import mount_view
from mirage.commands.builtin.utils.paths import dispatch_stat
from mirage.commands.config import CommandIO, Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagBag, FlagView
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
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, PathSpec
from mirage.view.types import FollowOperands, MountView
from mirage.workspace.files import Files


def _mounted(accessor: Accessor) -> bool:
    return True


def dispatch_io(
    dispatch: DispatchFn,
    bound: MountView | None = None,
    paths: Sequence[PathSpec] = (),
) -> CommandIO:
    """Bind a generic's IO to workspace operations.

    The dispatcher's own answers are what a mount's table answers: a
    listing names the links in a directory and a stat of one is the
    link's own row.

    Args:
        dispatch (DispatchFn): policy-checked operation dispatcher.
        bound (MountView | None): set for a walk kept on one filesystem
            (``du -x``): a listing then leaves out the roots of the
            mounts below it, which the walk must neither list nor stat.
        paths (Sequence[PathSpec]): the command's operands, which its
            whole reads warm ahead of themselves (``read_ahead``).
    """
    ahead, noted = read_ahead(dispatch, paths)

    async def readdir(
        accessor: Accessor, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        data, _ = await dispatch("readdir", path)
        entries = cast(list[str], data)
        if bound is not None:
            owner = bound.root_of(path.virtual)
            entries = [
                e for e in entries if bound.root_of(e.rstrip("/")) == owner
            ]
        return entries

    async def stat(
        accessor: Accessor, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        data, _ = await dispatch("stat", path, nofollow=True)
        return cast(FileStat, data)

    async def read_bytes(
        accessor: Accessor, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> bytes:
        info, _ = await dispatch("stat", path)
        if cast(FileStat, info).type == FileType.DIRECTORY:
            raise eisdir(path)
        await ahead(path)
        data, _ = await dispatch("read", path)
        return await materialize(data) or b""

    def read_stream(
        accessor: Accessor, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> AsyncIterator[bytes]:
        return caller_stream(dispatch, current_caller(), path, ahead)

    return CommandIO(
        readdir=readdir,
        stat=stat,
        read_bytes=read_bytes,
        read_stream=read_stream,
        is_mounted=_mounted,
        glob_resolved=noted,
        # No cap of its own: a du walk charges each entry to the mount
        # serving it, at that mount's cap (see WalkBudget).
        max_du_entries=None,
        **dispatched_slots(
            dispatch, ("write", "pwrite", "unlink", "mkdir", "truncate")
        ),
    )


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
) -> tuple[ByteSource | None, IOResult]:
    """Run the same builder once across every operand's owning mount.

    The output is read before this returns, inside the running command: a
    ``fresh`` mount trusts only the listings that command made, so a lazy
    stream read after it ends would be served the previous command's. A
    builder that ``streams`` only reads, and each read opens as this
    command (``caller_stream``), so its output is handed on live.

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
    bounded = builder.name == "du" and FlagView(
        flag_kwargs, spec=SPECS["du"]
    ).as_bool("one_file_system")
    # The dispatcher keys every path by its whole virtual path, a path
    # option's value as well as an operand.
    rebased = FlagBag(flag_kwargs)
    for key, value in rebased.items():
        if isinstance(value, PathSpec):
            rebased[key] = replace(value, vfs_path=value.virtual.strip("/"))
        elif isinstance(value, list):
            rebased[key] = [
                replace(item, vfs_path=item.virtual.strip("/"))
                if isinstance(item, PathSpec)
                else item
                for item in value
            ]
    ctx = Context(
        flags=rebased,
        stdin=stdin,
        cwd=PathSpec(virtual=cwd, directory=cwd, vfs_path=cwd.strip("/")),
        vfs=vfs or Files([], dispatch, follow=follow, ledger=False),
        argv=argv,
    )
    io_ops = replace(
        dispatch_io(dispatch, mount_view(vfs) if bounded else None, paths),
        glob_follow=follow,
    )
    result = await builder.fn(
        io_ops,
        NOOPAccessor(),
        [replace(p, vfs_path=p.virtual.strip("/")) for p in paths],
        texts,
        ctx,
    )
    if result is None:
        return None, IOResult()
    stdout, io = result
    if builder.streams:
        return stdout, io
    return await materialize(stdout), io
