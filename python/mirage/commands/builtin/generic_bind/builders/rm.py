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
from mirage.commands.builtin.generic.rm_cmd import rm_without_operands
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation)
from mirage.commands.builtin.utils.output import format_optional_records
from mirage.commands.builtin.utils.slash_links import (is_slashed_link,
                                                       rm_link_refusal)
from mirage.commands.builtin.utils.verbose import removal_lines
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec
from mirage.utils.errors import (FS_ERRORS, error_path, fs_strerror,
                                 operand_spelling)


async def rm(ops: CommandIO, accessor: Accessor, paths: list[PathSpec],
             texts: list[str],
             opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
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
    removed: dict[str, ByteSource] = {}
    links = opts.ns.links if opts.ns is not None else None
    for p in paths:
        if is_slashed_link(p, links):
            refusal = await rm_link_refusal(p,
                                            links,
                                            recursive=recursive,
                                            force=f)
            if refusal is not None:
                errors.append(refusal)
            continue
        try:
            s = await ops.stat(accessor, p)
        except NotADirectoryError:
            # A component is a plain file: the operand sits under one, or
            # carried a trailing slash that named one (`rm reg/`). -f
            # ignores it like ENOENT, as GNU's `ignorable_missing` does.
            if f:
                continue
            errors.append(f"rm: cannot remove '{p.raw_path}': "
                          "Not a directory")
            continue
        except FileNotFoundError:
            if f:
                continue
            # GNU rm reports the operand and keeps removing the rest.
            errors.append(f"rm: cannot remove '{p.raw_path}': "
                          "No such file or directory")
            continue
        entry_lines: list[str] = []
        try:
            if s.type == FileType.DIRECTORY:
                if recursive:
                    if ops.rm_r is None:
                        raise NotImplementedError(
                            "rm: recursive remove not supported on this "
                            "backend")
                    if v:
                        readdir = functools.partial(ops.readdir,
                                                    accessor,
                                                    index=opts.index)
                        entry_lines = removal_lines(await walk(
                            readdir, functools.partial(ops.stat, accessor), p))
                    await ops.rm_r(accessor, p)
                elif d:
                    if ops.rmdir is None:
                        raise NotImplementedError(
                            "rm: directory remove not supported on this "
                            "backend")
                    if await ops.readdir(accessor, p, index=opts.index):
                        errors.append(f"rm: cannot remove '{p.raw_path}': "
                                      "Directory not empty")
                        continue
                    await ops.rmdir(accessor, p, index=opts.index)
                    entry_lines = [f"removed directory '{p.virtual}'"]
                else:
                    errors.append(
                        f"rm: cannot remove '{p.raw_path}': Is a directory")
                    continue
            else:
                await ops.require(Operation.UNLINK)(accessor, p)
                entry_lines = [f"removed '{p.virtual}'"]
        except FS_ERRORS as exc:
            # GNU rm names the entry it could not remove (the guard
            # blames a read-only region below the operand by its
            # anchor) and keeps removing the rest.
            errors.append("rm: cannot remove "
                          f"'{operand_spelling(error_path(exc), p)}': "
                          f"{fs_strerror(exc)}")
            continue
        removed[p.mount_path] = b""
        if v:
            verbose_parts.extend(entry_lines)
    output = format_optional_records(verbose_parts) if v else None
    stderr = ("\n".join(errors) + "\n").encode() if errors else None
    return output, IOResult(writes=removed,
                            stderr=stderr,
                            exit_code=1 if errors else 0)


BUILDER = Builder('rm', rm, write=True)
