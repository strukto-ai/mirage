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


from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.cp import walk
from mirage.commands.builtin.generic.rm_cmd import (
    remove_tree,
    rm_without_operands,
)
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.builtin.utils.links import (
    dispatch_of,
    links_of,
    mounts_of,
)
from mirage.commands.builtin.utils.operands import mount_points, operands_io
from mirage.commands.builtin.utils.output import (
    format_optional_records,
    format_records,
)
from mirage.commands.builtin.utils.slash_links import (
    is_slashed_link,
    rm_link_refusal,
)
from mirage.commands.builtin.utils.tree import before_full_scan
from mirage.commands.builtin.utils.verbose import removal_lines
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror, inner_suffix, with_inner
from mirage.errors.posix import posix_phrase
from mirage.errors.render import operand_spelling
from mirage.errors.types import FsCondition, WalkDeclinedError
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


async def rm(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    fl = FlagView(ctx.flags, spec=SPECS["rm"])
    f = fl.as_bool("f")
    v = fl.as_bool("v")
    d = fl.as_bool("d")
    if not paths:
        return rm_without_operands(f)
    paths = await files.resolve_glob(paths)
    recursive = fl.as_bool("r") or fl.as_bool("R")
    verbose_parts: list[str] = []
    errors: list[str] = []
    links = links_of(ctx)
    stat = files.stat
    readdir = files.readdir
    for p in paths:
        if is_slashed_link(p, links):
            refusal = await rm_link_refusal(
                p, links, recursive=recursive, force=f
            )
            if refusal is not None:
                errors.append(refusal)
            continue
        try:
            s = await stat(p)
        except FS_ERRORS as exc:
            # ENOTDIR is a component that is a plain file: the operand sits
            # under one, or carried a trailing slash that named one
            # (`rm reg/`). -f ignores it and ENOENT alone, as GNU rm 9.7
            # does; any other failure is reported, -f or not. GNU rm reports
            # the operand and keeps removing the rest.
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
                    # The mount is asked before anything goes, as for
                    # cp -r: a removal cut short would leave a tree that
                    # looks untouched.
                    await before_full_scan(dispatch_of(ctx), p, "rm")
                    # -v names each entry before the tree goes in one
                    # call; a tree it cannot list whole goes entry by
                    # entry, as does one on a mount without rm_r or one
                    # the dispatcher declines for the caller's view.
                    unlisted: list[str] = []
                    listed = (
                        [
                            (entry, kind == FileType.DIRECTORY)
                            for entry, kind in await walk(
                                readdir, stat, p, "rm", unlisted
                            )
                        ]
                        if v
                        else []
                    )
                    declined = bool(unlisted) or not files.answers("rm_r")
                    if not declined:
                        try:
                            await files.rm_r(p)
                        except WalkDeclinedError:
                            declined = True
                    failures: list[tuple[PathSpec, OSError]] = []
                    if declined:
                        listed, failures = await remove_tree(
                            p,
                            readdir=readdir,
                            stat=stat,
                            unlink=files.unlink,
                            rmdir=files.rmdir,
                            mounts=mounts_of(ctx),
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
                            mounts_of(ctx),
                            p.virtual,
                        )
                    )
                    if failures:
                        verbose_parts.extend(entry_lines)
                        continue
                elif d:
                    if await readdir(p):
                        errors.append(
                            f"rm: cannot remove '{p.raw_path}': "
                            f"{posix_phrase(FsCondition.ENOTEMPTY)}"
                        )
                        continue
                    await files.rmdir(p)
                    entry_lines = [f"removed directory '{p.raw_path}'"]
                else:
                    errors.append(
                        f"rm: cannot remove '{p.raw_path}': "
                        f"{posix_phrase(FsCondition.EISDIR)}"
                    )
                    continue
            else:
                await files.unlink(p)
                entry_lines = [f"removed '{p.raw_path}'"]
        except FS_ERRORS as exc:
            # GNU rm names the entry below the operand it could not
            # remove (the guard blames a read-only region by its
            # anchor), and the operand as typed for a refusal that names
            # no path below it (a store's refused key), and keeps
            # removing the rest.
            errors.append(
                "rm: cannot remove "
                f"'{with_inner(p.raw_path, inner_suffix(p, exc))}': "
                f"{fs_strerror(exc)}"
            )
            continue
        if v:
            verbose_parts.extend(entry_lines)
    output = format_optional_records(verbose_parts) if v else None
    return output, operands_io(format_records(errors))


BUILDER = GenericCommand("rm", rm, write=True)
