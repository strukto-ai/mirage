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

import functools
from collections.abc import Callable
from typing import Any

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.cp import walk
from mirage.commands.builtin.generic.rm_cmd import (
    remove_tree,
    rm_without_operands,
)
from mirage.commands.builtin.generic_bind.adapter import (
    Operation,
    over_mount_io,
    require_op,
)
from mirage.commands.builtin.utils.operands import mount_points
from mirage.commands.builtin.utils.output import format_optional_records
from mirage.commands.builtin.utils.slash_links import (
    is_slashed_link,
    rm_link_refusal,
)
from mirage.commands.builtin.utils.verbose import removal_lines
from mirage.commands.config import CommandIO, CommandOpts, command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror, inner_suffix, with_inner
from mirage.errors.render import operand_spelling
from mirage.errors.types import WalkDeclinedError
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec
from mirage.view.types import NamespaceView


def _build(io: CommandIO) -> Callable[..., Any]:
    """The rm handler over one mount's table.

    Args:
        io (CommandIO): the guarded table of the running mount.
    """
    stat = io.stat
    readdir = io.readdir
    resolve_glob = io.resolve_glob
    unlink = require_op(io, Operation.UNLINK)
    rmdir = require_op(io, Operation.RMDIR)
    rm_r = io.rm_r
    if rm_r is None:
        raise NotImplementedError(
            "operation 'rm_r' is not supported on this backend"
        )

    async def _rm(
        accessor: Accessor,
        path: PathSpec,
        recursive: bool = False,
        force: bool = False,
        remove_dir: bool = False,
        verbose: bool = False,
        *,
        index: IndexCacheStore,
        ns: NamespaceView | None,
    ) -> tuple[list[str], list[str]]:
        """Remove one operand, returning GNU stderr lines on failure.

        Args:
            accessor (Accessor): Backend handle.
            path (PathSpec): The operand to remove.
            recursive (bool): ``-r``; remove directories and their
                contents.
            force (bool): ``-f``; a missing operand is not an error.
            remove_dir (bool): ``-d``; remove empty directories.
            verbose (bool): ``-v``; collect one ``removed ...`` line per
                entry.
            index (IndexCacheStore): Cache index threaded into the core
                ops.
            ns (NamespaceView | None): the namespace's links, mounts and
                visibility, for a tree removed entry by entry.

        Returns:
            tuple[list[str], list[str]]: The ``rm: cannot remove ...``
            lines (none when removed or skipped under ``-f``) and the
            verbose lines.
        """
        label = path.raw_path
        try:
            s = await stat(accessor, path, index=index)
        except FS_ERRORS as exc:
            if force and isinstance(
                exc, (FileNotFoundError, NotADirectoryError)
            ):
                return [], []
            return [f"rm: cannot remove '{label}': {fs_strerror(exc)}"], []
        except ValueError:
            if force:
                return [], []
            return [
                f"rm: cannot remove '{label}': No such file or directory"
            ], []
        try:
            if s.type == FileType.DIRECTORY:
                if recursive:
                    listing = functools.partial(readdir, accessor, index=index)
                    probe = functools.partial(stat, accessor, index=index)
                    # -v names each entry before the tree goes in one
                    # call; a tree it cannot list whole goes entry by
                    # entry, as does one the dispatcher declines for
                    # the caller's view.
                    unlisted: list[str] = []
                    listed = (
                        await walk(listing, probe, path, "rm", unlisted)
                        if verbose
                        else []
                    )
                    declined = bool(unlisted)
                    if not declined:
                        try:
                            await rm_r(accessor, path)
                        except WalkDeclinedError:
                            declined = True
                    # A removal never crosses into a mount below, so it
                    # says so as GNU's --one-file-system does.
                    skipped = [
                        f"rm: skipping '{operand_spelling(root, path)}', "
                        "since it's on a different device"
                        for root in mount_points(
                            ns.mounts if ns is not None else None,
                            path.virtual,
                        )
                    ]
                    if not declined:
                        return skipped, removal_lines(listed, path)
                    gone, failures = await remove_tree(
                        path,
                        readdir=listing,
                        stat=probe,
                        unlink=functools.partial(unlink, accessor),
                        rmdir=functools.partial(rmdir, accessor),
                        ns=ns,
                        force=force,
                    )
                    return [
                        f"rm: cannot remove '{entry.raw_path}': "
                        f"{fs_strerror(exc)}"
                        for entry, exc in failures
                    ] + skipped, (removal_lines(gone, path) if verbose else [])
                if remove_dir:
                    children = await readdir(accessor, path, index)
                    if children:
                        return [
                            f"rm: cannot remove '{label}': Directory not empty"
                        ], []
                    await rmdir(accessor, path)
                    return [], (
                        [f"removed directory '{label}'"] if verbose else []
                    )
                return [f"rm: cannot remove '{label}': Is a directory"], []
            await unlink(accessor, path)
        except FS_ERRORS as exc:
            # A refused removal (a read-only region) is GNU's line for
            # the operand, and rm goes on to the rest.
            label = with_inner(label, inner_suffix(path, exc))
            return [f"rm: cannot remove '{label}': {fs_strerror(exc)}"], []
        return [], [f"removed '{label}'"] if verbose else []

    async def rm(
        accessor: Accessor,
        paths: list[PathSpec],
        texts: list[str],
        opts: CommandOpts,
    ) -> tuple[ByteSource | None, IOResult]:
        fl = FlagView(opts.flags, spec=SPECS["rm"])
        r = fl.as_bool("r") or fl.as_bool("R")
        f = fl.as_bool("f")
        v = fl.as_bool("v")
        d = fl.as_bool("d")
        if not paths:
            return rm_without_operands(f)
        paths = await resolve_glob(accessor, paths, opts.index)
        verbose_parts: list[str] = []
        errors: list[str] = []
        links = opts.ns.links if opts.ns is not None else None
        for p in paths:
            # A link typed with a trailing slash is refused, never
            # followed: the shared helper keeps this identical to the
            # generic builder.
            if is_slashed_link(p, links):
                refusal = await rm_link_refusal(p, links, recursive=r, force=f)
                if refusal is not None:
                    errors.append(refusal)
                continue
            # GNU rm reports the operand and keeps removing the rest.
            failed, entry_lines = await _rm(
                accessor,
                p,
                recursive=r,
                force=f,
                remove_dir=d,
                verbose=v,
                index=opts.index,
                ns=opts.ns,
            )
            errors.extend(failed)
            verbose_parts.extend(entry_lines)
        output = format_optional_records(verbose_parts) if v else None
        stderr = ("\n".join(errors) + "\n").encode() if errors else None
        return output, IOResult(stderr=stderr, exit_code=1 if errors else 0)

    return rm


def make_rm(
    vfs: str, wrap: Callable[[CommandIO], CommandIO]
) -> Callable[..., Any]:
    """Build the no-real-directories rm override for one keyed store.

    Args:
        vfs (str): VFS name the command registers under.
        wrap (Callable): the guards over the mount's table.
    """
    wrapped: Callable[..., Any] = command(
        "rm", vfs=vfs, spec=SPECS["rm"], write=True, path_guarded=True
    )(over_mount_io(_build, wrap))
    return wrapped
