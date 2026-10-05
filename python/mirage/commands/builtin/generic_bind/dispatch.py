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
from mirage.commands.spec import SPECS, flag_kwarg_name
from mirage.commands.spec.flag_view import FlagBag, FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.stream import ensure_stream, materialize
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import LinkView, MountView, NamespaceView
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import eisdir


def _mounted(accessor: Accessor) -> bool:
    return True


def _none_below(path: str) -> list[str]:
    return []


def dispatch_io(
    dispatch: DispatchFn,
    reads: IOResult | None = None,
    links: LinkView | None = None,
    bound: MountView | None = None,
) -> CommandIO:
    """Bind a generic's IO to workspace operations.

    A listing here answers the way a backend's does, which is what every
    generic is written against: no backend stores a link, and the
    generics merge the namespace's own from ``ns.links``, so the door's
    copy would be a second row (find) or a followed stat (ls).

    Args:
        dispatch (DispatchFn): policy-checked operation dispatcher.
        reads (IOResult | None): Optional ledger for byte reads and cache entries.
        links (LinkView | None): the namespace's symlinks, left out of
            every listing.
        bound (MountView | None): set for a walk kept on one filesystem
            (``du -x``): a listing then leaves out the roots of the
            mounts below it, which the walk must neither list nor stat.
    """

    async def readdir(
        accessor: Accessor, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        data, _ = await dispatch("readdir", path)
        entries = cast(list[str], data)
        if links is not None:
            entries = [
                e for e in entries if links.stat_at(e.rstrip("/")) is None
            ]
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
        # No cap of its own: a du walk charges each entry to the mount
        # serving it, at that mount's cap (see WalkBudget).
        max_du_entries=None,
        write=write,
        unlink=unlink,
        mkdir=mkdir,
        truncate=truncate,
    )


def path_flags(name: str, flags: dict[str, FlagValue]) -> dict[str, FlagValue]:
    """The flags with each path option's value as a PathSpec.

    A line parsed for a cross-mount strategy keeps a path option's
    resolved string; the generic reads the option as a single-mount
    line hands it over, a PathSpec, which the dispatcher serves from
    its own mount (``shuf -o``, ``iconv -o``, ``patch -i``).

    Args:
        name (str): the command whose spec types the options.
        flags (dict[str, FlagValue]): the parsed flags and their tape.
    """
    spec = SPECS.get(name)
    if spec is None:
        return flags
    keys = {
        flag_kwarg_name(word)
        for opt in spec.options
        if opt.type == "path" and not opt.pair
        for word in (opt.short, opt.long)
        if word
    }
    bag = FlagBag(flags)
    for key in keys & bag.keys():
        value = bag[key]
        if isinstance(value, str):
            bag[key] = replace(PathSpec.from_str_path(value), raw_path=value)
        elif isinstance(value, list):
            bag[key] = [
                replace(PathSpec.from_str_path(item), raw_path=item)
                if isinstance(item, str)
                else item
                for item in value
            ]
    return bag


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
            ``--one-file-system``, and each mount's du budget for a walk.
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
        flags=path_flags(builder.name, flag_kwargs),
        stdin=stdin,
        cwd=PathSpec(virtual=cwd, directory=cwd, vfs_path=cwd.strip("/")),
        ns=ns,
        dispatch=dispatch,
        argv=argv,
    )
    reads = IOResult()
    io_ops = dispatch_io(
        dispatch,
        reads,
        ns.links if ns is not None else None,
        ns.mounts if ns is not None and bounded else None,
    )
    result = await builder.fn(
        io_ops,
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
