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
from dataclasses import replace
from typing import cast

from mirage.accessor.base import Accessor, NOOPAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic_bind.adapter import Builder, CommandIO
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.stream import ensure_stream, materialize
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import NamespaceView
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import eisdir


def _mounted(accessor: Accessor) -> bool:
    return True


def _none_below(path: str) -> list[str]:
    return []


def dispatch_io(
    dispatch: DispatchFn, reads: IOResult | None = None
) -> CommandIO:
    """Bind a generic's IO to workspace operations.

    Args:
        dispatch (DispatchFn): policy-checked operation dispatcher.
        reads (IOResult | None): Optional ledger for byte reads and cache entries.
    """

    async def readdir(
        accessor: Accessor, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        data, _ = await dispatch("readdir", path)
        return cast(list[str], data)

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
        data, _ = await dispatch("read", path)
        body = await materialize(data) or b""
        if reads is not None:
            reads.reads[path.virtual] = body
            if path.virtual not in reads.cache:
                reads.cache.append(path.virtual)
        return body

    async def read_stream(
        accessor: Accessor, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> AsyncIterator[bytes]:
        info, _ = await dispatch("stat", path)
        if cast(FileStat, info).type == FileType.DIRECTORY:
            raise eisdir(path)
        data, _ = await dispatch("read", path)
        async for chunk in ensure_stream(data):
            yield chunk

    async def write(
        accessor: Accessor,
        path: PathSpec,
        data: bytes,
        index: IndexCacheStore = NULL_INDEX,
    ) -> None:
        await dispatch("write", path, data=data)
        if reads is not None:
            reads.reads.pop(path.virtual, None)

    async def unlink(accessor: Accessor, path: PathSpec) -> None:
        await dispatch("unlink", path)
        if reads is not None:
            reads.reads.pop(path.virtual, None)

    async def mkdir(
        accessor: Accessor, path: PathSpec, parents: bool = False
    ) -> None:
        await dispatch("mkdir", path, parents=parents)

    async def truncate(
        accessor: Accessor, path: PathSpec, size: int, no_create: bool = False
    ) -> None:
        await dispatch("truncate", path, length=size, no_create=no_create)
        if reads is not None:
            reads.reads.pop(path.virtual, None)

    return CommandIO(
        readdir=readdir,
        stat=stat,
        read_bytes=read_bytes,
        read_stream=read_stream,
        is_mounted=_mounted,
        write=write,
        unlink=unlink,
        mkdir=mkdir,
        truncate=truncate,
    )


async def run_dispatch(
    builder: Builder,
    paths: list[PathSpec],
    texts: list[str],
    flag_kwargs: dict[str, FlagValue],
    dispatch: DispatchFn,
    cwd: str,
    ns: NamespaceView | None = None,
    stdin: ByteSource | None = None,
    argv: tuple[str, ...] = (),
) -> tuple[ByteSource | None, IOResult]:
    """Run the same builder once across every operand's owning mount.

    The output is read before this returns, inside the running command: a
    ``fresh`` mount trusts only the listings that command made, so a lazy
    stream read after it ends would be served the previous command's.

    Args:
        builder (Builder): the command's existing generic binding.
        paths (list[PathSpec]): operands in command-line order.
        texts (list[str]): text operands.
        flag_kwargs (dict[str, FlagValue]): the parsed flags.
        dispatch (DispatchFn): policy-checked operation dispatcher.
        cwd (str): the shell's working directory.
        ns (NamespaceView | None): name-plane facts. The dispatcher lists
            the mounts below a directory itself, so no descendant is left
            to avoid; where each mount begins stays for
            ``--one-file-system``.
        stdin (ByteSource | None): the command's input.
        argv (tuple[str, ...]): Original argument spellings for diagnostics.
    """
    bounded = builder.name == "du" and FlagView(
        flag_kwargs, spec=SPECS["du"]
    ).as_bool("one_file_system")
    if ns is not None and ns.mounts is not None and not bounded:
        mounts = replace(
            ns.mounts, descendants=_none_below, visible_descendants=_none_below
        )
        ns = replace(ns, mounts=mounts)
    opts = CommandOpts(
        flags=flag_kwargs,
        stdin=stdin,
        cwd=PathSpec(virtual=cwd, directory=cwd, vfs_path=cwd.strip("/")),
        ns=ns,
        dispatch=dispatch,
        argv=argv,
    )
    reads = IOResult()
    result = await builder.fn(
        dispatch_io(dispatch, reads),
        NOOPAccessor(),
        [replace(p, vfs_path=p.virtual.strip("/")) for p in paths],
        texts,
        opts,
    )
    if result is None:
        return None, IOResult()
    stdout, io = result
    body = await materialize(stdout)
    return body, await reads.merge(io)
