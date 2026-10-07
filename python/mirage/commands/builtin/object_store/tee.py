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
from functools import partial
from typing import Any

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.tee import tee_generic as generic_tee
from mirage.commands.builtin.generic_bind.adapter import (
    CommandIO,
    Operation,
    over_mount_io,
)
from mirage.commands.config import CommandOpts, command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _build(io: CommandIO) -> Callable[..., Any]:
    """The tee handler over one mount's table.

    Args:
        io (CommandIO): the guarded table of the running mount.
    """
    read_stream = io.read_stream
    write_bytes = io.require(Operation.WRITE)
    resolve_glob = io.resolve_glob

    async def tee(
        accessor: Accessor,
        paths: list[PathSpec],
        texts: list[str],
        opts: CommandOpts,
    ) -> tuple[ByteSource | None, IOResult]:
        paths = (
            await resolve_glob(accessor, paths, opts.index) if paths else []
        )
        # The wrapper is wiring only: every flag semantic, the write to
        # each operand and the append fallback live in the generic.
        return await generic_tee(
            paths,
            texts,
            read_stream=partial(read_stream, accessor, index=opts.index),
            write_bytes=partial(write_bytes, accessor),
            stdin=opts.stdin,
            flags=opts.flags,
            stat=partial(io.stat, accessor, index=opts.index),
        )

    return tee


def make_tee(
    vfs: str, wrap: Callable[[CommandIO], CommandIO]
) -> Callable[..., Any]:
    """Build the write-tracking tee override for one keyed store.

    Args:
        vfs (str): VFS name the command registers under.
        wrap (Callable): the guards over the mount's table.
    """
    wrapped: Callable[..., Any] = command(
        "tee", vfs=vfs, spec=SPECS["tee"], write=True, path_guarded=True
    )(over_mount_io(_build, wrap))
    return wrapped
