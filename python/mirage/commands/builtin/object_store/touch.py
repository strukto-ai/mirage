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
    CommandIO,
    Operation,
    over_mount_io,
)
from mirage.commands.config import CommandOpts, command
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.usage import usage_hint
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _build(io: CommandIO) -> Callable[..., Any]:
    """The touch handler over one mount's table.

    Args:
        io (CommandIO): the guarded table of the running mount.
    """
    exists = io.require(Operation.EXISTS)
    write_bytes = io.require(Operation.WRITE)
    resolve_glob = io.resolve_glob

    async def touch(
        accessor: Accessor,
        paths: list[PathSpec],
        texts: list[str],
        opts: CommandOpts,
    ) -> tuple[ByteSource | None, IOResult]:
        if not paths:
            raise UsageError(
                f"touch: missing file operand\n{usage_hint('touch')}", 1
            )
        fl = FlagView(opts.flags, spec=SPECS["touch"])
        paths = await resolve_glob(accessor, paths, opts.index)
        writes: dict[str, ByteSource] = {}
        for p in paths:
            if fl.as_bool("no_create"):
                continue
            if not await exists(accessor, p):
                await write_bytes(accessor, p, b"")
                writes[p.mount_path] = b""
        return None, IOResult(writes=writes)

    return touch


def make_touch(
    vfs: str, wrap: Callable[[CommandIO], CommandIO]
) -> Callable[..., Any]:
    """Build the create-if-missing touch override for one keyed store.

    Args:
        vfs (str): VFS name the command registers under.
        wrap (Callable): the guards over the mount's table.
    """
    wrapped: Callable[..., Any] = command(
        "touch", vfs=vfs, spec=SPECS["touch"], write=True, path_guarded=True
    )(over_mount_io(_build, wrap))
    return wrapped
