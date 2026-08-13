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
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation)
from mirage.commands.builtin.utils.output import format_optional_records
from mirage.commands.builtin.utils.verbose import removal_lines
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


async def rm(ops: CommandIO, accessor: Accessor, paths: list[PathSpec],
             texts: list[str],
             opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["rm"])
    f = fl.as_bool("f")
    v = fl.as_bool("v")
    d = fl.as_bool("d")
    if not ops.is_mounted(accessor) or not paths:
        raise ValueError("rm: missing operand")
    paths = await ops.resolve_glob(accessor, paths, opts.index)
    recursive = fl.as_bool("r") or fl.as_bool("R")
    verbose_parts: list[str] = []
    errors: list[str] = []
    removed: dict[str, ByteSource] = {}
    for p in paths:
        try:
            s = await ops.stat(accessor, p)
        except FileNotFoundError:
            if f:
                continue
            # GNU rm reports the operand and keeps removing the rest.
            errors.append(f"rm: cannot remove '{p.virtual}': "
                          "No such file or directory")
            continue
        entry_lines: list[str] = []
        if s.type == FileType.DIRECTORY:
            if recursive:
                if ops.rm_r is None:
                    raise NotImplementedError(
                        "rm: recursive remove not supported on this backend")
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
                        "rm: directory remove not supported on this backend")
                if await ops.readdir(accessor, p, index=opts.index):
                    errors.append(f"rm: cannot remove '{p.virtual}': "
                                  "Directory not empty")
                    continue
                await ops.rmdir(accessor, p)
                entry_lines = [f"removed directory '{p.virtual}'"]
            else:
                errors.append(
                    f"rm: cannot remove '{p.virtual}': Is a directory")
                continue
        else:
            await ops.require(Operation.UNLINK)(accessor, p)
            entry_lines = [f"removed '{p.virtual}'"]
        removed[p.mount_path] = b""
        if v:
            verbose_parts.extend(entry_lines)
    output = format_optional_records(verbose_parts) if v else None
    stderr = ("\n".join(errors) + "\n").encode() if errors else None
    return output, IOResult(writes=removed,
                            stderr=stderr,
                            exit_code=1 if errors else 0)


BUILDER = Builder('rm',
                  rm,
                  write=True,
                  requirements=frozenset({Operation.UNLINK}))
