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

from collections.abc import Callable
from typing import Any

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.adapter import CommandIO, Operation
from mirage.commands.builtin.utils.slash_links import mkdir_link_refusal
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.errors import (FS_ERRORS, error_path, fs_strerror,
                                 operand_spelling)


def make_mkdir(vfs: str, io: CommandIO) -> Callable[..., Any]:
    """Build the implicit-parents mkdir override for one keyed store.

    Args:
        vfs (str): VFS name the command registers under.
        io (CommandIO): the backend's op table; must wire mkdir.
    """
    mkdir_impl = io.require(Operation.MKDIR)
    resolve_glob = io.resolve_glob

    async def mkdir(accessor: Accessor, paths: list[PathSpec],
                    texts: list[str],
                    opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
        fl = FlagView(opts.flags, spec=SPECS["mkdir"])
        parents = fl.as_bool("parents")
        verbose = fl.as_bool("verbose")
        if not paths:
            raise ValueError("mkdir: missing operand")
        paths = await resolve_glob(accessor, paths, opts.index)
        lines: list[str] = []
        errors: list[str] = []
        writes: dict[str, ByteSource] = {}
        links = opts.ns.links if opts.ns is not None else None
        for path in paths:
            # A symlink occupying the name is EEXIST; the shared helper
            # keeps this identical to the generic builder's answer.
            taken, refusal = await mkdir_link_refusal(path,
                                                      links,
                                                      parents=parents)
            if taken:
                if refusal is not None:
                    errors.append(refusal)
                continue
            try:
                await mkdir_impl(accessor, path, parents=parents)
            except FS_ERRORS as exc:
                # GNU reports the operand (or, under -p, the component
                # it tripped on) and still makes the rest, as the
                # generic builder does.
                named = operand_spelling(error_path(exc), path)
                errors.append(f"mkdir: cannot create directory "
                              f"'{named}': {fs_strerror(exc)}")
                continue
            writes[path.mount_path] = b""
            if verbose:
                lines.append(f"mkdir: created directory '{path.virtual}'")
        output = ("\n".join(lines) + "\n").encode() if lines else None
        stderr = ("\n".join(errors) + "\n").encode() if errors else None
        return output, IOResult(writes=writes,
                                stderr=stderr,
                                exit_code=1 if errors else 0)

    wrapped: Callable[..., Any] = command("mkdir",
                                          vfs=vfs,
                                          spec=SPECS["mkdir"],
                                          write=True,
                                          path_guarded=True)(mkdir)
    return wrapped
