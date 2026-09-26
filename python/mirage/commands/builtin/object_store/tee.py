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
from mirage.commands.builtin.generic.tee import tee as generic_tee
from mirage.commands.builtin.generic_bind.adapter import CommandIO, Operation
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def make_tee(vfs: str, io: CommandIO) -> Callable[..., Any]:
    """Build the write-tracking tee override for one keyed store.

    Args:
        vfs (str): VFS name the command registers under.
        io (CommandIO): the backend's op table; must wire write.
    """
    read_stream = io.read_stream
    write_bytes = io.require(Operation.WRITE)
    resolve_glob = io.resolve_glob

    async def tee(accessor: Accessor, paths: list[PathSpec], texts: list[str],
                  opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
        paths = await resolve_glob(accessor, paths,
                                   opts.index) if paths else []
        # The wrapper is wiring only: every flag semantic, the write to
        # each operand and the append fallback live in the generic.
        return await generic_tee(paths,
                                 texts,
                                 read_stream=partial(read_stream,
                                                     accessor,
                                                     index=opts.index),
                                 write_bytes=partial(write_bytes, accessor),
                                 stdin=opts.stdin,
                                 flags=opts.flags)

    wrapped: Callable[..., Any] = command("tee",
                                          vfs=vfs,
                                          spec=SPECS["tee"],
                                          write=True,
                                          path_guarded=True)(tee)
    return wrapped
