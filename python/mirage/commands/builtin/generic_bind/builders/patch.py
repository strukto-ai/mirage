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

from functools import partial

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.patch import patch_generic
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    Operation,
    bound_op,
    dir_aware_stat,
    require_op,
)
from mirage.commands.config import CommandIO, CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def patch(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    stat = dir_aware_stat(ops, accessor, opts)
    read = bound_op(ops.read_bytes, accessor, opts.index)

    async def read_file(path: PathSpec) -> bytes:
        # Stat first, as GNU patch does: a directory is refused before it
        # is read, because a store whose read of a collection answers a
        # page (nextcloud) never raises for one.
        await stat(path)
        data: bytes = await read(path)
        return data

    return await patch_generic(
        paths,
        list(texts),
        opts,
        read_file,
        partial(require_op(ops, Operation.WRITE), accessor),
        ops.is_mounted(accessor),
    )


BUILDER = GenericCommand("patch", patch, write=True)
