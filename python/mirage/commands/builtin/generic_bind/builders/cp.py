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
from functools import partial
from typing import Any

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.cp import cp_generic as generic_cp
from mirage.commands.builtin.generic.cp import parse_flags
from mirage.commands.builtin.generic.crossmount.utils import transfer_links_of
from mirage.commands.builtin.generic.find import parse_find_args
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import (
    CommandFiles,
    command_files,
)
from mirage.commands.builtin.utils.links import (
    dispatch_of,
    links_of,
    mount_root,
    mounts_of,
    serves,
    typed_link,
    visibility_of,
)
from mirage.commands.builtin.utils.tree import tree_walk
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.core.generic.find import walk_find
from mirage.errors.fs import enotsup
from mirage.io.types import ByteSource, IOResult
from mirage.types import (
    NativeCopy,
    PathSpec,
    PrimitiveCopy,
    ReaddirFn,
    StatFn,
)
from mirage.utils.key_prefix import rekey
from mirage.view.namespace_view import paths_scoped


async def _walk_find(
    readdir: ReaddirFn,
    stat: StatFn,
    src: PathSpec,
    type: str | None = None,
    unreadable: list[str] | None = None,
) -> list[str]:
    refused: list[str] | None = None if unreadable is None else []
    results = await walk_find(
        src,
        readdir=readdir,
        stat=stat,
        args=parse_find_args((), type=type),
        unreadable=refused,
    )
    if unreadable is not None and refused is not None:
        unreadable.extend(
            "/" + rekey(src.virtual, src.vfs_path, path) for path in refused
        )
    return ["/" + rekey(src.virtual, src.vfs_path, path) for path in results]


def _make_find(files: CommandFiles) -> Callable[..., Awaitable[list[str]]]:
    """The tree to copy, walked from the mount's ``read_tree`` where it
    answers, so stat classifies entries from the listing instead of
    re-fetching, matching find.

    Args:
        files (CommandFiles): the command's files.
    """
    readdir, stat = tree_walk(
        files.read_tree if files.answers("read_tree") else None,
        files.readdir,
        files.stat,
    )
    return partial(_walk_find, readdir, stat)


async def _write(
    write: Callable[..., Awaitable[Any]], path: PathSpec, data: bytes = b""
) -> None:
    await write(path, data)


async def cp(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    parsed = parse_flags(FlagView(ctx.flags, spec=SPECS["cp"]))
    # A native copy or find answers for a whole tree in one call, so the
    # dispatcher declines one whose tree the caller's view restricts; cp
    # takes the entry-by-entry walk up front there, which is where GNU's
    # per-entry refusals are worded.
    native = not paths_scoped(paths, mount_root(ctx))
    copy = files.copy if native and files.answers("copy") else None
    write = files.write if files.answers("write") else None

    async def refused_mkdir(path: PathSpec, parents: bool = False) -> None:
        # A directory creation cp may not use here, refused once the
        # dispatcher has judged the path as the create it would be: a
        # read-only mount, a hide or a policy answers first.
        if ctx.vfs is not None:
            await ctx.vfs.dispatch("write", path, admit_only=True)
        raise enotsup("backend", "mkdir", path)

    # Without a file transfer capability, creating directories would
    # leave an uncopyable destination tree. Keep the refusal guarded.
    mkdir = (
        refused_mkdir
        if copy is None and write is None
        else files.mkdir
        if files.answers("mkdir")
        else None
    )
    resolved = await files.resolve_glob(paths)
    strategy: NativeCopy | PrimitiveCopy
    if copy is None and write is not None:
        # A native copy moves a tree in one backend call and read_tree
        # lists it, neither of which passes an entry through the guard
        # the way a read does; while a path rule scopes cp, or a hide
        # could cover an entry under an operand (a one-call listing
        # names hidden entries and the per-file read then prints them
        # in its refusal), the primitive walk copies entry by entry
        # (the cross-mount relay's own path), which is also where GNU's
        # per-entry refusals are worded.
        strategy = PrimitiveCopy(
            read_bytes=files.read_bytes,
            read_stream=files.read_stream,
            write=partial(_write, write),
            mkdir=files.mkdir,
            readdir=files.readdir,
        )
    else:
        strategy = NativeCopy(
            copy=files.copy,
            find=_make_find(files),
            dir_copy=(
                files.dir_copy
                if native and files.answers("dir_copy")
                else None
            ),
            mkdir=mkdir,
        )
    links = links_of(ctx)
    cwd = ctx.cwd.virtual
    return await generic_cp(
        resolved,
        strategy=strategy,
        stat=files.stat,
        flags=parsed,
        readdir=files.readdir,
        link_at=(
            partial(typed_link, links, cwd=cwd) if links is not None else None
        ),
        copies=(
            transfer_links_of(
                links,
                ctx.vfs.dispatch,
                cwd,
                visibility_of(ctx.vfs),
                partial(serves, mounts_of(ctx), mount_root(ctx)),
            )
            if links is not None and ctx.vfs is not None
            else None
        ),
        stdin=ctx.stdin,
        dispatch=dispatch_of(ctx),
    )


BUILDER = GenericCommand("cp", cp, write=True)
