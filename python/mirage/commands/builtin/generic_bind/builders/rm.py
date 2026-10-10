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

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.cp import walk
from mirage.commands.builtin.generic.rm_cmd import (
    remove_tree,
    rm_without_operands,
)
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    Operation,
    bound_op,
    require_op,
)
from mirage.commands.builtin.utils.operands import mount_points
from mirage.commands.builtin.utils.output import format_optional_records
from mirage.commands.builtin.utils.slash_links import (
    is_slashed_link,
    rm_link_refusal,
)
from mirage.commands.builtin.utils.verbose import removal_lines
from mirage.commands.config import CommandIO, CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import error_path, fs_strerror
from mirage.errors.render import operand_spelling
from mirage.errors.types import WalkDeclinedError
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


async def rm(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["rm"])
    f = fl.as_bool("f")
    v = fl.as_bool("v")
    d = fl.as_bool("d")
    if not paths:
        return rm_without_operands(f)
    if not ops.is_mounted(accessor):
        raise ValueError("rm: missing operand")
    paths = await ops.resolve_glob(accessor, paths, opts.index)
    recursive = fl.as_bool("r") or fl.as_bool("R")
    verbose_parts: list[str] = []
    errors: list[str] = []
    links = opts.ns.links if opts.ns is not None else None
    for p in paths:
        if is_slashed_link(p, links):
            refusal = await rm_link_refusal(
                p, links, recursive=recursive, force=f
            )
            if refusal is not None:
                errors.append(refusal)
            continue
        try:
            s = await ops.stat(accessor, p, index=opts.index)
        except FS_ERRORS as exc:
            # ENOTDIR is a component that is a plain file: the operand
            # sits under one, or carried a trailing slash that named one
            # (`rm reg/`). -f ignores it and ENOENT alone, as GNU's
            # `ignorable_missing` does; any other failure is reported,
            # -f or not. GNU rm reports the operand and keeps removing
            # the rest.
            if f and isinstance(exc, (FileNotFoundError, NotADirectoryError)):
                continue
            errors.append(
                f"rm: cannot remove '{p.raw_path}': {fs_strerror(exc)}"
            )
            continue
        entry_lines: list[str] = []
        try:
            if s.type == FileType.DIRECTORY:
                if recursive:
                    readdir = functools.partial(
                        ops.readdir, accessor, index=opts.index
                    )
                    stat = bound_op(ops.stat, accessor, opts.index)
                    # -v names each entry before the tree goes in one
                    # call; a tree it cannot list whole goes entry by
                    # entry, as does one the dispatcher declines for
                    # the caller's view.
                    unlisted: list[str] = []
                    listed = (
                        await walk(readdir, stat, p, "rm", unlisted)
                        if v
                        else []
                    )
                    declined = bool(unlisted)
                    if not declined:
                        try:
                            await require_op(ops, Operation.RM_R)(accessor, p)
                        except WalkDeclinedError:
                            declined = True
                    failures: list[tuple[PathSpec, OSError]] = []
                    if declined:
                        listed, failures = await remove_tree(
                            p,
                            readdir=readdir,
                            stat=stat,
                            unlink=functools.partial(
                                require_op(ops, Operation.UNLINK), accessor
                            ),
                            rmdir=functools.partial(
                                require_op(ops, Operation.RMDIR), accessor
                            ),
                            ns=opts.ns,
                            force=f,
                        )
                        errors.extend(
                            f"rm: cannot remove '{entry.raw_path}': "
                            f"{fs_strerror(exc)}"
                            for entry, exc in failures
                        )
                    entry_lines = removal_lines(listed, p) if v else []
                    # A removal never crosses into a mount below, so it
                    # says so as GNU's --one-file-system does.
                    errors.extend(
                        f"rm: skipping '{operand_spelling(root, p)}', "
                        "since it's on a different device"
                        for root in mount_points(
                            opts.ns.mounts if opts.ns is not None else None,
                            p.virtual,
                        )
                    )
                    if failures:
                        verbose_parts.extend(entry_lines)
                        continue
                elif d:
                    if await ops.readdir(accessor, p, index=opts.index):
                        errors.append(
                            f"rm: cannot remove '{p.raw_path}': "
                            "Directory not empty"
                        )
                        continue
                    await require_op(ops, Operation.RMDIR)(
                        accessor, p, index=opts.index
                    )
                    entry_lines = [f"removed directory '{p.raw_path}'"]
                else:
                    errors.append(
                        f"rm: cannot remove '{p.raw_path}': Is a directory"
                    )
                    continue
            else:
                await require_op(ops, Operation.UNLINK)(accessor, p)
                entry_lines = [f"removed '{p.raw_path}'"]
        except FS_ERRORS as exc:
            # GNU rm names the entry it could not remove (the guard
            # blames a read-only region below the operand by its
            # anchor) and keeps removing the rest.
            errors.append(
                "rm: cannot remove "
                f"'{operand_spelling(error_path(exc), p)}': "
                f"{fs_strerror(exc)}"
            )
            continue
        if v:
            verbose_parts.extend(entry_lines)
    output = format_optional_records(verbose_parts) if v else None
    stderr = ("\n".join(errors) + "\n").encode() if errors else None
    return output, IOResult(stderr=stderr, exit_code=1 if errors else 0)


BUILDER = GenericCommand("rm", rm, write=True)
