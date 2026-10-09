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
from mirage.commands.builtin.generic_bind.adapter import (
    Operation,
    over_mount_io,
    require_op,
)
from mirage.commands.builtin.generic_bind.builders.mkdir import (
    created_lines,
    created_names,
    make_directory,
)
from mirage.commands.builtin.utils.slash_links import mkdir_link_refusal
from mirage.commands.config import CommandIO, CommandOpts, command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.usage import missing_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _build(io: CommandIO) -> Callable[..., Any]:
    """The mkdir handler over one mount's table.

    Args:
        io (CommandIO): the guarded table of the running mount.
    """
    mkdir_impl = require_op(io, Operation.MKDIR)
    resolve_glob = io.resolve_glob

    async def mkdir(
        accessor: Accessor,
        paths: list[PathSpec],
        texts: list[str],
        opts: CommandOpts,
    ) -> tuple[ByteSource | None, IOResult]:
        fl = FlagView(opts.flags, spec=SPECS["mkdir"])
        parents = fl.as_bool("parents")
        verbose = fl.as_bool("verbose")
        if not paths:
            raise missing_operand_error("mkdir", None)
        paths = await resolve_glob(accessor, paths, opts.index)
        lines: list[str] = []
        errors: list[str] = []
        links = opts.ns.links if opts.ns is not None else None
        for path in paths:
            # A symlink occupying the name is EEXIST; the shared helper
            # keeps this identical to the generic builder's answer.
            taken, refusal = await mkdir_link_refusal(
                path, links, parents=parents
            )
            if taken:
                if refusal is not None:
                    errors.append(refusal)
                continue
            names = (
                await created_names(path, parents, links) if verbose else []
            )
            failed = await make_directory(
                mkdir_impl, accessor, path, parents, links
            )
            if failed is not None:
                errors.append(failed)
                continue
            lines.extend(created_lines(names))
        output = ("\n".join(lines) + "\n").encode() if lines else None
        stderr = ("\n".join(errors) + "\n").encode() if errors else None
        return output, IOResult(stderr=stderr, exit_code=1 if errors else 0)

    return mkdir


def make_mkdir(
    vfs: str, wrap: Callable[[CommandIO], CommandIO]
) -> Callable[..., Any]:
    """Build the implicit-parents mkdir override for one keyed store.

    Args:
        vfs (str): VFS name the command registers under.
        wrap (Callable): the guards over the mount's table.
    """
    wrapped: Callable[..., Any] = command(
        "mkdir", vfs=vfs, spec=SPECS["mkdir"], write=True, path_guarded=True
    )(over_mount_io(_build, wrap))
    return wrapped
