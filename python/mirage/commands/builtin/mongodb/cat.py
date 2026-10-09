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

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.commands.builtin.generic.cat import cat_generic
from mirage.commands.builtin.generic_bind.adapter import (
    bound_op,
    mount_io,
    resolve_or_empty,
)
from mirage.commands.config import CommandOpts, command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("cat", vfs="mongodb", spec=SPECS["cat"])
async def cat(
    accessor: MongoDBAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    resolved = await resolve_or_empty(
        mount_io(opts), accessor, paths, opts.index
    )
    return await cat_generic(
        resolved,
        list(texts),
        opts,
        bound_op(mount_io(opts).stat, accessor, opts.index),
        bound_op(mount_io(opts).read_stream, accessor, opts.index),
        local=mount_io(opts).local,
    )
